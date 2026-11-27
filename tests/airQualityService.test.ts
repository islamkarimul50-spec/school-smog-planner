import { describe, expect, it, vi } from 'vitest';
import { AirQualityService } from '../src/server/services/airQualityService.js';

describe('AirQualityService (mocked upstream fetch)', () => {
  it('resolves Delhi-NCR alias, returns source/timestamp/units, and serves cached repeats without duplicate fetch calls', async () => {
    const fixedNow = Date.parse('2026-11-27T08:30:00.000Z');
    const mockFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('geocoding-api.open-meteo.com')) {
        return new Response(
          JSON.stringify({
            results: [
              {
                name: 'New Delhi',
                admin1: 'Delhi',
                country: 'India',
                latitude: 28.6139,
                longitude: 77.209
              }
            ]
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          current: {
            time: '2026-11-27T08:00',
            pm2_5: 238.4,
            pm10: 340.2,
            us_aqi: 288
          }
        }),
        { status: 200 }
      );
    });

    const service = new AirQualityService({
      fetchImpl: mockFetch as typeof fetch,
      nowFn: () => fixedNow
    });

    const first = await service.getAirQualityForCity('Delhi-NCR');
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.cached).toBe(false);
      expect(first.reading.pm25UgM3).toBe(238.4);
      expect(first.reading.usAqi).toBe(288);
      expect(first.reading.units.pm25).toBe('µg/m³');
      expect(first.reading.source).toContain('Open-Meteo');
      expect(first.reading.isStale).toBe(false);
    }
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const second = await service.getAirQualityForCity('Delhi-NCR');
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.cached).toBe(true);
    }
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('flags stale Open-Meteo timestamps older than 3 hours', async () => {
    const fixedNow = Date.parse('2026-11-27T12:00:00.000Z');
    const mockFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('geocoding-api.open-meteo.com')) {
        return new Response(
          JSON.stringify({
            results: [{ name: 'Delhi', latitude: 28.61, longitude: 77.21 }]
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          current: {
            time: '2026-11-27T06:00',
            pm2_5: 190,
            us_aqi: 240
          }
        }),
        { status: 200 }
      );
    });

    const service = new AirQualityService({
      fetchImpl: mockFetch as typeof fetch,
      nowFn: () => fixedNow
    });

    const result = await service.getAirQualityForCity('Delhi');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reading.isStale).toBe(true);
      expect(result.reading.staleReason).toContain('hours old');
    }
  });

  it('returns clean UPSTREAM_UNAVAILABLE error when Open-Meteo fails', async () => {
    const mockFetch = vi.fn(async () => new Response('Bad Gateway', { status: 502 }));
    const service = new AirQualityService({
      fetchImpl: mockFetch as typeof fetch
    });

    const result = await service.getAirQualityForCity('Delhi-NCR');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('UPSTREAM_UNAVAILABLE');
      expect(result.message).toContain('sample');
    }
  });

  it('returns NOT_FOUND, INVALID_RESPONSE, and network-timeout errors cleanly', async () => {
    const emptyGeoService = new AirQualityService({
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 })) as typeof fetch
    });
    const notFound = await emptyGeoService.getAirQualityForCity('Atlantis');
    expect(notFound.ok).toBe(false);
    if (!notFound.ok) expect(notFound.code).toBe('NOT_FOUND');

    const malformedAqService = new AirQualityService({
      fetchImpl: vi.fn(async (input: string | URL | Request) => {
        if (String(input).includes('geocoding')) {
          return new Response(
            JSON.stringify({ results: [{ name: 'Delhi', latitude: 28.6, longitude: 77.2 }] }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ current: {} }), { status: 200 });
      }) as typeof fetch
    });
    const invalidRes = await malformedAqService.getAirQualityForCity('Delhi');
    expect(invalidRes.ok).toBe(false);
    if (!invalidRes.ok) expect(invalidRes.code).toBe('INVALID_RESPONSE');

    const abortService = new AirQualityService({
      fetchImpl: vi.fn(async () => {
        throw new DOMException('Aborted', 'AbortError');
      }) as typeof fetch
    });
    const timedOut = await abortService.getAirQualityForCity('Delhi');
    expect(timedOut.ok).toBe(false);
    if (!timedOut.ok) expect(timedOut.code).toBe('UPSTREAM_UNAVAILABLE');
  });
});
