-- Partner verification (4 gates) and shift-start attendance.
-- Idempotent: safe to run on every deploy (`npm run db:migrate`), and mounted
-- into the Postgres container's init directory by docker-compose.yml.

CREATE EXTENSION IF NOT EXISTS vector;

DO $$ BEGIN
  CREATE TYPE bgv_status AS ENUM ('LOCKED', 'PROVISIONAL_SOCIETY_PASS', 'PENDING_COURT_CHECK', 'VERIFIED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS partner_verifications (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id             UUID NOT NULL UNIQUE,
  country_code           CHAR(2),

  -- Gate 1: dog-handling safety quiz
  gate1_quiz_score       INT NOT NULL DEFAULT 0,
  gate1_passed           BOOLEAN NOT NULL DEFAULT FALSE,
  gate1_attempts         INT NOT NULL DEFAULT 0,

  -- Gate 2: government ID + live selfie. The ID image is never stored; only an
  -- HMAC of the ID number (to block re-use of one ID) and the selfie embedding.
  id_type                VARCHAR(40),
  id_number_hash         VARCHAR(64) UNIQUE,
  extracted_name         VARCHAR(200),
  extracted_dob          VARCHAR(20),
  vlm_spoof_check_passed BOOLEAN,
  vlm_audit_json         JSONB,
  face_embedding         vector(1024),
  id_selfie_similarity   DOUBLE PRECISION,
  gate2_passed           BOOLEAN NOT NULL DEFAULT FALSE,
  gate2_attempts         INT NOT NULL DEFAULT 0,
  biometric_consent_at   TIMESTAMPTZ,

  -- Gate 3: background check
  society_gate_pass      VARCHAR(40),
  bgv_consent_at         TIMESTAMPTZ,
  bgv_status             bgv_status NOT NULL DEFAULT 'LOCKED',
  -- 0 = not cleared, 1 = low-pull dogs only, 2 = all dogs, 3 = smart-lock home access
  trust_tier             SMALLINT NOT NULL DEFAULT 0 CHECK (trust_tier BETWEEN 0 AND 3),

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 1:N duplicate-face search (cosine distance, `<=>`).
CREATE INDEX IF NOT EXISTS partner_verifications_face_hnsw
  ON partner_verifications USING hnsw (face_embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS background_check_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id    UUID NOT NULL,
  provider      VARCHAR(20) NOT NULL,
  country_code  CHAR(2),
  -- QUEUED → SUBMITTED → CLEAR | REJECTED, or FAILED (vendor error; re-queue)
  status        VARCHAR(20) NOT NULL DEFAULT 'QUEUED',
  external_ref  VARCHAR(120),
  result_json   JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS background_check_jobs_partner ON background_check_jobs (partner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS background_check_jobs_status ON background_check_jobs (status);

CREATE TABLE IF NOT EXISTS shift_attendance_logs (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id               UUID NOT NULL,
  booking_id               UUID NOT NULL,
  shift_selfie_similarity  DOUBLE PRECISION,
  gps_lat                  DOUBLE PRECISION NOT NULL,
  gps_lng                  DOUBLE PRECISION NOT NULL,
  distance_m               DOUBLE PRECISION,
  unlocked_otp             BOOLEAN NOT NULL,
  failure_reason           VARCHAR(60),
  verified_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shift_attendance_logs_partner ON shift_attendance_logs (partner_id, verified_at DESC);
CREATE INDEX IF NOT EXISTS shift_attendance_logs_booking ON shift_attendance_logs (booking_id);
