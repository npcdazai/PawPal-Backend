import { Router } from 'express';
import { z } from 'zod';
import { requireSession, sessionOf } from '../auth/middleware.ts';
import { parse } from '../http/validate.ts';
import type { AppDeps } from '../app.ts';

/** FCM registration tokens: letters, digits and ":_-" (never "/", so they can be document ids). */
const fcmToken = z.string().regex(/^[\w:-]{20,4096}$/, 'Not an FCM registration token.');

const registration = z.object({
  token: fcmToken,
  platform: z.enum(['android', 'ios', 'web']),
});

/** Where push notifications go: one entry per signed-in app install. */
export function deviceRoutes({ store, sessions, now }: AppDeps): Router {
  const router = Router();
  router.use('/devices', requireSession(sessions));

  router.post('/devices', async (req, res) => {
    const { userId, app } = sessionOf(res);
    const { token, platform } = parse(registration, req.body);
    // A token moves to whoever signed in last on that install.
    await store.set('devices', token, { token, userId, app, platform, updatedAt: now() });
    res.status(204).end();
  });

  /** Called on sign-out so the install stops getting this account's notifications. */
  router.delete('/devices/:token', async (req, res) => {
    const { userId } = sessionOf(res);
    const token = parse(fcmToken, req.params.token);
    const device = await store.get('devices', token);
    if (device?.userId === userId) await store.delete('devices', token);
    res.status(204).end();
  });

  return router;
}
