import type { Config } from '../config.ts';
import type { LatLng } from '../domain/types.ts';
import { unavailable } from '../http/errors.ts';
import { logger } from '../log/logger.ts';

const log = logger('weather');

const TIMEOUT_MS = 5_000;
/** A reading is reused for this long per ~1 km cell. */
export const WEATHER_CACHE_MS = 15 * 60_000;
/** After a failed fetch the cell answers "unavailable" for this long instead of asking again. */
const FAILURE_CACHE_MS = 60_000;
const CACHE_MAX = 5_000;

export type WeatherCondition = 'clear' | 'partly-cloudy' | 'cloudy' | 'fog' | 'drizzle' | 'rain' | 'thunderstorm' | 'snow';

export interface WeatherNow {
  /** Whole degrees Celsius. */
  tempC: number;
  condition: WeatherCondition;
  icon: string;
  /** When the server fetched this reading. */
  updatedAt: number;
}

export interface Weather {
  current(at: LatLng): Promise<WeatherNow>;
}

const ICONS: Record<WeatherCondition, string> = {
  clear: '☀️',
  'partly-cloudy': '⛅',
  cloudy: '☁️',
  fog: '🌫️',
  drizzle: '🌦️',
  rain: '🌧️',
  thunderstorm: '⛈️',
  snow: '❄️',
};
const NIGHT_ICONS: Partial<Record<WeatherCondition, string>> = { clear: '🌙', 'partly-cloudy': '☁️' };

/** WMO weather interpretation code (what Open-Meteo reports) → our condition. */
export function conditionFor(code: number): WeatherCondition {
  if (code <= 1) return 'clear';
  if (code === 2) return 'partly-cloudy';
  if (code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 57) return 'drizzle';
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95 && code <= 99) return 'thunderstorm';
  return 'cloudy';
}

export const iconFor = (condition: WeatherCondition, isDay = true) => (isDay ? ICONS[condition] : (NIGHT_ICONS[condition] ?? ICONS[condition]));

/** Lat/lng rounded to 2 decimals: about a 1 km cell, shared by everyone in it. */
const cell = (at: LatLng) => ({ lat: at.lat.toFixed(2), lng: at.lng.toFixed(2) });

const failed = () => unavailable('weather_unavailable', 'Weather isn’t available right now.');

/**
 * Current weather from Open-Meteo's forecast API (no key). Its free tier is for non-commercial use:
 * production needs its paid plan (put the customer URL, with `apikey`, in WEATHER_URL) or another
 * provider behind the same response.
 */
export function createOpenMeteoWeather(
  config: Config['weather'],
  options: { fetch?: typeof fetch; now?: () => number } = {}
): Weather {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; value: WeatherNow | null }>();
  const inFlight = new Map<string, Promise<WeatherNow>>();

  async function load(key: string, point: { lat: string; lng: string }): Promise<WeatherNow> {
    const url = new URL(config.url);
    url.searchParams.set('latitude', point.lat);
    url.searchParams.set('longitude', point.lng);
    url.searchParams.set('current', 'temperature_2m,weather_code,is_day');
    const started = now();
    try {
      const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
      const body = (await response.json()) as { current?: Record<string, unknown> };
      const temperature = body.current?.temperature_2m;
      const code = body.current?.weather_code;
      if (typeof temperature !== 'number' || typeof code !== 'number') throw new Error('No current temperature and weather code in the reply.');
      const condition = conditionFor(code);
      const value: WeatherNow = {
        tempC: Math.round(temperature),
        condition,
        icon: iconFor(condition, body.current?.is_day !== 0),
        updatedAt: now(),
      };
      log.debug('Weather fetched', { cell: key, tempC: value.tempC, condition, ms: now() - started });
      remember(key, value);
      return value;
    } catch (error) {
      // The host only: a paid plan's URL carries its key in the query string.
      log.warn('Weather fetch failed; the app hides the weather', { host: url.host, cell: key, error });
      remember(key, null);
      throw failed();
    }
  }

  function remember(key: string, value: WeatherNow | null) {
    cache.delete(key);
    cache.set(key, { at: now(), value });
    // Map keeps insertion order, so the first key is the oldest.
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  }

  return {
    async current(at) {
      const point = cell(at);
      const key = `${point.lat},${point.lng}`;
      const hit = cache.get(key);
      if (hit && now() - hit.at < (hit.value ? WEATHER_CACHE_MS : FAILURE_CACHE_MS)) {
        if (!hit.value) throw failed();
        return hit.value;
      }
      // Everyone asking about one cell at once shares one request.
      let pending = inFlight.get(key);
      if (!pending) {
        pending = load(key, point).finally(() => inFlight.delete(key));
        inFlight.set(key, pending);
      }
      return pending;
    },
  };
}
