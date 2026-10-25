import type { Config } from '../config.ts';
import type { LatLng } from '../domain/types.ts';
import { HttpError } from '../http/errors.ts';
import { logger } from '../log/logger.ts';

const log = logger('maps');

const TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 2_000;
/** Nominatim's public server allows one request a second; queue for at most this long. */
const MAX_QUEUE_MS = 5_000;

export interface Place {
  name: string;
  address: string;
  lat: number;
  lng: number;
  /** "N123" / "W456" / "R789" (OpenStreetMap node / way / relation). */
  placeId: string | null;
}

export interface WalkingRoute {
  distanceMeters: number;
  durationSeconds: number;
  /** [lng, lat] pairs (GeoJSON order), ready for a MapLibre line. */
  coordinates: [number, number][];
}

export interface Maps {
  reverseGeocode(at: LatLng): Promise<Place | null>;
  geocode(address: string): Promise<Place[]>;
  autocomplete(input: string, near?: LatLng): Promise<Place[]>;
  walkingRoute(from: LatLng, to: LatLng): Promise<WalkingRoute | null>;
}

type Json = Record<string, unknown>;

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const num = (value: unknown) => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
};
const list = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : []);
const join = (...parts: string[]) => [...new Set(parts.filter(Boolean))].join(', ');
const osmId = (type: unknown, id: unknown) => {
  const kind = text(type).charAt(0).toUpperCase();
  return kind && id !== undefined && id !== null ? `${kind}${String(id)}` : null;
};

/** A Nominatim jsonv2 result → Place. */
function fromNominatim(result: Json): Place | null {
  const lat = num(result.lat);
  const lng = num(result.lon);
  if (lat === null || lng === null) return null;
  const address = (result.address ?? {}) as Record<string, unknown>;
  // Buildings can carry several numbers ("477;479;481"): keep the first.
  const house = text(address.house_number).split(/[;,]/)[0]?.trim() ?? '';
  const street = text(address.road) || text(address.pedestrian) || text(address.footway);
  const display = text(result.display_name);
  return {
    name: text(result.name) || [house, street].filter(Boolean).join(' ') || display.split(',')[0] || 'Dropped pin',
    address: display,
    lat,
    lng,
    placeId: osmId(result.osm_type, result.osm_id),
  };
}

/** A Photon GeoJSON feature → Place. */
function fromPhoton(feature: Json): Place | null {
  const coordinates = (feature.geometry as Json | undefined)?.coordinates;
  const lng = Array.isArray(coordinates) ? num(coordinates[0]) : null;
  const lat = Array.isArray(coordinates) ? num(coordinates[1]) : null;
  if (lat === null || lng === null) return null;
  const p = (feature.properties ?? {}) as Record<string, unknown>;
  const street = [text(p.housenumber), text(p.street)].filter(Boolean).join(' ');
  const name = text(p.name) || street;
  return {
    name: name || text(p.city) || 'Place',
    address: join(name, street, text(p.district), text(p.locality), text(p.city), text(p.state), text(p.postcode)),
    lat,
    lng,
    placeId: osmId(p.osm_type, p.osm_id),
  };
}

/**
 * OpenStreetMap services, all free: Nominatim (addresses), Photon (search as
 * you type, which Nominatim's policy forbids) and OSRM with the foot profile
 * (walking routes). The public servers are run by volunteers, so answers are
 * cached for a day and Nominatim calls are spaced a second apart; point the
 * URLs at your own instances for real traffic.
 */
