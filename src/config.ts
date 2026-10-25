import { randomBytes } from 'node:crypto';
import type { LogSettings } from './log/logger.ts';

/** Everything the server reads from the environment (see .env.example). */
export interface Config {
  port: number;
  production: boolean;
  /** Browser origins allowed to call the API (the Expo web dev servers). Native apps send no Origin. */
  corsOrigins: readonly string[];
  /** Signs the app's session tokens (HS256). */
  sessionSecret: Uint8Array;
  /** False when SESSION_SECRET is unset: development then uses a random key, or a saved one with STORE=file. */
  sessionSecretSet: boolean;
  sessionDays: number;
  firebase: {
    /** Path to a service-account JSON; otherwise Application Default Credentials are used. */
    serviceAccountPath: string | null;
    projectId: string | null;
    /** True when either a key file or GOOGLE_APPLICATION_CREDENTIALS is set. */
    configured: boolean;
  };
  /** 'file' (development default without Firebase): memory saved to `storeFile`, so data survives restarts. */
  store: 'firestore' | 'memory' | 'file';
  storeFile: string;
  push: 'fcm' | 'log';
  /** Accepts "dev:+91XXXXXXXXXX" instead of a real phone token. Never on in production. */
  devLogin: boolean;
  /** Development: keeps `adb reverse tcp:<port> tcp:<port>` on USB phones and emulators. Never on in production. */
  adbReverse: boolean;
  /** New partner applications are approved at once (no manual vetting yet). */
  autoApprovePartners: boolean;
  /** Free OpenStreetMap services; swap the URLs for self-hosted copies under real load. */
  maps: {
    enabled: boolean;
    nominatimUrl: string;
    photonUrl: string;
    /** OSRM `route/v1` base running the foot profile. */
    osrmFootUrl: string;
    /** Required by the public servers' usage policies: name the app and a contact. */
    userAgent: string;
    /** ISO country code results are limited to ("in"), or null for anywhere. */
    countryCode: string | null;
  };
  dispatch: {
    offerSeconds: number;
    maxOffers: number;
    /** A partner's location older than this doesn't count as "nearby". */
    locationMaxAgeMinutes: number;
  };
  /** Current weather for the home screen (Open-Meteo by default; its free API is non-commercial only). */
  weather: {
    enabled: boolean;
    /** An Open-Meteo-compatible `/v1/forecast` URL; a paid plan's URL may carry `?apikey=`. */
    url: string;
  };
  /** The 4-gate partner verification pipeline; null without DATABASE_URL. */
  verification: VerificationConfig | null;
  /** YouPI checkout; null means bookings don't need payment (development only). */
  payments: PaymentsConfig | null;
  /** Development: coloured lines with request bodies. Production: JSON lines, no bodies. */
  logging: LogSettings;
}

export interface PaymentsConfig {
  youpi: {
    baseUrl: string;
    merchantId: string;
    /** The merchant's webhook secret: signs webhooks and unlocks the merchant view of a payment. */
    merchantKey: string;
  };
  /** YouPI verification level a SUCCESS needs before a booking counts as paid (0 unverified, 1 one bank source, 2 two). */
  minVerificationLevel: number;
  /** Where the checkout page sends the customer afterwards (the app's deep link). */
  returnUrl: string;
  /** Unpaid bookings are released after this long. */
  holdMinutes: number;
}

export interface VerificationConfig {
  databaseUrl: string;
  /** Keys the ID-number hash (HMAC-SHA256), so a leaked table can't be brute-forced back to ID numbers. */
  idHashPepper: string;
  vlm: {
    /** Any OpenAI-compatible endpoint: Ollama, vLLM, Together, OpenRouter. */
    baseUrl: string;
    apiKey: string;
    model: string;
    timeoutMs: number;
    /** Also ask the VLM about the doorstep selfie (slower on CPU). */
    shiftCheck: boolean;
  };
  face: {
    backend: 'auto' | 'tensorflow' | 'wasm';
    /** Cosine similarity needed between the ID photo and the enrolment selfie. */
    enrollThreshold: number;
    /** …between the enrolled face and the doorstep selfie. */
    shiftThreshold: number;
    /** …above which another account's face counts as the same person. */
    duplicateThreshold: number;
    /** Human's anti-spoof and liveness scores (0–1) a live selfie must reach. */
    antispoofMin: number;
    livenessMin: number;
    /** Head turned further than this (degrees, any axis) isn't a usable selfie. */
    maxPoseDegrees: number;
  };
  maxIdAttempts: number;
  geofenceMeters: number;
  /**
   * Background-check vendor per market. Only "manual" exists (ops runs the check and posts the
   * result to the signed webhook); IDfy / AuthBridge (India) and Checkr adapters plug in here.
   */
  bgvProviderIndia: 'manual';
  bgvProviderGlobal: 'manual';
  /** Signs background-check results posted to the webhook (vendor relay or ops tooling). */
  bgvWebhookSecret: string;
}

