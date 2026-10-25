import { Router } from 'express';
import { z } from 'zod';
import { requireSession } from '../auth/middleware.ts';
import { notFound, unavailable } from '../http/errors.ts';
import { latitude, longitude, parse } from '../http/validate.ts';
import type { AppDeps } from '../app.ts';

const point = z.object({ lat: z.coerce.number().pipe(latitude), lng: z.coerce.number().pipe(longitude) });

/** "19.1176,72.9060" → { lat, lng } */
const pair = z
  .string()
  .transform((value) => value.split(',').map(Number))
  .pipe(z.tuple([latitude, longitude]))
  .transform(([lat, lng]) => ({ lat, lng }));

const search = z.object({
  input: z.string().trim().min(2).max(200),
  lat: z.coerce.number().pipe(latitude).optional(),
  lng: z.coerce.number().pipe(longitude).optional(),
});

/**
 * Maps behind the API: signed-in users only, answers cached, and the public
 * OpenStreetMap servers' rate limits respected for every app install at once.
 */
export function mapRoutes({ sessions, maps }: AppDeps): Router {
  const router = Router();
  router.use('/maps', requireSession(sessions));

  const osm = () => {
    if (!maps) throw unavailable('maps_unconfigured', 'Maps are turned off on the server (MAPS_ENABLED=false).');
    return maps;
  };

  router.get('/maps/reverse-geocode', async (req, res) => {
    const place = await osm().reverseGeocode(parse(point, req.query));
    if (!place) throw notFound('Address');
    res.json({ place });
  });

  router.get('/maps/geocode', async (req, res) => {
    const { address } = parse(z.object({ address: z.string().trim().min(3).max(300) }), req.query);
    res.json({ places: await osm().geocode(address) });
  });

  router.get('/maps/autocomplete', async (req, res) => {
    const { input, lat, lng } = parse(search, req.query);
    const near = lat !== undefined && lng !== undefined ? { lat, lng } : undefined;
    res.json({ places: await osm().autocomplete(input, near) });
  });

  /** Walking route for the live map: `?from=lat,lng&to=lat,lng` → distance, duration, [lng, lat] line. */
  router.get('/maps/route', async (req, res) => {
    const { from, to } = parse(z.object({ from: pair, to: pair }), req.query);
    const route = await osm().walkingRoute(from, to);
    if (!route) throw notFound('Route');
    res.json({ route });
  });

  return router;
}
