import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import sharp from 'sharp';
import { createApp } from '../src/app.ts';
import { createPhoneVerifier } from '../src/auth/phoneVerification.ts';
import { createSessions } from '../src/auth/session.ts';
import { loadConfig } from '../src/config.ts';
import { migrate, type Db } from '../src/db/postgres.ts';
import { createDispatcher } from '../src/domain/dispatch.ts';
import { createSubscriptions } from '../src/domain/subscriptions.ts';
import { createWalks } from '../src/domain/walks.ts';
import { createLogPush } from '../src/push/push.ts';
import type { FaceAnalysis, FaceEngine } from '../src/services/biometricFaceService.ts';
import type { NormalizedImage } from '../src/services/imagePreprocess.ts';
import type { IdAndSelfieAudit, VlmKycService } from '../src/services/vlmKycService.ts';
import { createMemoryStore } from '../src/store/memoryStore.ts';
import { createShiftHandshake } from '../src/verification/handshake.ts';
import { createPartnerVerification } from '../src/verification/partnerVerificationService.ts';
import { SAFETY_QUIZ } from '../src/verification/safetyQuiz.ts';
import { createVerificationRepository } from '../src/verification/verificationRepository.ts';

// ─── Test doubles ───────────────────────────────────────────────────────────

/** Deterministic pseudo-random numbers (mulberry32), so embeddings are stable between runs. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
}
const person = (seed: number) => Array.from({ length: 1024 }, random(seed));
/** The same face photographed again: cosine ≈ 0.96 to `base`. */
const samePerson = (base: number[], seed: number) => {
  const noise = random(seed);
  return base.map((value) => value + 0.3 * noise());
};

const ALEX = person(1);
const BLAKE = person(2);

/** Each test image is a solid colour; the fake face engine answers by colour. */
const FACES: Record<string, Partial<FaceAnalysis>> = {
  'ff0000': { embedding: samePerson(ALEX, 10), faceSizePx: 70 }, // Alex's ID card
  '00ff00': { embedding: samePerson(ALEX, 11) }, // Alex's live selfie
  '00ffff': { embedding: samePerson(ALEX, 12) }, // Alex at a doorstep
  '0000ff': { embedding: BLAKE }, // Blake's selfie
  'ffff00': { embedding: samePerson(BLAKE, 13), faceSizePx: 70 }, // Blake's ID card
  '808080': { faceCount: 0, embedding: null }, // no face at all
};

const fakeFaces: FaceEngine = {
  async analyze(image: NormalizedImage) {
    const key = [...image.rgb.subarray(0, 3)].map((channel) => (channel > 200 ? 'ff' : channel > 100 ? '80' : '00')).join('');
    const face = FACES[key] ?? FACES['808080']!;
    return {
      faceCount: 1,
      embedding: null,
      faceSizePx: 240,
      pose: { yaw: 3, pitch: -2, roll: 1 },
      eyesClosed: false,
      antispoof: 0.94,
      liveness: 0.91,
      ...face,
    };
  },
  backend: async () => 'fake',
};

const genuineAudit = (idNumber: string, fullName = 'Alex Rivera'): IdAndSelfieAudit => ({
  idDocument: {
    isGovernmentId: true,
    isPhysicalDocument: true,
    isUnaltered: true,
    presentationAttackSignals: [],
    tamperSignals: [],
    idType: 'AADHAAR',
    countryCode: 'IN',
    fullName,
    dob: '1994-03-18',
    idNumber,
  },
  selfie: { isLiveCapture: true, singlePerson: true, presentationAttackSignals: [] },
});

let nextAudit: IdAndSelfieAudit = genuineAudit('1234 5678 9012');
const fakeVlm: VlmKycService = {
  auditIdAndSelfie: async () => structuredClone(nextAudit),
  checkLiveSelfie: async () => ({ isLiveCapture: true, singlePerson: true, presentationAttackSignals: [] }),
};

