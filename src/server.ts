import { dirname, join } from 'node:path';
import { getMessaging } from 'firebase-admin/messaging';
import { createApp } from './app.ts';
import { createPhoneVerifier } from './auth/phoneVerification.ts';
import { createSessions } from './auth/session.ts';
import { loadConfig } from './config.ts';
import { startAdbReverse } from './dev/adbReverse.ts';
import { devSessionSecret } from './dev/devSecret.ts';
import { createDispatcher } from './domain/dispatch.ts';
import { createPayments } from './domain/payments.ts';
import { createSubscriptions } from './domain/subscriptions.ts';
import { createYoupi } from './payments/youpi.ts';
import { createWalks } from './domain/walks.ts';
import { firestoreFor, initFirebase } from './firebase.ts';
import { connect, migrate } from './db/postgres.ts';
import { createOsmMaps } from './maps/osmMaps.ts';
import { createHumanFaceEngine } from './services/biometricFaceService.ts';
import { createVlmKycService } from './services/vlmKycService.ts';
import { createShiftHandshake } from './verification/handshake.ts';
import { createPartnerVerification } from './verification/partnerVerificationService.ts';
import { createVerificationRepository } from './verification/verificationRepository.ts';
import { configureLogging, logBanner, logger } from './log/logger.ts';
import { createFcmPush, createLogPush } from './push/push.ts';
import { createFileStore } from './store/fileStore.ts';
import { createFirestoreStore } from './store/firestoreStore.ts';
import { createMemoryStore } from './store/memoryStore.ts';
import { createOpenMeteoWeather } from './weather/openMeteo.ts';

/** How often waiting walk requests are checked for running out. */
const SWEEP_MS = 5_000;

const config = loadConfig();
configureLogging(config.logging);
const log = logger('server');

// Crashes still exit (as Node would), but print readably first.
process.on('uncaughtException', (error) => {
  log.error('Uncaught exception; stopping', { error });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection; stopping', { error: reason });
  process.exit(1);
});

const firebaseApp = initFirebase(config.firebase);
const firebase = () => {
  if (!firebaseApp) throw new Error('Firebase is not configured.');
  return firebaseApp;
};

const now = () => Date.now();
const fileStore = config.store === 'file' ? createFileStore(config.storeFile) : null;
const store = config.store === 'firestore' ? createFirestoreStore(firestoreFor(firebase())) : (fileStore ?? createMemoryStore());
// Kept data is only useful if the sessions that point at it stay valid too.
const devKeyFile = join(dirname(config.storeFile), 'dev-session-secret');
const sessionSecret = !config.sessionSecretSet && fileStore ? devSessionSecret(devKeyFile) : config.sessionSecret;
const push = config.push === 'fcm' ? createFcmPush(getMessaging(firebase()), store) : createLogPush();
const dispatcher = createDispatcher({ store, push, config: config.dispatch, now });
const handshake = createShiftHandshake(sessionSecret);

/** The 4-gate partner verification pipeline (Postgres + pgvector, open-weight VLM, on-server face matching). */
async function startVerification() {
  const settings = config.verification;
  if (!settings) return null;
  const db = await connect(settings.databaseUrl);
  await migrate(db);
  const faces = createHumanFaceEngine(settings.face);
  // Load the face models now so the first walker doesn't wait for them.
  faces.backend().then(
    (backend) => logger('face').info('Face engine ready', { backend }),
    (error: unknown) => logger('face').error('Face engine failed to load', { error })
  );
  return createPartnerVerification({
    repo: createVerificationRepository(db),
    vlm: createVlmKycService(settings.vlm),
    faces,
    store,
    push,
    handshake,
    config: settings,
    now,
  });
}
const verification = await startVerification();
const subscriptions = createSubscriptions({ store, now, gatePass: verification ? (partnerId) => verification.gatePass(partnerId) : null });
const walks = createWalks({
  store,
  push,
  dispatcher,
  now,
  shiftHandshake: verification ? handshake : null,
  paymentsRequired: config.payments !== null,
  subscriptions,
});
const payments = config.payments
  ? createPayments({ store, youpi: createYoupi(config.payments.youpi), walks, push, config: config.payments, now })
  : null;

const app = createApp({
  config,
  store,
  push,
  sessions: createSessions(sessionSecret, config.sessionDays),
  verifyPhone: createPhoneVerifier({ firebaseApp, devLogin: config.devLogin }),
  dispatcher,
  walks,
  maps: config.maps.enabled ? createOsmMaps(config.maps) : null,
  verification,
  payments,
  subscriptions,
  weather: config.weather.enabled ? createOpenMeteoWeather(config.weather) : null,
  now,
});

/** Development: USB phones and emulators keep reaching this server at localhost:<port>. */
let usbForward: { stop(): void } | null = null;

const server = app.listen(config.port, () => {
  const { level, format, bodies } = config.logging;
  logBanner(`🐾 PawPal API · http://localhost:${config.port}`, [
    ['mode', config.production ? 'production' : 'development'],
    [
      'store',
      config.store === 'file'
        ? `file ${config.storeFile} (kept across restarts)`
        : config.store === 'memory'
          ? 'memory (data is lost when the server stops)'
          : 'firestore',
    ],
    [
      'sessions',
      `${config.sessionDays} days · ${
        config.sessionSecretSet
          ? 'SESSION_SECRET'
          : fileStore
            ? `key in ${devKeyFile} (kept across restarts)`
            : 'random key (sign in again after a restart)'
      }`,
    ],
    ['push', config.push === 'fcm' ? 'firebase cloud messaging' : 'log only (printed here)'],
    ['phone sign-in', `${firebaseApp ? 'firebase' : 'not configured'}${config.devLogin ? ' + dev login (codes printed here)' : ''}`],
    ['adb reverse', config.adbReverse ? `on (USB phones and emulators reach localhost:${config.port})` : 'off'],
    ['maps', config.maps.enabled ? 'openstreetmap' : 'off'],
    ['weather', config.weather.enabled ? `on (${new URL(config.weather.url).host})` : 'off'],
    ['verification', verification ? `on (vlm ${config.verification!.vlm.model})` : 'off'],
    ['payments', payments ? 'youpi' : 'off (bookings need no payment)'],
    ['logging', `${format} · ${level} · bodies ${bodies}`],
  ]);
  if (config.production && config.maps.enabled && config.maps.nominatimUrl.includes('openstreetmap.org')) {
    log.warn('Maps use the volunteer-run public OSM servers; self-host them before real traffic (see README).');
  }
  if (config.production && config.weather.enabled && new URL(config.weather.url).host === 'api.open-meteo.com') {
    log.warn('Weather uses Open-Meteo’s free API, which is for non-commercial use only; set WEATHER_URL to a paid plan (see README).');
  }
  if (config.adbReverse) usbForward = startAdbReverse({ port: config.port });
});

const every = (ms: number, label: string, job: () => Promise<unknown>) =>
  setInterval(() => {
    job().catch((error: unknown) => log.error(`The ${label} sweep failed`, { error }));
  }, ms);

const sweepers = [
  every(SWEEP_MS, 'dispatch', () => dispatcher.sweep()),
  every(SWEEP_MS, 'dispatch-due', () => dispatcher.dispatchDue()),
  every(60_000, 'subscriptions', () => subscriptions.sweep()),
  ...(payments ? [every(60_000, 'payments', () => payments.sweepUnpaid())] : []),
];

function shutdown() {
  log.info('Shutting down');
  sweepers.forEach(clearInterval);
  usbForward?.stop();
  fileStore?.flush();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
