import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { HttpError } from '../src/http/errors.ts';
import { createOsmMaps } from '../src/maps/osmMaps.ts';

const config = loadConfig({ NODE_ENV: 'test', MAPS_USER_AGENT: 'PawPal-Test/1.0' }).maps;
const POWAI = { lat: 19.1176, lng: 72.906 };

/** Answers each request from `routes` by host + path, recording what was asked. */
function fakeFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: { url: URL; headers: Record<string, string> }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const key = Object.keys(routes).find((prefix) => `${url.host}${url.pathname}`.startsWith(prefix));
    const answer = key ? routes[key]! : { status: 404, body: {} };
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  }) as typeof fetch;
  return { impl, calls };
}

describe('OpenStreetMap maps', () => {
  test('reverse geocoding asks Nominatim politely and caches the answer', async () => {
    const { impl, calls } = fakeFetch({
      'nominatim.openstreetmap.org/reverse': {
        body: {
          lat: '19.11762',
          lon: '72.90601',
          osm_type: 'way',
          osm_id: 123,
          name: '',
          display_name: 'Tower B, Hiranandani Gardens, Powai, Mumbai, Maharashtra, India',
          address: { house_number: '12;14', road: 'Central Avenue' },
        },
      },
    });
    const maps = createOsmMaps(config, { fetch: impl, nominatimGapMs: 0 });

    const place = await maps.reverseGeocode(POWAI);
    assert.deepEqual(place, {
      name: '12 Central Avenue',
      address: 'Tower B, Hiranandani Gardens, Powai, Mumbai, Maharashtra, India',
      lat: 19.11762,
      lng: 72.90601,
      placeId: 'W123',
    });
    assert.equal(calls[0]?.url.searchParams.get('format'), 'jsonv2');
    assert.equal(calls[0]?.url.searchParams.get('lat'), '19.11760');
    assert.equal(calls[0]?.headers['User-Agent'], 'PawPal-Test/1.0');

    await maps.reverseGeocode(POWAI);
    assert.equal(calls.length, 1, 'second lookup should come from the cache');
  });

  test('search-as-you-type uses Photon, near the user, India only', async () => {
    const feature = (name: string, countrycode: string) => ({
      geometry: { coordinates: [72.91, 19.12] },
      properties: { name, street: 'Hiranandani Gardens', city: 'Mumbai', state: 'Maharashtra', countrycode, osm_type: 'N', osm_id: 9 },
    });
    const { impl, calls } = fakeFetch({
      'photon.komoot.io/api': { body: { features: [feature('Galleria Mall', 'IN'), feature('Galleria Mall', 'CA')] } },
    });
    const places = await createOsmMaps(config, { fetch: impl }).autocomplete('galleria', POWAI);
    assert.equal(places.length, 1);
    assert.deepEqual(places[0], {
      name: 'Galleria Mall',
      address: 'Galleria Mall, Hiranandani Gardens, Mumbai, Maharashtra',
      lat: 19.12,
      lng: 72.91,
      placeId: 'N9',
    });
    assert.equal(calls[0]?.url.searchParams.get('lat'), '19.11760');
  });

  test('walking routes come from the OSRM foot profile as [lng, lat] lines', async () => {
    const { impl, calls } = fakeFetch({
      'routing.openstreetmap.de/routed-foot/route/v1/driving': {
        body: {
          code: 'Ok',
          routes: [{ distance: 812.4, duration: 584.9, geometry: { coordinates: [[72.906, 19.1176], [72.9071, 19.1203]] } }],
        },
      },
    });
    const route = await createOsmMaps(config, { fetch: impl }).walkingRoute(POWAI, { lat: 19.1203, lng: 72.9071 });
    assert.deepEqual(route, {
      distanceMeters: 812,
      durationSeconds: 585,
      coordinates: [
        [72.906, 19.1176],
        [72.9071, 19.1203],
      ],
    });
    assert.match(calls[0]!.url.pathname, /\/72\.90600,19\.11760;72\.90710,19\.12030$/);
  });

  test('a rate-limited server becomes a 503 the app can retry', async () => {
    const { impl } = fakeFetch({ 'photon.komoot.io/api': { status: 429, body: {} } });
    await assert.rejects(createOsmMaps(config, { fetch: impl }).autocomplete('powai'), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 503);
      assert.equal(error.code, 'maps_unavailable');
      return true;
    });
  });
});
