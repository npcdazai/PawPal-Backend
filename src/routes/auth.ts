import { createHash, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { createDevCodes, DEV_CODE_TTL_MS } from '../auth/devCodes.ts';
import { requireSession, sessionOf } from '../auth/middleware.ts';
import { E164, isDevToken, type VerifiedPhone } from '../auth/phoneVerification.ts';
import type { AppKind, Partner, User } from '../domain/types.ts';
import { conflict, HttpError, notFound, tooManyRequests, unauthorized } from '../http/errors.ts';
import { parse } from '../http/validate.ts';
import { logger } from '../log/logger.ts';
import { maskPhone } from '../log/redact.ts';
import type { AppDeps } from '../app.ts';

const log = logger('auth');

const phoneLogin = z.object({
  /** A Firebase Phone Number Verification token, a Firebase Auth ID token (SMS), or "dev:+91…" in development. */
  token: z.string().min(1).max(8192),
  method: z.enum(['pnv', 'sms']).default('pnv'),
  app: z.enum(['customer', 'partner']),
  name: z.string().trim().max(80).optional(),
  /** With a "dev:" token: the code from POST /auth/phone/code. Ignored for Firebase tokens. */
  code: z
    .string()
    .regex(/^\d{6}$/, 'The code is 6 digits.')
    .optional(),
});

const codeRequest = z.object({
  phone: z.string().regex(E164, 'Use +<country code><number>, e.g. +919876543210.'),
  app: z.enum(['customer', 'partner']),
  /** dev: the server makes the code (development only). firebase: Firebase already sent the SMS from the device. */
  method: z.enum(['dev', 'firebase']),
});

const profileUpdate = z
  .object({
    name: z.string().trim().min(1).max(80),
    email: z.email().max(200).nullable(),
  })
  .partial();

export function newPartner(user: User, at: number): Partner {
  return {
    userId: user.id,
    name: user.name,
    area: '',
    roles: ['walker'],
    sizes: ['small', 'medium', 'large'],
    skills: [],
    availability: ['mornings', 'evenings'],
    walkRate: 80,
    hourlyRate: 250,
    radiusKm: 3,
    payoutVpa: null,
    applicationSubmittedAt: null,
    approved: false,
    trustTier: 0,
    online: false,
    location: null,
    updatedAt: at,
  };
}

export const userView = ({ id, phone, name, email, apps }: User) => ({ id, phone, name, email: email ?? null, apps });

export function authRoutes({ config, store, sessions, verifyPhone, verification, now }: AppDeps): Router {
  const router = Router();
  /** Development verification codes; in memory, so a restart forgets them. */
  const codes = createDevCodes({ now });

  /** A "dev:" sign-in needs the code from POST /auth/phone/code when one was asked for. */
  function checkDevCode(phone: string, app: AppKind, code: string | undefined) {
    const outcome = codes.check(phone, code);
    switch (outcome.result) {
      case 'none':
        log.info('Development sign-in without a code (none was requested)', { app, phone });
        return;
      case 'accepted':
        log.info('Verification code accepted', { app, phone });
        return;
      case 'missing':
        log.warn('Verification code missing', { app, phone });
        throw unauthorized('code_required', 'Enter the 6-digit code we sent.');
      case 'wrong': {
        const left = outcome.triesLeft;
        log.warn('Wrong verification code', { app, phone, triesLeft: left });
        throw unauthorized('wrong_code', `That code isn’t right. ${left} ${left === 1 ? 'try' : 'tries'} left.`);
      }
      case 'locked':
        log.warn('Too many wrong verification codes; a new code is needed', { app, phone });
        throw unauthorized('code_locked', 'Too many wrong codes. Send a new code.');
    }
  }

  /**
   * Step one of phone sign-in. `dev` (development servers only): the server makes a 6-digit code and
   * prints it here instead of texting it. `firebase`: Firebase has texted the code from the device;
   * the server only notes it, and no code passes through it.
   */
  router.post('/auth/phone/code', (req, res) => {
    const body = parse(codeRequest, req.body);
    if (body.method === 'dev' && !config.devLogin) {
      log.warn('Development code refused: development sign-in is off', { app: body.app, phone: body.phone });
      throw new HttpError(403, 'dev_login_off', 'Development sign-in is turned off on this server.');
    }
    const limited = codes.admit(body.phone, req.ip ?? 'unknown');
    if (limited) {
      log.warn('Too many verification codes requested', { app: body.app, phone: body.phone, limit: `per ${limited === 'phone' ? 'phone' : 'client IP'}` });
      throw tooManyRequests('too_many_codes', 'Too many codes requested. Wait a few minutes and try again.');
    }
    if (body.method === 'firebase') {
      log.info('Verification SMS sent by Firebase', { app: body.app, phone: body.phone });
      res.json({ method: 'firebase' });
      return;
    }
    const { code, expiresAt } = codes.issue(body.phone);
    log.info(`📨 Verification code ${code} for ${maskPhone(body.phone)} (development: no SMS is sent)`, {
      app: body.app,
      expires: `${DEV_CODE_TTL_MS / 60_000} min`,
    });
    res.json({ method: 'dev', expiresAt, devCode: code });
  });

  /** One user per phone number, even if two first logins race. */
  async function userForPhone(phone: string, app: AppKind, name: string | undefined): Promise<User> {
    let entry = await store.get('phoneIndex', phone);
    if (!entry) {
      const fresh: User = { id: randomUUID(), phone, name: name ?? '', email: null, apps: [app], createdAt: now() };
      if (await store.create('phoneIndex', phone, { userId: fresh.id })) {
        await store.set('users', fresh.id, fresh);
        log.info('New account', { user: fresh.id, phone, app });
        return fresh;
      }
      entry = await store.get('phoneIndex', phone);
    }
    const user = entry && (await store.get('users', entry.userId));
    if (!user) throw notFound('Account');
    const updated: User = {
      ...user,
      name: user.name || name || '',
      apps: user.apps.includes(app) ? user.apps : [...user.apps, app],
    };
    if (updated.name !== user.name || updated.apps !== user.apps) await store.set('users', user.id, updated);
    return updated;
  }

  /** Exchanges a verified phone number for an API session. */
  router.post('/auth/phone', async (req, res) => {
    const body = parse(phoneLogin, req.body);
    const dev = isDevToken(body.token);
    let verified: VerifiedPhone;
    try {
      verified = await verifyPhone(body.token, body.method);
    } catch (error) {
      log.warn('Phone verification failed', {
        app: body.app,
        method: body.method,
        kind: dev ? 'dev' : 'firebase',
        reason: error instanceof HttpError ? error.code : 'internal',
      });
      throw error;
    }
    if (dev) checkDevCode(verified.phone, body.app, body.code);

    // Each phone-verification token works once, so a leaked one can't be replayed.
    if (verified.tokenId) {
      const key = createHash('sha256').update(verified.tokenId).digest('hex');
      const fresh = await store.create('usedPhoneTokens', key, { usedAt: now(), expiresAt: verified.expiresAt });
      if (!fresh) {
        log.warn('Phone verification reused; refused', { phone: verified.phone, app: body.app });
        throw unauthorized('phone_token_used', 'That verification was already used. Verify your number again.');
      }
    }

    const user = await userForPhone(verified.phone, body.app, body.name);
    let partner: Partner | null = null;
    if (body.app === 'partner') {
      partner = await store.get('partners', user.id);
      if (!partner) {
        partner = newPartner(user, now());
        await store.set('partners', user.id, partner);
        log.info('Walker profile created', { walker: user.id });
      }
    }

    const sessionToken = await sessions.issue({ userId: user.id, app: body.app });
    log.info('Signed in', { app: body.app, user: user.id, phone: user.phone, via: dev ? 'dev' : body.method });
    res.json({ sessionToken, user: userView(user), partner });
  });

  router.get('/me', requireSession(sessions), async (_req, res) => {
    const { userId, app } = sessionOf(res);
    const user = await store.get('users', userId);
    if (!user) throw unauthorized('session_required', 'Sign in again.');
    const partner = app === 'partner' ? await store.get('partners', userId) : null;
    res.json({ user: userView(user), app, partner });
  });

  /**
   * Deletes the account (store requirement). Refused during a walk. Open bookings are cancelled
   * and packs stopped; completed walks stay as financial records, without the account they belonged to.
   */
  router.delete('/me', requireSession(sessions), async (_req, res) => {
    const { userId } = sessionOf(res);
    const user = await store.get('users', userId);
    if (!user) throw unauthorized('session_required', 'Sign in again.');
    const mine = [
      ...(await store.find('bookings', { customerId: userId })),
      ...(await store.find('bookings', { partnerId: userId })),
    ];
    if (mine.some((booking) => booking.status === 'assigned' || booking.status === 'active')) {
      throw conflict('walk_in_progress', 'Finish or cancel your current walk before deleting your account.');
    }
    const at = now();
    let cancelled = 0;
    for (const booking of mine) {
      if (['awaiting_payment', 'searching', 'unmatched'].includes(booking.status) && booking.customerId === userId) {
        await store.set('bookings', booking.id, { ...booking, status: 'cancelled', updatedAt: at });
        cancelled += 1;
      }
    }
    let packsStopped = 0;
    for (const pack of await store.find('subscriptions', { customerId: userId })) {
      if (pack.status === 'active') {
        await store.set('subscriptions', pack.id, { ...pack, status: 'cancelled', updatedAt: at });
        packsStopped += 1;
      }
    }
    for (const device of await store.find('devices', { userId })) await store.delete('devices', device.token);
    if (verification) await verification.eraseBiometrics(userId).catch(() => undefined);
    await store.delete('partners', userId);
    await store.delete('phoneIndex', user.phone);
    await store.delete('users', userId);
    log.info('Account deleted', { user: userId, bookingsCancelled: cancelled, packsStopped });
    res.status(204).end();
  });

  router.patch('/me', requireSession(sessions), async (req, res) => {
    const { userId } = sessionOf(res);
    const patch = parse(profileUpdate, req.body);
    const user = await store.get('users', userId);
    if (!user) throw unauthorized('session_required', 'Sign in again.');
    const updated: User = { ...user, ...patch };
    await store.set('users', userId, updated);
    const partner = patch.name ? await store.get('partners', userId) : null;
    if (partner && patch.name) await store.update('partners', userId, { name: patch.name, updatedAt: now() });
    res.json({ user: userView(updated) });
  });

  return router;
}