const flag = (value: string | undefined, fallback: boolean) =>
  value === undefined || value === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());

const int = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const text = (value: string | undefined) => (value && value.trim() ? value.trim() : null);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';

  const serviceAccountPath = text(env.FIREBASE_SERVICE_ACCOUNT);
  const firebaseConfigured = serviceAccountPath !== null || text(env.GOOGLE_APPLICATION_CREDENTIALS) !== null;

  const secret = text(env.SESSION_SECRET);
  if (production && (!secret || secret.length < 32)) {
    throw new Error('SESSION_SECRET must be set to at least 32 characters in production.');
  }

  const store = text(env.STORE) ?? (firebaseConfigured ? 'firestore' : 'file');
  if (store !== 'firestore' && store !== 'memory' && store !== 'file') {
    throw new Error(`STORE must be "firestore", "file" or "memory", got "${store}".`);
  }
  const push = text(env.PUSH) ?? (firebaseConfigured ? 'fcm' : 'log');
  if (push !== 'fcm' && push !== 'log') throw new Error(`PUSH must be "fcm" or "log", got "${push}".`);
  if ((store === 'firestore' || push === 'fcm') && !firebaseConfigured) {
    throw new Error('Firestore and FCM need FIREBASE_SERVICE_ACCOUNT or GOOGLE_APPLICATION_CREDENTIALS.');
  }
  if (production && store === 'memory') throw new Error('STORE=memory loses all data on restart; use firestore in production.');
  if (production && store === 'file') throw new Error('STORE=file is for development (one process, local disk); use firestore in production.');

  const devLogin = flag(env.AUTH_DEV_LOGIN, !production);
  const country = (text(env.MAPS_COUNTRY) ?? 'in').toLowerCase();
  if (production && devLogin) throw new Error('AUTH_DEV_LOGIN cannot be enabled in production.');
  const weatherUrl = text(env.WEATHER_URL);
  // Not echoed: a paid plan's URL carries its key.
  if (weatherUrl && !URL.canParse(weatherUrl)) throw new Error('WEATHER_URL must be a full URL (https://…).');

  return {
    port: int(env.PORT, 4000),
    production,
    corsOrigins: (text(env.CORS_ORIGINS) ?? 'http://localhost:8081,http://localhost:8082,http://localhost:8083')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    // A dev server without a secret gets a random one here; with STORE=file, server.ts swaps in a saved one.
    sessionSecret: new TextEncoder().encode(secret ?? randomBytes(32).toString('hex')),
    sessionSecretSet: secret !== null,
    sessionDays: int(env.SESSION_DAYS, 30),
    firebase: {
      serviceAccountPath,
      projectId: text(env.FIREBASE_PROJECT_ID) ?? text(env.GOOGLE_CLOUD_PROJECT),
      configured: firebaseConfigured,
    },
    store,
    storeFile: text(env.STORE_FILE) ?? '.data/dev-store.json',
    push,
    devLogin,
    adbReverse: !production && flag(env.ADB_REVERSE, true),
    autoApprovePartners: flag(env.AUTO_APPROVE_PARTNERS, !production),
    maps: {
      enabled: flag(env.MAPS_ENABLED, true),
      nominatimUrl: text(env.NOMINATIM_URL) ?? 'https://nominatim.openstreetmap.org',
      photonUrl: text(env.PHOTON_URL) ?? 'https://photon.komoot.io',
      osrmFootUrl: text(env.OSRM_FOOT_URL) ?? 'https://routing.openstreetmap.de/routed-foot/route/v1/driving',
      userAgent: text(env.MAPS_USER_AGENT) ?? 'PawPal-API/0.1',
      countryCode: country === 'any' ? null : country,
    },
    dispatch: {
      offerSeconds: int(env.DISPATCH_OFFER_SECONDS, 25),
      maxOffers: int(env.DISPATCH_MAX_OFFERS, 5),
      locationMaxAgeMinutes: int(env.DISPATCH_LOCATION_MAX_AGE_MINUTES, 15),
    },
    weather: {
      enabled: flag(env.WEATHER_ENABLED, true),
      url: weatherUrl ?? 'https://api.open-meteo.com/v1/forecast',
    },
    verification: loadVerificationConfig(env, production, secret),
    payments: loadPaymentsConfig(env, production),
    logging: {
      level: oneOf('LOG_LEVEL', env.LOG_LEVEL, ['debug', 'info', 'warn', 'error', 'silent'], production ? 'info' : 'debug'),
      format: oneOf('LOG_FORMAT', env.LOG_FORMAT, ['pretty', 'json'], production ? 'json' : 'pretty'),
      bodies: oneOf('LOG_BODIES', env.LOG_BODIES, ['off', 'changes', 'all'], production ? 'off' : 'changes'),
    },
  };
}

