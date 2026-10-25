import { Router } from 'express';
import { z } from 'zod';
import { requireSession, sessionOf } from '../auth/middleware.ts';
import { priceList } from '../domain/pricing.ts';
import { unavailable } from '../http/errors.ts';
import { latitude, longitude, parse } from '../http/validate.ts';
import type { AppDeps } from '../app.ts';

const point = { lat: z.coerce.number().pipe(latitude), lng: z.coerce.number().pipe(longitude) };

const nearbyQuery = z.object({ ...point, temperament: z.enum(['friendly', 'pulls', 'reactive']).optional() });

/** The pet parent's home screen: prices, walkers around, and the weather (docs/DASHBOARD_API.md). */
export function dashboardRoutes({ sessions, dispatcher, weather, now }: AppDeps): Router {
  const router = Router();

  /** Public: what each walk costs at `at` (default now). */
  router.get('/pricing', (req, res) => {
    const { at } = parse(z.object({ at: z.coerce.number().int().positive().optional() }), req.query);
    res.json(priceList(at ?? now()));
  });

  router.use(['/walkers', '/weather'], requireSession(sessions, 'customer'));

  /** How many walkers are around a place, and when one could arrive; never who or where. */
  router.get('/walkers/nearby', async (req, res) => {
    const { lat, lng, temperament } = parse(nearbyQuery, req.query);
    res.json(await dispatcher.availability({ lat, lng }, { temperament, excludeUserId: sessionOf(res).userId }));
  });

  router.get('/weather', async (req, res) => {
    const at = parse(z.object(point), req.query);
    if (!weather) throw unavailable('weather_unavailable', 'Weather isn’t available right now.');
    res.json(await weather.current(at));
  });

  return router;
}
