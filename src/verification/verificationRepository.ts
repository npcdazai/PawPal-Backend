import { fromVector, toVector, type Db } from '../db/postgres.ts';

export const BGV_STATUSES = ['LOCKED', 'PROVISIONAL_SOCIETY_PASS', 'PENDING_COURT_CHECK', 'VERIFIED', 'REJECTED'] as const;
export type BgvStatus = (typeof BGV_STATUSES)[number];

export interface VerificationRow {
  partnerId: string;
  countryCode: string | null;
  gate1Score: number;
  gate1Passed: boolean;
  gate1Attempts: number;
  idType: string | null;
  extractedName: string | null;
  extractedDob: string | null;
  spoofCheckPassed: boolean | null;
  similarity: number | null;
  gate2Passed: boolean;
  gate2Attempts: number;
  hasFace: boolean;
  societyGatePass: string | null;
  bgvStatus: BgvStatus;
  trustTier: number;
}

export interface IdCheckRecord {
  countryCode: string | null;
  idType: string | null;
  idNumberHash: string | null;
  extractedName: string | null;
  extractedDob: string | null;
  spoofCheckPassed: boolean;
  audit: unknown;
  /** Stored only for a passed check. */
  embedding: number[] | null;
  similarity: number | null;
  passed: boolean;
}

export interface AttendanceRecord {
  partnerId: string;
  bookingId: string;
  similarity: number | null;
  lat: number;
  lng: number;
  distanceM: number;
  unlocked: boolean;
  failureReason: string | null;
}

const COLUMNS = `
  partner_id AS "partnerId", country_code AS "countryCode",
  gate1_quiz_score AS "gate1Score", gate1_passed AS "gate1Passed", gate1_attempts AS "gate1Attempts",
  id_type AS "idType", extracted_name AS "extractedName", extracted_dob AS "extractedDob",
  vlm_spoof_check_passed AS "spoofCheckPassed", id_selfie_similarity AS "similarity",
  gate2_passed AS "gate2Passed", gate2_attempts AS "gate2Attempts", (face_embedding IS NOT NULL) AS "hasFace",
  society_gate_pass AS "societyGatePass", bgv_status AS "bgvStatus", trust_tier AS "trustTier"`;

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = '23505';