const jpeg = (hex: string) =>
  sharp({ create: { width: 640, height: 480, channels: 3, background: `#${hex}` } })
    .jpeg()
    .toBuffer();

// ─── App under test ─────────────────────────────────────────────────────────

const config = loadConfig({
  NODE_ENV: 'test',
  SESSION_SECRET: 'v'.repeat(40),
  DATABASE_URL: 'pglite://memory',
  BGV_WEBHOOK_SECRET: 'w'.repeat(40),
});
const settings = config.verification!;
const pg = await PGlite.create({ extensions: { vector } });
const db: Db & { exec(sql: string): Promise<unknown> } = {
  query: async <R,>(text: string, params?: unknown[]) => ({ rows: (await pg.query<R>(text, params)).rows }),
  exec: (sql) => pg.exec(sql),
};
await migrate(db);

const store = createMemoryStore();
const push = createLogPush({ quiet: true });
const now = () => Date.now();
const dispatcher = createDispatcher({ store, push, config: config.dispatch, now });
const handshake = createShiftHandshake(config.sessionSecret);
const verification = createPartnerVerification({
  repo: createVerificationRepository(db),
  vlm: fakeVlm,
  faces: fakeFaces,
  store,
  push,
  handshake,
  config: settings,
  now,
});
const app = createApp({
  config,
  store,
  push,
  sessions: createSessions(config.sessionSecret, 1),
  verifyPhone: createPhoneVerifier({ firebaseApp: null, devLogin: true }),
  dispatcher,
  walks: createWalks({ store, push, dispatcher, now, shiftHandshake: handshake }),
  maps: null,
  verification,
  payments: null,
  subscriptions: createSubscriptions({ store, now }),
  now,
});

let base = '';
const server = app.listen(0);
before(() => {
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.close();
  await pg.close();
});

const V = '/api/v1/partner-verification';

