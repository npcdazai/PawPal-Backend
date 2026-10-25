import { createHmac } from 'node:crypto';
import type { VerificationConfig } from '../config.ts';
import { distanceKm } from '../domain/pricing.ts';
import { requiredTrustTier, type Booking } from '../domain/types.ts';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../http/errors.ts';
import { logger } from '../log/logger.ts';
import type { Push } from '../push/push.ts';
import { cosineSimilarity, selfieProblems, type FaceAnalysis, type FaceEngine } from '../services/biometricFaceService.ts';
import { normalizeImage, wipe, type NormalizedImage } from '../services/imagePreprocess.ts';
import type { IdAndSelfieAudit, VlmKycService } from '../services/vlmKycService.ts';
import type { Store } from '../store/store.ts';
import type { ShiftHandshake } from './handshake.ts';
import { gradeQuiz, publicQuiz } from './safetyQuiz.ts';
import type { BgvStatus, VerificationRepository, VerificationRow } from './verificationRepository.ts';

/** ₹10,000 vet & accident cover for the dog, active from the doorstep check until drop-off. */
export const WALK_INSURANCE_COVER_INR = 10_000;

const TIER_FOR_STATUS: Record<BgvStatus, number> = {
  LOCKED: 0,
  PENDING_COURT_CHECK: 0,
  PROVISIONAL_SOCIETY_PASS: 1,
  VERIFIED: 2,
  REJECTED: 0,
};

export type NextGate = 'gate1' | 'gate2' | 'gate3' | 'awaiting_background_check' | 'cleared' | 'rejected';

/** Where the partner app's onboarding state machine should go next. */
function nextGate(row: VerificationRow | null): NextGate {
  if (!row?.gate1Passed) return 'gate1';
  if (!row.gate2Passed) return 'gate2';
  if (row.bgvStatus === 'REJECTED') return 'rejected';
  if (row.bgvStatus === 'LOCKED') return 'gate3';
  if (row.bgvStatus === 'PENDING_COURT_CHECK') return 'awaiting_background_check';
  return 'cleared';
}

export const statusView = (row: VerificationRow | null) => ({
  nextGate: nextGate(row),
  gate1: { passed: row?.gate1Passed ?? false, score: row?.gate1Score ?? 0, attempts: row?.gate1Attempts ?? 0 },
  gate2: {
    passed: row?.gate2Passed ?? false,
    attempts: row?.gate2Attempts ?? 0,
    similarity: row?.similarity ?? null,
    idType: row?.idType ?? null,
    extractedName: row?.extractedName ?? null,
  },
  gate3: { bgvStatus: row?.bgvStatus ?? 'LOCKED', trustTier: row?.trustTier ?? 0, societyGatePass: Boolean(row?.societyGatePass) },
});

