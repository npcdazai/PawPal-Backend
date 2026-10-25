import type { Messaging } from 'firebase-admin/messaging';
import type { AppKind } from '../domain/types.ts';
import { logger } from '../log/logger.ts';
import type { Store } from '../store/store.ts';

const log = logger('push');

export interface PushMessage {
  title: string;
  body: string;
  /** Opened by the app on tap, e.g. `{ type: 'offer', offerId }`. FCM only carries strings. */
  data: Record<string, string>;
  /** Time-critical (a walk request): wake the device straight away. */
  urgent?: boolean;
}

export interface SentPush extends PushMessage {
  userId: string;
  app: AppKind;
}

export interface Push {
  /** Notifies every device the user has signed in on with that app. Never throws. */
  toUser(userId: string, app: AppKind, message: PushMessage): Promise<void>;
}

/** FCM errors that mean the token will never work again. */
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

/** Firebase Cloud Messaging; tokens FCM reports as dead are deleted. */
export function createFcmPush(messaging: Messaging, store: Store): Push {
  return {
    async toUser(userId, app, message) {
      try {
        const devices = await store.find('devices', { userId, app });
        if (devices.length === 0) {
          log.debug('Nobody to notify: no devices registered', { to: app, user: userId, title: message.title });
          return;
        }
        const tokens = devices.map((device) => device.token);
        const response = await messaging.sendEachForMulticast({
          tokens,
          notification: { title: message.title, body: message.body },
          data: message.data,
          android: { priority: message.urgent ? 'high' : 'normal' },
          apns: {
            headers: { 'apns-priority': message.urgent ? '10' : '5' },
            payload: { aps: { sound: 'default' } },
          },
        });
        const dead = response.responses.filter((result) => result.error && DEAD_TOKEN_CODES.has(result.error.code)).length;
        await Promise.all(
          response.responses.map((result, index) => {
            const token = tokens[index];
            const code = result.error?.code;
            return token && code && DEAD_TOKEN_CODES.has(code) ? store.delete('devices', token) : undefined;
          })
        );
        const fields = { to: app, user: userId, devices: tokens.length, failed: response.failureCount || undefined, removed: dead || undefined };
        if (response.failureCount > 0) log.warn(`${message.title} (not every device got it)`, fields);
        else log.info(message.title, fields);
      } catch (error) {
        log.error('Push failed', { to: app, user: userId, title: message.title, error });
      }
    },
  };
}

/** Development stand-in: prints each notification and keeps it in `sent`. */
export function createLogPush(options: { quiet?: boolean } = {}): Push & { sent: SentPush[] } {
  const sent: SentPush[] = [];
  return {
    sent,
    async toUser(userId, app, message) {
      sent.push({ userId, app, ...message });
      if (!options.quiet) {
        log.info(message.title, { to: app, user: userId, type: message.data.type, urgent: message.urgent, text: message.body });
      }
    },
  };
}
