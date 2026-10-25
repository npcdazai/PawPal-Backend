import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type RequestHandler } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireSession, sessionOf } from '../auth/middleware.ts';
import { badRequest, forbidden, HttpError, unauthorized, unavailable } from '../http/errors.ts';
import { latitude, longitude, parse } from '../http/validate.ts';
import type { AppDeps } from '../app.ts';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
/** Signed webhook bodies older than this are refused (replay protection). */
const WEBHOOK_TOLERANCE_MS = 5 * 60_000;

/** Uploads stay in memory (never on disk) and are wiped after processing. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 2, fields: 8, fieldSize: 256 },
  fileFilter: (_req, file, accept) => accept(null, IMAGE_TYPES.has(file.mimetype)),
});

/** multer's errors → the API's error shape. */
function images(fields: string[]): RequestHandler {
  const handler = upload.fields(fields.map((name) => ({ name, maxCount: 1 })));
  return (req, res, next) =>
    handler(req, res, (error: unknown) => {
      if (error instanceof multer.MulterError) {
        next(
          error.code === 'LIMIT_FILE_SIZE'
            ? new HttpError(413, 'image_too_large', 'Photos must be under 8 MB.')
            : badRequest('invalid_upload', `Upload problem: ${error.message}.`)
        );
        return;
      }
      next(error);
    });
}

function file(req: Request, field: string): Buffer {
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  const found = files?.[field]?.[0];
  if (!found) throw badRequest('image_missing', `Attach ${field} as a JPEG, PNG or WebP photo.`);
  return found.buffer;
}

const truthy = z.union([z.boolean(), z.enum(['true', 'false']).transform((value) => value === 'true')]);

const quizAnswers = z.object({ answers: z.record(z.string().max(60), z.string().max(4)) });

const idAndSelfie = z.object({
  countryCode: z.string().regex(/^[A-Za-z]{2}$/, 'countryCode is ISO 3166-1 alpha-2, e.g. IN.').transform((v) => v.toUpperCase()),
  biometricConsent: truthy,
});

const backgroundCheck = z.object({
  /** Accepted for compatibility; must be the signed-in partner. */
  partnerId: z.string().uuid().optional(),
  societyGatePassNumber: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{4,40}$/, 'Gate pass numbers are 4–40 letters, digits or dashes.')
    .optional(),
  consentGiven: truthy,
});

const shiftSelfie = z.object({
  bookingId: z.string().uuid(),
  gpsLat: z.coerce.number().pipe(latitude),
  gpsLng: z.coerce.number().pipe(longitude),
});

const webhookBody = z.object({
  jobId: z.string().uuid(),
  outcome: z.enum(['clear', 'rejected', 'failed']),
  reference: z.string().max(120).optional(),
  details: z.unknown().optional(),
});

/** HMAC-SHA256 over `${timestamp}.${rawBody}`, sent as `X-PawPal-Signature: sha256=<hex>`. */
function verifyWebhook(req: Request, secret: string, now: number) {
  const timestamp = Number(req.get('x-pawpal-timestamp'));
  const signature = req.get('x-pawpal-signature') ?? '';
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!raw || !Number.isFinite(timestamp) || Math.abs(now - timestamp) > WEBHOOK_TOLERANCE_MS) {
    throw unauthorized('bad_signature', 'Missing or stale webhook signature.');
  }
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest();
  const given = Buffer.from(signature.replace(/^sha256=/, ''), 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw unauthorized('bad_signature', 'Webhook signature doesn’t match.');
  }
}

/**
 * /api/v1/partner-verification: the 4-gate pipeline for the Pawsome Partner app.
 * Every response carries `nextGate` so the app's onboarding state machine knows where to go.
 */
export function partnerVerificationRoutes({ sessions, verification, config, now }: AppDeps): Router {
  const router = Router();
  const base = '/api/v1/partner-verification';

  const pipeline = () => {
    if (!verification) throw unavailable('verification_unconfigured', 'Partner verification isn’t set up on this server (DATABASE_URL).');
    return verification;
  };

  // The vendor/ops webhook is authenticated by signature, not by a partner session.
  router.post(`${base}/webhooks/background-check`, async (req, res) => {
    const service = pipeline();
    verifyWebhook(req, config.verification!.bgvWebhookSecret, now());
    const body = parse(webhookBody, req.body);
    res.json(await service.resolveBackgroundCheck(body.jobId, body.outcome, body.reference ?? null, body.details ?? null));
  });

  router.use(base, requireSession(sessions, 'partner'));

  router.get(`${base}/status`, async (_req, res) => {
    res.json(await pipeline().status(sessionOf(res).userId));
  });

  router.get(`${base}/gate1-safety-quiz`, (_req, res) => {
    res.json({ questions: pipeline().quiz(), passScore: 4 });
  });

  router.post(`${base}/gate1-safety-quiz`, async (req, res) => {
    const { answers } = parse(quizAnswers, req.body);
    res.json(await pipeline().submitQuiz(sessionOf(res).userId, answers));
  });

  router.post(`${base}/gate2-verify-id-and-selfie`, images(['idDocumentImage', 'liveSelfieImage']), async (req, res) => {
    const service = pipeline();
    const body = parse(idAndSelfie, req.body);
    const result = await service.verifyIdAndSelfie(sessionOf(res).userId, {
      idImage: file(req, 'idDocumentImage'),
      selfieImage: file(req, 'liveSelfieImage'),
      countryCode: body.countryCode,
      consent: body.biometricConsent,
    });
    res.json(result);
  });

  router.post(`${base}/gate3-background-check`, async (req, res) => {
    const { userId } = sessionOf(res);
    const body = parse(backgroundCheck, req.body);
    if (body.partnerId && body.partnerId !== userId) throw forbidden('You can only submit your own background check.');
    res.json(
      await pipeline().startBackgroundCheck(userId, {
        societyGatePassNumber: body.societyGatePassNumber?.toUpperCase() ?? null,
        consent: body.consentGiven,
      })
    );
  });

  router.post(`${base}/gate4-shift-selfie-unlock`, images(['shiftSelfieImage']), async (req, res) => {
    const service = pipeline();
    const body = parse(shiftSelfie, req.body);
    res.json(
      await service.shiftUnlock(sessionOf(res).userId, {
        image: file(req, 'shiftSelfieImage'),
        bookingId: body.bookingId,
        lat: body.gpsLat,
        lng: body.gpsLng,
      })
    );
  });

  router.delete(`${base}/me/biometrics`, async (_req, res) => {
    res.json(await pipeline().eraseBiometrics(sessionOf(res).userId));
  });

  return router;
}