export function createOsmMaps(
  config: Config['maps'],
  options: { fetch?: typeof fetch; nominatimGapMs?: number } = {}
): Maps {
  const fetchImpl = options.fetch ?? fetch;
  const gapMs = options.nominatimGapMs ?? 1_100;
  const cache = new Map<string, { at: number; value: unknown }>();
  let nextNominatimSlot = 0;

  async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
    const value = await load();
    cache.delete(key);
    cache.set(key, { at: Date.now(), value });
    // Map keeps insertion order, so the first key is the oldest.
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
    return value;
  }

  /** Waits for Nominatim's next free one-second slot, or refuses if the queue is too long. */
  async function nominatimSlot() {
    const at = Date.now();
    const wait = Math.max(0, nextNominatimSlot - at);
    if (wait > MAX_QUEUE_MS) throw new HttpError(503, 'maps_busy', 'Address lookup is busy. Try again in a moment.');
    nextNominatimSlot = Math.max(at, nextNominatimSlot) + gapMs;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }

  async function getJson(url: URL): Promise<unknown> {
    const started = Date.now();
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { 'User-Agent': config.userAgent, Accept: 'application/json', 'Accept-Language': 'en' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      log.error(`${url.host} unreachable`, { path: url.pathname, error });
      throw new HttpError(502, 'maps_unavailable', 'Maps are unavailable right now. Try again.');
    }
    log.debug(`${url.host} answered`, { path: url.pathname, status: response.status, ms: Date.now() - started });
    if (!response.ok) {
      log.error(`${url.host} refused`, { path: url.pathname, status: response.status });
      throw new HttpError(
        response.status === 429 ? 503 : 502,
        'maps_unavailable',
        'Maps are unavailable right now. Try again.'
      );
    }
    return response.json();
  }

  const url = (base: string, path: string, params: Record<string, string | undefined>) => {
    const target = new URL(base.replace(/\/+$/, '') + path);
    for (const [key, value] of Object.entries(params)) if (value !== undefined) target.searchParams.set(key, value);
    return target;
  };
  const fixed = (value: number) => value.toFixed(5);

  return {
    reverseGeocode(at) {
      const target = url(config.nominatimUrl, '/reverse', {
        format: 'jsonv2',
        lat: fixed(at.lat),
        lon: fixed(at.lng),
        zoom: '18',
        addressdetails: '1',
      });
      return cached(target.href, async () => {
        await nominatimSlot();
        const body = (await getJson(target)) as Json;
        return body.error ? null : fromNominatim(body);
      });
    },

    geocode(address) {
      const target = url(config.nominatimUrl, '/search', {
        format: 'jsonv2',
        q: address,
        limit: '5',
        addressdetails: '1',
        countrycodes: config.countryCode ?? undefined,
      });
      return cached(target.href, async () => {
        await nominatimSlot();
        return list(await getJson(target))
          .map(fromNominatim)
          .filter((place) => place !== null);
      });
    },

    autocomplete(input, near) {
      const target = url(config.photonUrl, '/api/', {
        q: input,
        limit: '8',
        lang: 'en',
        lat: near ? fixed(near.lat) : undefined,
        lon: near ? fixed(near.lng) : undefined,
      });
      return cached(target.href, async () => {
        const body = (await getJson(target)) as Json;
        const country = config.countryCode?.toUpperCase();
        return list(body.features)
          .filter((feature) => !country || text((feature.properties as Json | undefined)?.countrycode).toUpperCase() === country)
          .map(fromPhoton)
          .filter((place) => place !== null)
          .slice(0, 6);
      });
    },

    walkingRoute(from, to) {
      const path = `/${fixed(from.lng)},${fixed(from.lat)};${fixed(to.lng)},${fixed(to.lat)}`;
      const target = url(config.osrmFootUrl, path, { overview: 'full', geometries: 'geojson' });
      return cached(target.href, async () => {
        const body = (await getJson(target)) as Json;
        const route = body.code === 'Ok' ? list(body.routes)[0] : undefined;
        const line = list((route?.geometry as Json | undefined)?.coordinates as unknown);
        if (!route || line.length < 2) return null;
        return {
          distanceMeters: Math.round(num(route.distance) ?? 0),
          durationSeconds: Math.round(num(route.duration) ?? 0),
          coordinates: (line as unknown as [number, number][]).map(([lng, lat]) => [lng, lat] as [number, number]),
        };
      });
    },
  };
}