function loadPaymentsConfig(env: NodeJS.ProcessEnv, production: boolean): PaymentsConfig | null {
  const baseUrl = text(env.YOUPI_URL);
  if (!baseUrl) {
    if (production) throw new Error('Set YOUPI_URL, YOUPI_MERCHANT_ID and YOUPI_MERCHANT_KEY: production bookings must be paid.');
    return null;
  }
  const merchantId = text(env.YOUPI_MERCHANT_ID);
  const merchantKey = text(env.YOUPI_MERCHANT_KEY);
  if (!merchantId || !merchantKey) throw new Error('YOUPI_URL needs YOUPI_MERCHANT_ID and YOUPI_MERCHANT_KEY too.');
  if (production && !baseUrl.startsWith('https://')) throw new Error('YOUPI_URL must be https in production.');
  return {
    youpi: { baseUrl: baseUrl.replace(/\/+$/, ''), merchantId, merchantKey },
    minVerificationLevel: Math.min(2, Math.max(0, int(env.PAYMENT_MIN_VERIFICATION_LEVEL, 1))),
    returnUrl: text(env.PAYMENT_RETURN_URL) ?? 'pawpal://payment-return',
    holdMinutes: int(env.PAYMENT_HOLD_MINUTES, 30),
  };
}

const ratio = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
};

function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[], fallback: T): T {
  const chosen = text(value) ?? fallback;
  if (!allowed.includes(chosen as T)) throw new Error(`${name} must be one of ${allowed.join(', ')}; got "${chosen}".`);
  return chosen as T;
}

function loadVerificationConfig(
  env: NodeJS.ProcessEnv,
  production: boolean,
  sessionSecret: string | null
): VerificationConfig | null {
  const databaseUrl = text(env.DATABASE_URL);
  if (!databaseUrl) return null;
  if (production && databaseUrl.startsWith('pglite://')) throw new Error('pglite:// is for development; use Postgres in production.');

  const pepper = text(env.ID_HASH_PEPPER);
  if (production && (!pepper || pepper.length < 32)) throw new Error('ID_HASH_PEPPER must be at least 32 characters in production.');
  const webhookSecret = text(env.BGV_WEBHOOK_SECRET);
  if (production && (!webhookSecret || webhookSecret.length < 32)) {
    throw new Error('BGV_WEBHOOK_SECRET must be at least 32 characters in production.');
  }

  return {
    databaseUrl,
    // Development falls back to the session secret so hashes stay stable between restarts when it is set.
    idHashPepper: pepper ?? sessionSecret ?? 'development-only-pepper',
    vlm: {
      baseUrl: text(env.VLM_BASE_URL) ?? 'http://localhost:11434/v1',
      apiKey: text(env.VLM_API_KEY) ?? 'ollama',
      model: text(env.VLM_MODEL) ?? 'qwen2.5vl:7b',
      timeoutMs: int(env.VLM_TIMEOUT_MS, 180_000),
      shiftCheck: flag(env.VLM_SHIFT_CHECK, true),
    },
    face: {
      backend: oneOf('FACE_BACKEND', env.FACE_BACKEND, ['auto', 'tensorflow', 'wasm'], 'auto'),
      enrollThreshold: ratio(env.FACE_MATCH_ENROLL, 0.82),
      shiftThreshold: ratio(env.FACE_MATCH_SHIFT, 0.85),
      duplicateThreshold: ratio(env.FACE_DUPLICATE_THRESHOLD, 0.88),
      antispoofMin: ratio(env.FACE_ANTISPOOF_MIN, 0.5),
      livenessMin: ratio(env.FACE_LIVENESS_MIN, 0.5),
      maxPoseDegrees: int(env.FACE_MAX_POSE_DEGREES, 25),
    },
    maxIdAttempts: int(env.KYC_MAX_ID_ATTEMPTS, 5),
    geofenceMeters: int(env.SHIFT_GEOFENCE_METERS, 100),
    bgvProviderIndia: oneOf('BGV_PROVIDER_IN', env.BGV_PROVIDER_IN, ['manual'], 'manual'),
    bgvProviderGlobal: oneOf('BGV_PROVIDER_GLOBAL', env.BGV_PROVIDER_GLOBAL, ['manual'], 'manual'),
    bgvWebhookSecret: webhookSecret ?? 'development-only-webhook-secret',
  };
}