async function api(method: string, path: string, options: { token?: string; body?: unknown; form?: FormData; headers?: Record<string, string> } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    body: options.form ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function login(phone: string, app: 'customer' | 'partner', name = 'Test') {
  const { body } = await api('POST', '/auth/phone', { body: { token: `dev:${phone}`, app, name } });
  return body as { sessionToken: string; user: { id: string } };
}

const correctAnswers = Object.fromEntries(SAFETY_QUIZ.map((question) => [question.id, question.answer]));

async function idForm(idHex: string, selfieHex: string, consent = true) {
  const form = new FormData();
  form.set('countryCode', 'IN');
  form.set('biometricConsent', String(consent));
  form.set('idDocumentImage', new Blob([await jpeg(idHex)], { type: 'image/jpeg' }), 'id.jpg');
  form.set('liveSelfieImage', new Blob([await jpeg(selfieHex)], { type: 'image/jpeg' }), 'selfie.jpg');
  return form;
}

function signed(body: unknown, secret = settings.bgvWebhookSecret) {
  const raw = JSON.stringify(body);
  const timestamp = String(Date.now());
  const signature = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
  return { raw, headers: { 'content-type': 'application/json', 'x-pawpal-timestamp': timestamp, 'x-pawpal-signature': `sha256=${signature}` } };
}

// Hiranandani Gardens pickup, and a doorstep 40 m away vs a café 600 m away.
const PICKUP = { lat: 19.1176, lng: 72.906, address: 'Tower B, Hiranandani Gardens' };
const DOORSTEP = { lat: 19.11795, lng: 72.906 };
const CAFE = { lat: 19.1230, lng: 72.906 };

describe('Partner verification', () => {
  let alex: { sessionToken: string; user: { id: string } };

  test('gate 1: the quiz hides its answers, needs 4 of 5, and gates the ID check', async () => {
    alex = await login('+919811100001', 'partner', 'Alex Rivera');

    const early = await api('POST', `${V}/gate2-verify-id-and-selfie`, { token: alex.sessionToken, form: await idForm('ff0000', '00ff00') });
    assert.equal(early.status, 409);
    assert.equal(early.body.error.code, 'gate1_required');

    const quiz = await api('GET', `${V}/gate1-safety-quiz`, { token: alex.sessionToken });
    assert.equal(quiz.body.questions.length, 5);
    assert.ok(!JSON.stringify(quiz.body).includes('"answer"'));

    const ids = SAFETY_QUIZ.map((question) => question.id);
    const threeRight = { ...correctAnswers, [ids[0]!]: 'z', [ids[1]!]: 'z' };
    const failed = await api('POST', `${V}/gate1-safety-quiz`, { token: alex.sessionToken, body: { answers: threeRight } });
    assert.deepEqual([failed.body.score, failed.body.passed, failed.body.nextGate], [3, false, 'gate1']);
    assert.ok(failed.body.review[0].explanation, 'wrong answers come back with an explanation');

    const passed = await api('POST', `${V}/gate1-safety-quiz`, { token: alex.sessionToken, body: { answers: correctAnswers } });
    assert.deepEqual([passed.body.score, passed.body.passed, passed.body.nextGate], [5, true, 'gate2']);
  });

  test('gate 2: consent is required and spoofed or mismatched photos are refused', async () => {
    const noConsent = await api('POST', `${V}/gate2-verify-id-and-selfie`, { token: alex.sessionToken, form: await idForm('ff0000', '00ff00', false) });
    assert.equal(noConsent.status, 400);
    assert.equal(noConsent.body.error.code, 'consent_required');

    nextAudit = genuineAudit('1234 5678 9012');
    nextAudit.idDocument.isPhysicalDocument = false;
    nextAudit.idDocument.presentationAttackSignals = ['moiré pattern', 'laptop bezel visible'];
    const screen = await api('POST', `${V}/gate2-verify-id-and-selfie`, { token: alex.sessionToken, form: await idForm('ff0000', '00ff00') });
    assert.equal(screen.status, 200);
    assert.equal(screen.body.verified, false);
    assert.deepEqual(screen.body.reasons, ['id_not_physical']);
    assert.equal(screen.body.attemptsLeft, settings.maxIdAttempts - 1);

    nextAudit = genuineAudit('1234 5678 9012');
    const stranger = await api('POST', `${V}/gate2-verify-id-and-selfie`, { token: alex.sessionToken, form: await idForm('ff0000', '0000ff') });
    assert.equal(stranger.body.verified, false);
    assert.ok(stranger.body.reasons.includes('face_mismatch'));
    assert.ok(stranger.body.similarityScore < settings.face.enrollThreshold);

    const noFace = await api('POST', `${V}/gate2-verify-id-and-selfie`, { token: alex.sessionToken, form: await idForm('808080', '00ff00') });
    assert.ok(noFace.body.reasons.includes('no_face_on_id'));

    const rows = await pg.query<{ face: boolean; hash: string | null }>(
      `SELECT face_embedding IS NOT NULL AS face, id_number_hash AS hash FROM partner_verifications WHERE partner_id = $1`,
      [alex.user.id]
    );
    assert.deepEqual(rows.rows[0], { face: false, hash: null }, 'failed checks store no biometrics');
  });

  test('gate 2: a genuine ID and selfie verify, storing a template but never the ID number', async () => {
    nextAudit = genuineAudit('1234 5678 9012');
    const result = await api('POST', `${V}/gate2-verify-id-and-selfie`, { token: alex.sessionToken, form: await idForm('ff0000', '00ff00') });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.verified, true);
    assert.equal(result.body.badge, 'ID_VERIFIED');
    assert.ok(result.body.similarityScore >= settings.face.enrollThreshold);
    assert.deepEqual(result.body.extracted, {
      fullName: 'Alex Rivera',
      dob: '1994-03-18',
      idType: 'AADHAAR',
      idNumberMasked: '•••• 9012',
      countryCode: 'IN',
    });
    assert.equal(result.body.nextGate, 'gate3');

    const { rows } = await pg.query<{ hash: string; audit: unknown; dims: number }>(
      `SELECT id_number_hash AS hash, vlm_audit_json AS audit, vector_dims(face_embedding) AS dims
       FROM partner_verifications WHERE partner_id = $1`,
      [alex.user.id]
    );
    assert.match(rows[0]!.hash, /^[0-9a-f]{64}$/);
    assert.equal(rows[0]!.dims, 1024);
    assert.ok(!JSON.stringify(rows[0]!.audit).includes('123456789012'), 'the audit log has only the masked number');
    assert.ok(!JSON.stringify(rows[0]!.audit).includes('1234 5678 9012'));
  });

  test('gate 2: the same ID or the same face on a second account is blocked (1:N)', async () => {
    const blake = await login('+919811100002', 'partner', 'Blake');
    await api('POST', `${V}/gate1-safety-quiz`, { token: blake.sessionToken, body: { answers: correctAnswers } });

    nextAudit = genuineAudit('1234 5678 9012', 'Blake Shah');
    const reusedId = await api('POST', `${V}/gate2-verify-id-and-selfie`, { token: blake.sessionToken, form: await idForm('ffff00', '0000ff') });
    assert.equal(reusedId.body.verified, false);
    assert.deepEqual(reusedId.body.reasons, ['duplicate_identity']);

    const alexAgain = await login('+919811100003', 'partner', 'Alex R');
    await api('POST', `${V}/gate1-safety-quiz`, { token: alexAgain.sessionToken, body: { answers: correctAnswers } });
    nextAudit = genuineAudit('DL-0420110012345', 'Alex Rivera');
    nextAudit.idDocument.idType = 'DRIVING_LICENSE';
    const secondAccount = await api('POST', `${V}/gate2-verify-id-and-selfie`, { token: alexAgain.sessionToken, form: await idForm('ff0000', '00ff00') });
    assert.equal(secondAccount.body.verified, false);
    assert.deepEqual(secondAccount.body.reasons, ['duplicate_identity']);

    nextAudit = genuineAudit('9876 5432 1098', 'Blake Shah');
    const blakeOwn = await api('POST', `${V}/gate2-verify-id-and-selfie`, { token: blake.sessionToken, form: await idForm('ffff00', '0000ff') });
    assert.equal(blakeOwn.body.verified, true, JSON.stringify(blakeOwn.body));
  });

  test('gate 3: a society gate pass clears low-pull dogs now; the signed webhook settles the court check', async () => {
    const pending = await api('POST', `${V}/gate3-background-check`, {
      token: alex.sessionToken,
      body: { societyGatePassNumber: 'mygate-hg-4821', consentGiven: true },
    });
    assert.equal(pending.status, 200, JSON.stringify(pending.body));
    assert.deepEqual([pending.body.bgvStatus, pending.body.trustTier, pending.body.nextGate], ['PROVISIONAL_SOCIETY_PASS', 1, 'cleared']);
    const partner = await store.get('partners', alex.user.id);
    assert.deepEqual([partner?.approved, partner?.trustTier], [true, 1]);

    const forged = signed({ jobId: pending.body.jobId, outcome: 'clear' }, 'not-the-secret');
    const refused = await fetch(`${base}${V}/webhooks/background-check`, { method: 'POST', headers: forged.headers, body: forged.raw });
    assert.equal(refused.status, 401);

    const genuine = signed({ jobId: pending.body.jobId, outcome: 'clear', reference: 'court-check-77' });
    const cleared = await fetch(`${base}${V}/webhooks/background-check`, { method: 'POST', headers: genuine.headers, body: genuine.raw });
    assert.equal(cleared.status, 200);
    assert.equal(((await cleared.json()) as { bgvStatus: string }).bgvStatus, 'VERIFIED');
    assert.equal((await store.get('partners', alex.user.id))?.trustTier, 2);
    assert.equal(push.sent.at(-1)?.title, 'Background check cleared ✅');

    const replay = await fetch(`${base}${V}/webhooks/background-check`, { method: 'POST', headers: genuine.headers, body: genuine.raw });
    assert.equal(replay.status, 404, 'a closed job can’t be resolved twice');
  });

  test('gate 4: the doorstep selfie must be at the pickup and match, then unlocks the OTP and insurance', async () => {
    const online = await api('PUT', '/partners/me/status', { token: alex.sessionToken, body: { online: true, ...DOORSTEP } });
    assert.equal(online.status, 200, JSON.stringify(online.body));
    const customer = await login('+919811100009', 'customer', 'Meera');
    const booked = await api('POST', '/bookings', {
      token: customer.sessionToken,
      body: { tier: 'express', dog: { name: 'Bruno', breed: 'Indie', size: 'medium' }, pickup: PICKUP },
    });
    const offers = await api('GET', '/partners/me/offers', { token: alex.sessionToken });
    await api('POST', `/offers/${offers.body.offers[0].id}/accept`, { token: alex.sessionToken });
    const bookingId = booked.body.booking.id as string;

    const shiftForm = async (hex: string, at: { lat: number; lng: number }) => {
      const form = new FormData();
      form.set('bookingId', bookingId);
      form.set('gpsLat', String(at.lat));
      form.set('gpsLng', String(at.lng));
      form.set('shiftSelfieImage', new Blob([await jpeg(hex)], { type: 'image/jpeg' }), 'shift.jpg');
      return form;
    };

    const noSelfie = await api('POST', `/bookings/${bookingId}/start`, { token: alex.sessionToken, body: { otp: booked.body.booking.pickupOtp } });
    assert.equal(noSelfie.body.error.code, 'shift_selfie_required');

    const far = await api('POST', `${V}/gate4-shift-selfie-unlock`, { token: alex.sessionToken, form: await shiftForm('00ffff', CAFE) });
    assert.deepEqual([far.body.unlocked, far.body.reasons], [false, ['outside_geofence']]);
    assert.ok(far.body.distanceMeters > 500);

    const renter = await api('POST', `${V}/gate4-shift-selfie-unlock`, { token: alex.sessionToken, form: await shiftForm('0000ff', DOORSTEP) });
    assert.deepEqual([renter.body.unlocked, renter.body.reasons], [false, ['face_mismatch']]);

    const unlocked = await api('POST', `${V}/gate4-shift-selfie-unlock`, { token: alex.sessionToken, form: await shiftForm('00ffff', DOORSTEP) });
    assert.equal(unlocked.body.unlocked, true, JSON.stringify(unlocked.body));
    assert.ok(unlocked.body.similarity >= settings.face.shiftThreshold);
    assert.deepEqual([unlocked.body.insurance.active, unlocked.body.insurance.coverInr], [true, 10000]);

    const started = await api('POST', `/bookings/${bookingId}/start`, {
      token: alex.sessionToken,
      body: { otp: booked.body.booking.pickupOtp, handshakeToken: unlocked.body.handshakeToken },
    });
    assert.equal(started.body.booking.status, 'active');
    assert.equal(started.body.booking.insurance.active, true);

    const { rows } = await pg.query<{ unlocked: boolean; reason: string | null }>(
      `SELECT unlocked_otp AS unlocked, failure_reason AS reason FROM shift_attendance_logs WHERE booking_id = $1 ORDER BY verified_at`,
      [bookingId]
    );
    assert.deepEqual(rows.map((row) => row.reason ?? 'unlocked'), ['outside_geofence', 'face_mismatch', 'unlocked']);
  });

  test('erasure drops the face template and takes the walker off the road', async () => {
    const erased = await api('DELETE', `${V}/me/biometrics`, { token: alex.sessionToken });
    assert.equal(erased.status, 200);
    assert.equal(erased.body.nextGate, 'gate2');
    const partner = await store.get('partners', alex.user.id);
    assert.deepEqual([partner?.approved, partner?.online, partner?.trustTier], [false, false, 0]);
  });
});