export function createVerificationRepository(db: Db) {
  const one = async (sql: string, params: unknown[]) => (await db.query<VerificationRow>(sql, params)).rows[0] ?? null;

  return {
    get: (partnerId: string) => one(`SELECT ${COLUMNS} FROM partner_verifications WHERE partner_id = $1`, [partnerId]),

    /** Records a quiz attempt; once passed, a later lower score doesn't un-pass it. */
    recordQuiz: async (partnerId: string, score: number, passed: boolean) =>
      (await one(
        `INSERT INTO partner_verifications (partner_id, gate1_quiz_score, gate1_passed, gate1_attempts)
         VALUES ($1, $2, $3, 1)
         ON CONFLICT (partner_id) DO UPDATE SET
           gate1_quiz_score = EXCLUDED.gate1_quiz_score,
           gate1_passed = partner_verifications.gate1_passed OR EXCLUDED.gate1_passed,
           gate1_attempts = partner_verifications.gate1_attempts + 1,
           updated_at = now()
         RETURNING ${COLUMNS}`,
        [partnerId, score, passed]
      ))!,

    /** Uses up one ID-check attempt; null when none are left (atomic, so parallel uploads can't exceed it). */
    claimIdAttempt: async (partnerId: string, max: number) =>
      (
        await db.query<{ attempts: number }>(
          `UPDATE partner_verifications SET gate2_attempts = gate2_attempts + 1, updated_at = now()
           WHERE partner_id = $1 AND gate2_attempts < $2 RETURNING gate2_attempts AS attempts`,
          [partnerId, max]
        )
      ).rows[0]?.attempts ?? null,

    idHashOwner: async (hash: string) =>
      (await db.query<{ partnerId: string }>(
        `SELECT partner_id AS "partnerId" FROM partner_verifications WHERE id_number_hash = $1`,
        [hash]
      )).rows[0]?.partnerId ?? null,

    /** 1:N search: other accounts whose enrolled face is at least `minSimilarity` (cosine) to this one. */
    similarFaces: async (partnerId: string, embedding: readonly number[], minSimilarity: number, limit = 3) =>
      (
        await db.query<{ partnerId: string; bgvStatus: BgvStatus; similarity: number }>(
          `SELECT partner_id AS "partnerId", bgv_status AS "bgvStatus", 1 - (face_embedding <=> $2::vector) AS similarity
           FROM partner_verifications
           WHERE partner_id <> $1 AND face_embedding IS NOT NULL
           ORDER BY face_embedding <=> $2::vector
           LIMIT $3`,
          [partnerId, toVector(embedding), limit]
        )
      ).rows
        .map((row) => ({ ...row, similarity: Number(row.similarity) }))
        .filter((row) => row.similarity >= minSimilarity),

    /** Saves a gate-2 outcome; returns false when the ID hash already belongs to someone else (lost a race). */
    saveIdCheck: async (partnerId: string, record: IdCheckRecord): Promise<boolean> => {
      try {
        await db.query(
          `UPDATE partner_verifications SET
             country_code = $2, id_type = $3,
             id_number_hash = CASE WHEN $11 THEN $4 ELSE id_number_hash END,
             extracted_name = $5, extracted_dob = $6, vlm_spoof_check_passed = $7, vlm_audit_json = $8::jsonb,
             face_embedding = CASE WHEN $11 THEN $9::vector ELSE face_embedding END,
             id_selfie_similarity = $10, gate2_passed = gate2_passed OR $11,
             biometric_consent_at = COALESCE(biometric_consent_at, now()), updated_at = now()
           WHERE partner_id = $1`,
          [
            partnerId,
            record.countryCode,
            record.idType,
            record.idNumberHash,
            record.extractedName,
            record.extractedDob,
            record.spoofCheckPassed,
            JSON.stringify(record.audit),
            record.embedding ? toVector(record.embedding) : null,
            record.similarity,
            record.passed,
          ]
        );
        return true;
      } catch (error) {
        if ((error as { code?: string }).code === UNIQUE_VIOLATION) return false;
        throw error;
      }
    },

    faceEmbedding: async (partnerId: string) =>
      fromVector(
        (await db.query<{ embedding: unknown }>(
          `SELECT face_embedding::text AS embedding FROM partner_verifications WHERE partner_id = $1`,
          [partnerId]
        )).rows[0]?.embedding
      ),

    setBackgroundCheck: (partnerId: string, societyGatePass: string | null, status: BgvStatus, tier: number) =>
      one(
        `UPDATE partner_verifications SET society_gate_pass = $2, bgv_status = $3::bgv_status, trust_tier = $4,
           bgv_consent_at = COALESCE(bgv_consent_at, now()), updated_at = now()
         WHERE partner_id = $1 RETURNING ${COLUMNS}`,
        [partnerId, societyGatePass, status, tier]
      ),

    createJob: async (partnerId: string, provider: string, countryCode: string | null) =>
      (await db.query<{ id: string }>(
        `INSERT INTO background_check_jobs (partner_id, provider, country_code) VALUES ($1, $2, $3) RETURNING id`,
        [partnerId, provider, countryCode]
      )).rows[0]!.id,

    /** Closes an open job; returns its partner, or null if the job is unknown or already closed. */
    closeJob: async (jobId: string, status: 'CLEAR' | 'REJECTED' | 'FAILED', reference: string | null, result: unknown) =>
      (await db.query<{ partnerId: string }>(
        `UPDATE background_check_jobs SET status = $2, external_ref = COALESCE($3, external_ref),
           result_json = $4::jsonb, updated_at = now()
         WHERE id = $1 AND status IN ('QUEUED', 'SUBMITTED') RETURNING partner_id AS "partnerId"`,
        [jobId, status, reference, JSON.stringify(result ?? null)]
      )).rows[0]?.partnerId ?? null,

    setBgvStatus: (partnerId: string, status: BgvStatus, tier: number) =>
      one(
        `UPDATE partner_verifications SET bgv_status = $2::bgv_status, trust_tier = $3, updated_at = now()
         WHERE partner_id = $1 RETURNING ${COLUMNS}`,
        [partnerId, status, tier]
      ),

    logAttendance: async (entry: AttendanceRecord) => {
      await db.query(
        `INSERT INTO shift_attendance_logs
           (partner_id, booking_id, shift_selfie_similarity, gps_lat, gps_lng, distance_m, unlocked_otp, failure_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [entry.partnerId, entry.bookingId, entry.similarity, entry.lat, entry.lng, entry.distanceM, entry.unlocked, entry.failureReason]
      );
    },

    /**
     * Erases the partner's biometric template and ID hash (DPDP/GDPR erasure). A REJECTED
     * partner's record is kept for fraud prevention, which those laws allow.
     */
    eraseBiometrics: (partnerId: string) =>
      one(
        `UPDATE partner_verifications SET
           face_embedding = NULL, id_number_hash = NULL, id_selfie_similarity = NULL, gate2_passed = FALSE,
           bgv_status = 'LOCKED', trust_tier = 0, updated_at = now()
         WHERE partner_id = $1 AND bgv_status <> 'REJECTED' RETURNING ${COLUMNS}`,
        [partnerId]
      ),
  };
}

export type VerificationRepository = ReturnType<typeof createVerificationRepository>;