/** Masked ("•••• 9204"), plus the keyed hash that stops one ID being used by two accounts. */
function idFingerprint(
  pepper: string,
  doc: IdAndSelfieAudit['idDocument'],
  countryCode: string
): { hash: string; masked: string } | null {
  const printed = (doc.idNumber ?? '').toUpperCase();
  const masking = /[X*•]{4,}/.test(printed.replace(/\s/g, ''));
  const digitsAndLetters = printed.replace(/[^A-Z0-9]/g, '');
  const last4 = digitsAndLetters.replace(/X+/g, '').slice(-4);
  const hmac = (value: string) => createHmac('sha256', pepper).update(value).digest('hex');
  if (!masking && digitsAndLetters.length >= 6) {
    return { hash: hmac(`${countryCode}|${doc.idType}|${digitsAndLetters}`), masked: `•••• ${digitsAndLetters.slice(-4)}` };
  }
  // A masked Aadhaar shows only the last 4 digits: fingerprint them with the name and date of birth.
  const name = (doc.fullName ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  if (last4.length === 4 && name && doc.dob) {
    return { hash: hmac(`${countryCode}|${doc.idType}|masked|${last4}|${name}|${doc.dob}`), masked: `•••• ${last4}` };
  }
  return null;
}

/** Codes the app maps to retake instructions; deliberately vague about other accounts. */
export type IdCheckReason =
  | 'id_not_government_id'
  | 'id_not_physical'
  | 'id_tampered'
  | 'id_unreadable'
  | 'no_face_on_id'
  | 'selfie_not_live'
  | `selfie_${ReturnType<typeof selfieProblems>[number]}`
  | 'face_mismatch'
  | 'duplicate_identity';

export interface VerificationDeps {
  repo: VerificationRepository;
  vlm: VlmKycService;
  faces: FaceEngine;
  store: Store;
  push: Push;
  handshake: ShiftHandshake;
  config: VerificationConfig;
  now: () => number;
}

const round = (value: number | null) => (value === null ? null : Math.round(value * 1000) / 1000);

/** Outcomes only: names, birth dates and ID numbers never go to the log. */
const log = logger('kyc');

export function createPartnerVerification({ repo, vlm, faces, store, push, handshake, config, now }: VerificationDeps) {
  /** Mirrors the outcome onto the partner profile that dispatch reads (only those fields, so ratings and position stay). */
  async function syncPartner(partnerId: string, tier: number) {
    const partner = await store.get('partners', partnerId);
    if (!partner) return;
    await store.update('partners', partnerId, {
      trustTier: tier,
      approved: tier >= 1,
      online: tier >= 1 ? partner.online : false,
      updatedAt: now(),
    });
  }

  async function requireRow(partnerId: string) {
    const row = await repo.get(partnerId);
    if (!row?.gate1Passed) throw conflict('gate1_required', 'Pass the dog-safety quiz first.');
    return row;
  }

  return {
    async status(partnerId: string) {
      return statusView(await repo.get(partnerId));
    },

    /** The society gate pass number the walker gave at gate 3, if any (pet parents see its last 4 characters). */
    async gatePass(partnerId: string): Promise<string | null> {
      return (await repo.get(partnerId))?.societyGatePass ?? null;
    },

    quiz: publicQuiz,

    async submitQuiz(partnerId: string, answers: Record<string, string>) {
      const result = gradeQuiz(answers);
      const row = await repo.recordQuiz(partnerId, result.score, result.passed);
      log.info(result.passed ? 'Gate 1 passed: safety quiz' : 'Gate 1 failed: safety quiz', {
        walker: partnerId,
        score: result.score,
      });
      return { ...result, nextGate: nextGate(row) };
    },

    /** Gate 2: government ID + live selfie → OCR, anti-spoof audit, 1:1 match, 1:N duplicate search. */
    async verifyIdAndSelfie(
      partnerId: string,
      input: { idImage: Buffer; selfieImage: Buffer; countryCode: string; consent: boolean }
    ) {
      let idImage: NormalizedImage | null = null;
      let selfieImage: NormalizedImage | null = null;
      try {
        if (!input.consent) throw badRequest('consent_required', 'Agree to the face-match consent to continue.');
        const row = await requireRow(partnerId);
        if (row.gate2Passed) throw conflict('already_verified', 'Your ID is already verified.');
        const outOfAttempts = () =>
          new HttpError(429, 'too_many_attempts', 'Too many ID attempts. Contact partner support to continue.');
        if (row.gate2Attempts >= config.maxIdAttempts) throw outOfAttempts();

        idImage = await normalizeImage(input.idImage, 'The ID photo');
        selfieImage = await normalizeImage(input.selfieImage, 'The selfie');
        const [audit, idFace, selfieFace] = await Promise.all([
          vlm.auditIdAndSelfie(idImage.jpeg, selfieImage.jpeg),
          faces.analyze(idImage),
          faces.analyze(selfieImage),
        ]);
        // Counted only once there's a verdict, so an outage of the model server doesn't burn attempts.
        const attempt = await repo.claimIdAttempt(partnerId, config.maxIdAttempts);
        if (attempt === null) throw outOfAttempts();

        const reasons: IdCheckReason[] = [];
        const doc = audit.idDocument;
        if (!doc.isGovernmentId) reasons.push('id_not_government_id');
        if (!doc.isPhysicalDocument) reasons.push('id_not_physical');
        if (!doc.isUnaltered) reasons.push('id_tampered');
        if (!audit.selfie.isLiveCapture) reasons.push('selfie_not_live');
        const spoofCheckPassed = reasons.length === 0;

        const countryCode = (doc.countryCode ?? input.countryCode).toUpperCase();
        const fingerprint = idFingerprint(config.idHashPepper, doc, countryCode);
        if (!fingerprint || !doc.fullName) reasons.push('id_unreadable');
        if (!idFace.embedding) reasons.push('no_face_on_id');
        for (const problem of selfieProblems(selfieFace, config.face)) reasons.push(`selfie_${problem}`);

        const similarity = idFace.embedding && selfieFace.embedding ? cosineSimilarity(idFace.embedding, selfieFace.embedding) : null;
        if (similarity !== null && similarity < config.face.enrollThreshold) reasons.push('face_mismatch');

        // 1:N: the same ID or the same face on another account (including banned ones).
        const duplicates = {
          idOwner: fingerprint ? await repo.idHashOwner(fingerprint.hash) : null,
          faces: selfieFace.embedding
            ? await repo.similarFaces(partnerId, selfieFace.embedding, config.face.duplicateThreshold)
            : [],
        };
        const idTaken = duplicates.idOwner !== null && duplicates.idOwner !== partnerId;
        if (idTaken || duplicates.faces.length > 0) reasons.push('duplicate_identity');

        let verified = reasons.length === 0;
        const record = {
          countryCode,
          idType: doc.idType,
          idNumberHash: verified ? fingerprint!.hash : null,
          extractedName: doc.fullName,
          extractedDob: doc.dob,
          spoofCheckPassed,
          embedding: verified ? selfieFace.embedding : null,
          similarity,
          passed: verified,
          audit: {
            at: new Date(now()).toISOString(),
            attempt,
            model: config.vlm.model,
            // The raw ID number never leaves this function.
            idDocument: { ...doc, idNumber: fingerprint?.masked ?? null },
            selfie: audit.selfie,
            imageWarnings: { id: idImage.warnings, selfie: selfieImage.warnings },
            face: { id: faceSummary(idFace), selfie: faceSummary(selfieFace), similarity: round(similarity) },
            duplicates: { idTaken, faces: duplicates.faces.map((face) => ({ ...face, similarity: round(face.similarity) })) },
            reasons,
          },
        };
        if (!(await repo.saveIdCheck(partnerId, record))) {
          // Another account claimed this ID between our check and the write.
          verified = false;
          reasons.push('duplicate_identity');
          await repo.saveIdCheck(partnerId, { ...record, idNumberHash: null, embedding: null, passed: false });
        }

        const outcome = {
          walker: partnerId,
          attempt: `${attempt}/${config.maxIdAttempts}`,
          idType: doc.idType,
          country: countryCode,
          similarity: round(similarity),
        };
        if (verified) log.info('Gate 2 passed: ID and selfie verified', outcome);
        else log.warn('Gate 2 failed: ID and selfie', { ...outcome, reasons: reasons.join(', ') });

        return {
          verified,
          badge: verified ? ('ID_VERIFIED' as const) : null,
          similarityScore: round(similarity),
          threshold: config.face.enrollThreshold,
          reasons,
          extracted: {
            fullName: doc.fullName,
            dob: doc.dob,
            idType: doc.idType,
            idNumberMasked: fingerprint?.masked ?? null,
            countryCode,
          },
          attemptsLeft: Math.max(0, config.maxIdAttempts - attempt),
          nextGate: verified ? ('gate3' as const) : ('gate2' as const),
        };
      } finally {
        // Zero raw-ID retention: the upload buffers and decoded pixels are overwritten, never written to disk.
        wipe(input.idImage, input.selfieImage, idImage?.jpeg, idImage?.rgb, selfieImage?.jpeg, selfieImage?.rgb);
      }
    },

    /** Gate 3: consent to screening; a society gate pass gives a provisional tier-1 clearance meanwhile. */
    async startBackgroundCheck(partnerId: string, input: { societyGatePassNumber: string | null; consent: boolean }) {
      if (!input.consent) throw badRequest('consent_required', 'Agree to the background check to continue.');
      const row = await requireRow(partnerId);
      if (!row.gate2Passed) throw conflict('gate2_required', 'Verify your ID and selfie first.');
      if (row.bgvStatus === 'REJECTED') throw forbidden('Your application wasn’t approved. Contact partner support.');
      if (row.bgvStatus === 'VERIFIED') return { ...statusView(row).gate3, nextGate: nextGate(row), jobId: null };

      const status: BgvStatus = input.societyGatePassNumber ? 'PROVISIONAL_SOCIETY_PASS' : 'PENDING_COURT_CHECK';
      const updated = (await repo.setBackgroundCheck(partnerId, input.societyGatePassNumber, status, TIER_FOR_STATUS[status]))!;
      const provider = row.countryCode === 'IN' ? config.bgvProviderIndia : config.bgvProviderGlobal;
      const jobId = await repo.createJob(partnerId, provider, row.countryCode);
      await syncPartner(partnerId, updated.trustTier);
      log.info('Gate 3 started: background check', { walker: partnerId, status, provider, trustTier: updated.trustTier });
      return { ...statusView(updated).gate3, nextGate: nextGate(updated), jobId, provider };
    },

    /** The screening result, from the vendor relay or ops tooling (signed webhook). */
    async resolveBackgroundCheck(jobId: string, outcome: 'clear' | 'rejected' | 'failed', reference: string | null, details: unknown) {
      const jobStatus = outcome === 'clear' ? 'CLEAR' : outcome === 'rejected' ? 'REJECTED' : 'FAILED';
      const partnerId = await repo.closeJob(jobId, jobStatus, reference, details);
      if (!partnerId) throw notFound('Open background-check job');
      if (outcome === 'failed') {
        log.warn('Gate 3: background check could not be completed', { walker: partnerId, job: jobId });
        return { partnerId, bgvStatus: null };
      }
      const status: BgvStatus = outcome === 'clear' ? 'VERIFIED' : 'REJECTED';
      log.info(outcome === 'clear' ? 'Gate 3 passed: background check clear' : 'Gate 3 failed: background check rejected', {
        walker: partnerId,
        job: jobId,
      });
      const row = await repo.setBgvStatus(partnerId, status, TIER_FOR_STATUS[status]);
      await syncPartner(partnerId, TIER_FOR_STATUS[status]);
      await push.toUser(partnerId, 'partner', {
        title: outcome === 'clear' ? 'Background check cleared ✅' : 'Background check update',
        body: outcome === 'clear' ? 'You can now walk every dog on Pawsome.' : 'Your application wasn’t approved. Open the app for details.',
        data: { type: 'verification', status },
      });
      return { partnerId, bgvStatus: row?.bgvStatus ?? status };
    },

    /** Gate 4: doorstep selfie before the pickup OTP: geofence, liveness, and a match with the enrolled face. */
    async shiftUnlock(partnerId: string, input: { image: Buffer; bookingId: string; lat: number; lng: number }) {
      let image: NormalizedImage | null = null;
      try {
        const row = await repo.get(partnerId);
        if (!row?.gate2Passed || row.trustTier < 1) throw forbidden('Finish verification before taking walks.');
        const booking = await store.get('bookings', input.bookingId);
        if (!booking || booking.partnerId !== partnerId) throw notFound('Walk');
        if (booking.status !== 'assigned') throw conflict('wrong_status', `This walk is ${booking.status}.`);
        if (row.trustTier < requiredTrustTier(booking.dog.temperament)) {
          throw forbidden('This dog needs a fully background-checked walker.');
        }

        const distanceM = distanceKm(booking.pickup, { lat: input.lat, lng: input.lng }) * 1000;
        const recordAttendance = (unlocked: boolean, similarity: number | null, failureReason: string | null) =>
          repo.logAttendance({
            partnerId,
            bookingId: booking.id,
            similarity,
            lat: input.lat,
            lng: input.lng,
            distanceM,
            unlocked,
            failureReason,
          });
        if (distanceM > config.geofenceMeters) {
          await recordAttendance(false, null, 'outside_geofence');
          log.warn('Gate 4 failed: doorstep selfie', {
            walker: partnerId,
            booking: booking.id,
            reasons: 'outside_geofence',
            meters: Math.round(distanceM),
          });
          return { unlocked: false, reasons: ['outside_geofence'], distanceMeters: Math.round(distanceM), similarity: null };
        }

        image = await normalizeImage(input.image, 'The selfie');
        const [face, spoof] = await Promise.all([
          faces.analyze(image),
          config.vlm.shiftCheck ? vlm.checkLiveSelfie(image.jpeg) : Promise.resolve(null),
        ]);
        const reasons: string[] = selfieProblems(face, config.face).map((problem) => `selfie_${problem}`);
        if (spoof && !spoof.isLiveCapture) reasons.push('selfie_not_live');

        const enrolled = await repo.faceEmbedding(partnerId);
        if (!enrolled) throw conflict('gate2_required', 'Your enrolled face is missing; verify your ID again.');
        const similarity = face.embedding ? cosineSimilarity(enrolled, face.embedding) : null;
        if (similarity !== null && similarity < config.face.shiftThreshold) reasons.push('face_mismatch');

        if (reasons.length > 0) {
          await recordAttendance(false, similarity, reasons[0]!);
          log.warn('Gate 4 failed: doorstep selfie', {
            walker: partnerId,
            booking: booking.id,
            reasons: reasons.join(', '),
            similarity: round(similarity),
          });
          return { unlocked: false, reasons, distanceMeters: Math.round(distanceM), similarity: round(similarity) };
        }

        const at = now();
        const insurance = { active: true, coverInr: WALK_INSURANCE_COVER_INR, activatedAt: at };
        const updated = await store.transaction(async (tx) => {
          const current = await tx.get('bookings', booking.id);
          if (!current || current.status !== 'assigned' || current.partnerId !== partnerId) return null;
          const next: Booking = { ...current, shiftVerifiedAt: at, insurance, updatedAt: at };
          tx.set('bookings', booking.id, next);
          return next;
        });
        if (!updated) throw conflict('wrong_status', 'This walk changed while you were checking in.');
        await recordAttendance(true, similarity, null);
        log.info('Gate 4 passed: doorstep selfie; walk insurance on', {
          walker: partnerId,
          booking: booking.id,
          similarity: round(similarity),
          meters: Math.round(distanceM),
        });
        const { token, expiresAt } = await handshake.issue(partnerId, booking.id);
        await push.toUser(booking.customerId, 'customer', {
          title: 'Your walker is at the door ✅',
          body: `Identity confirmed. Share your pickup OTP to start ${booking.dog.name}’s walk.`,
          data: { type: 'booking', bookingId: booking.id },
        });
        return {
          unlocked: true,
          reasons: [],
          distanceMeters: Math.round(distanceM),
          similarity: round(similarity),
          handshakeToken: token,
          expiresAt,
          insurance,
        };
      } finally {
        wipe(input.image, image?.jpeg, image?.rgb);
      }
    },

    /** Right to erasure: drops the face template and ID hash; the partner must re-verify to work. */
    async eraseBiometrics(partnerId: string) {
      const row = await repo.eraseBiometrics(partnerId);
      if (!row) throw conflict('erasure_blocked', 'Nothing to erase, or the record is held for a rejected application.');
      await syncPartner(partnerId, 0);
      log.info('Biometrics erased', { walker: partnerId });
      return statusView(row);
    },
  };
}

function faceSummary(face: FaceAnalysis) {
  return {
    faces: face.faceCount,
    sizePx: face.faceSizePx,
    pose: face.pose && {
      yaw: Math.round(face.pose.yaw),
      pitch: Math.round(face.pose.pitch),
      roll: Math.round(face.pose.roll),
    },
    eyesClosed: face.eyesClosed,
    antispoof: round(face.antispoof),
    liveness: round(face.liveness),
  };
}

export type PartnerVerification = ReturnType<typeof createPartnerVerification>;
