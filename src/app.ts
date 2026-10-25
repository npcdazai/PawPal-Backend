import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import type { PhoneVerifier } from './auth/phoneVerification.ts';
import type { Sessions } from './auth/session.ts';
import type { Config } from './config.ts';
import type { Dispatcher } from './domain/dispatch.ts';
import type { Payments } from './domain/payments.ts';
import type { Subscriptions } from './domain/subscriptions.ts';
import type { Walks } from './domain/walks.ts';
import { HttpError } from './http/errors.ts';
import { requestLog } from './http/requestLog.ts';
import type { Maps } from './maps/osmMaps.ts';
import type { Push } from './push/push.ts';
import { authRoutes } from './routes/auth.ts';
import { bookingRoutes } from './routes/bookings.ts';
import { dashboardRoutes } from './routes/dashboard.ts';
import { deviceRoutes } from './routes/devices.ts';
import { mapRoutes } from './routes/maps.ts';
import { partnerVerificationRoutes } from './routes/partnerVerification.routes.ts';
import { partnerRoutes } from './routes/partners.ts';
import type { PartnerVerification } from './verification/partnerVerificationService.ts';
import type { Store } from './store/store.ts';
import type { Weather } from './weather/openMeteo.ts';

export interface AppDeps {
  config: Config;
  store: Store;
  push: Push;
  sessions: Sessions;
  verifyPhone: PhoneVerifier;
  dispatcher: Dispatcher;
  walks: Walks;
  /** Null when MAPS_ENABLED=false; the map routes then answer 503. */
  maps: Maps | null;
  /** Null without DATABASE_URL; its routes then answer 503. */
  verification: PartnerVerification | null;
  /** Null when payments are off (development): bookings go straight to dispatch. */
  payments: Payments | null;
  subscriptions: Subscriptions;
  /** Current weather for the home screen; missing or null (WEATHER_ENABLED=false, tests) → 503 weather_unavailable. */
  weather?: Weather | null;
  now: () => number;
}

/** Lets the Expo web dev servers call the API; native apps send no Origin header. */
function cors(origins: readonly string[]): RequestHandler {
  return (req, res, next) => {
    const origin = req.get('origin');
    if (origin && origins.includes(origin)) {
      res.set({
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      });
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}

const errors: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  // express.json() rejects bodies that aren't JSON or are too big.
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({ error: { code: 'bad_request', message: 'The request body isn’t valid JSON.' } });
    return;
  }
  // Printed, with its stack, on the request's log line.
  res.locals.error = error;
  res.status(500).json({ error: { code: 'internal', message: 'Something went wrong on our side.' } });
};

export function createApp(deps: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestLog());
  app.use(cors(deps.config.corsOrigins));
  // The raw bytes are kept for webhook signature checks.
  app.use(
    express.json({
      limit: '32kb',
      verify: (req, _res, body) => {
        (req as typeof req & { rawBody?: Buffer }).rawBody = body;
      },
    })
  );

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      store: deps.config.store,
      push: deps.config.push,
      phoneVerification: deps.config.firebase.configured ? 'firebase' : 'dev-only',
      maps: deps.maps ? 'openstreetmap' : 'off',
      verification: deps.verification ? 'on' : 'off',
      payments: deps.payments ? 'youpi' : 'off',
    });
  });

  app.use(authRoutes(deps));
  app.use(deviceRoutes(deps));
  app.use(partnerRoutes(deps));
  app.use(bookingRoutes(deps));
  app.use(dashboardRoutes(deps));
  app.use(mapRoutes(deps));
  app.use(partnerVerificationRoutes(deps));

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'No such endpoint.' } });
  });
  app.use(errors);
  return app;
}
