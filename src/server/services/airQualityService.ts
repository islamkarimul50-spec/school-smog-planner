import {
  classifyUsAqi,
  computeUsAqiFromPm25,
  evaluateAirQualityStaleness
} from '../../shared/airQualityUtils.js';
import type { AirQualityReading } from '../../shared/types.js';

const CACHE_TTL_MS = 15 * 60 * 1000;
const GEOCODE_TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5000;

interface CacheEntry<T> {
  value: T;
  expiresAtMs: number;
}

interface GeoResult {
  name: string;
  country?: string;
  admin1?: string;
  latitude: number;
  longitude: number;
}

const CITY_QUERY_ALIASES: Record<string, string> = {
  'delhi-ncr': 'New Delhi',
  'delhi ncr': 'New Delhi',
  ncr: 'New Delhi'
};

export interface AirQualityFetchOutcome {
  ok: true;
  reading: AirQualityReading;
  cached: boolean;
}

export interface AirQualityFetchError {
  ok: false;
  code: 'NOT_FOUND' | 'UPSTREAM_UNAVAILABLE' | 'INVALID_RESPONSE';
  message: string;
}

export type FetchLike = typeof fetch;

export class AirQualityService {
  private readonly airQualityCache = new Map<string, CacheEntry<AirQualityReading>>();
  private readonly geocodeCache = new Map<string, CacheEntry<GeoResult>>();
  private readonly fetchImpl: FetchLike;
  private readonly nowFn: () => number;

  constructor(options?: { fetchImpl?: FetchLike; nowFn?: () => number }) {
    this.fetchImpl = options?.fetchImpl ?? fetch;
    this.nowFn = options?.nowFn ?? (() => Date.now());
  }

  public clearCache(): void {
    this.airQualityCache.clear();
    this.geocodeCache.clear();
  }

  public normalizeCityQuery(rawCity: string): string {
    const trimmed = rawCity.trim();
    const alias = CITY_QUERY_ALIASES[trimmed.toLowerCase()];
    return alias ?? trimmed;
  }

  public async getAirQualityForCity(
    rawCity: string
  ): Promise<AirQualityFetchOutcome | AirQualityFetchError> {
    const cityKey = rawCity.trim().toLowerCase();
    const nowMs = this.nowFn();

    const cached = this.airQualityCache.get(cityKey);
    if (cached && cached.expiresAtMs > nowMs) {
      const staleness = evaluateAirQualityStaleness(
        cached.value.timestampIso,
        nowMs
      );
      return {
        ok: true,
        cached: true,
        reading: {
          ...cached.value,
          isStale: staleness.isStale,
          staleReason: staleness.staleReason
        }
      };
    }

    const searchName = this.normalizeCityQuery(rawCity);

    let geo: GeoResult | null = null;
    const cachedGeo = this.geocodeCache.get(searchName.toLowerCase());
    if (cachedGeo && cachedGeo.expiresAtMs > nowMs) {
      geo = cachedGeo.value;
    } else {
      const geoOutcome = await this.geocodeCity(searchName);
      if (!geoOutcome.ok) {
        return geoOutcome;
      }
      geo = geoOutcome.geo;
      this.geocodeCache.set(searchName.toLowerCase(), {
        value: geo,
        expiresAtMs: nowMs + GEOCODE_TTL_MS
      });
    }

    const aqUrl = new URL('https://air-quality-api.open-meteo.com/v1/air-quality');
    aqUrl.searchParams.set('latitude', String(geo.latitude));
    aqUrl.searchParams.set('longitude', String(geo.longitude));
    aqUrl.searchParams.set('current', 'pm2_5,pm10,us_aqi');
    aqUrl.searchParams.set('timezone', 'GMT');

    try {
      const response = await this.fetchWithTimeout(aqUrl.toString());
      if (!response.ok) {
        return {
          ok: false,
          code: 'UPSTREAM_UNAVAILABLE',
          message: `Open-Meteo air-quality service returned status ${response.status}. Use a clearly labeled sample dataset or enter a manual reading.`
        };
      }

      const data = (await response.json()) as {
        current?: {
          time?: string;
          pm2_5?: number;
          pm10?: number;
          us_aqi?: number;
        };
      };

      const current = data?.current;
      if (
        !current ||
        typeof current.pm2_5 !== 'number' ||
        Number.isNaN(current.pm2_5)
      ) {
        return {
          ok: false,
          code: 'INVALID_RESPONSE',
          message:
            'Live air-quality response was missing PM2.5 data. Select sample data or enter a local monitor reading.'
        };
      }

      const pm25UgM3 = Math.max(0, Number(current.pm2_5.toFixed(1)));
      const pm10UgM3 =
        typeof current.pm10 === 'number' && !Number.isNaN(current.pm10)
          ? Math.max(0, Number(current.pm10.toFixed(1)))
          : null;
      const usAqi =
        typeof current.us_aqi === 'number' && !Number.isNaN(current.us_aqi)
          ? Math.max(0, Math.round(current.us_aqi))
          : computeUsAqiFromPm25(pm25UgM3);

      const rawTime = current.time ?? new Date(nowMs).toISOString();
      const timestampIso = rawTime.endsWith('Z') || rawTime.includes('+')
        ? rawTime
        : `${rawTime}:00Z`.replace(/:00:00Z$/, ':00Z');
      const normalizedIso = Number.isNaN(Date.parse(timestampIso))
        ? new Date(nowMs).toISOString()
        : new Date(Date.parse(timestampIso)).toISOString();

      const staleness = evaluateAirQualityStaleness(normalizedIso, nowMs);
      const locationParts = [geo.name, geo.admin1, geo.country].filter(Boolean);

      const reading: AirQualityReading = {
        cityQuery: rawCity.trim(),
        resolvedLocation: `${locationParts.join(', ')} (${geo.latitude.toFixed(2)}°, ${geo.longitude.toFixed(2)}°)`,
        pm25UgM3,
        pm10UgM3,
        usAqi,
        category: classifyUsAqi(usAqi),
        source: 'Live · Open-Meteo Air Quality API',
        dataOrigin: 'live',
        timestampIso: normalizedIso,
        isStale: staleness.isStale,
        staleReason: staleness.staleReason,
        units: {
          pm25: 'µg/m³',
          pm10: 'µg/m³',
          usAqi: 'US AQI (0-500+)'
        }
      };

      this.airQualityCache.set(cityKey, {
        value: reading,
        expiresAtMs: nowMs + CACHE_TTL_MS
      });

      return { ok: true, reading, cached: false };
    } catch {
      return {
        ok: false,
        code: 'UPSTREAM_UNAVAILABLE',
        message:
          'Unable to reach Open-Meteo air-quality service within 5 seconds. Select clearly labeled sample data or enter a manual reading.'
      };
    }
  }

  private async geocodeCity(
    searchName: string
  ): Promise<{ ok: true; geo: GeoResult } | AirQualityFetchError> {
    const geoUrl = new URL('https://geocoding-api.open-meteo.com/v1/search');
    geoUrl.searchParams.set('name', searchName);
    geoUrl.searchParams.set('count', '1');
    geoUrl.searchParams.set('language', 'en');
    geoUrl.searchParams.set('format', 'json');

    try {
      const response = await this.fetchWithTimeout(geoUrl.toString());
      if (!response.ok) {
        return {
          ok: false,
          code: 'UPSTREAM_UNAVAILABLE',
          message: `Geocoding service returned status ${response.status}. Select clearly labeled sample data or enter a manual reading.`
        };
      }
      const data = (await response.json()) as { results?: GeoResult[] };
      const first = data?.results?.[0];
      if (
        !first ||
        typeof first.latitude !== 'number' ||
        typeof first.longitude !== 'number'
      ) {
        return {
          ok: false,
          code: 'NOT_FOUND',
          message: `No location matched "${searchName}". Try a nearby major city, select sample data, or enter a manual PM2.5 reading.`
        };
      }
      return { ok: true, geo: first };
    } catch {
      return {
        ok: false,
        code: 'UPSTREAM_UNAVAILABLE',
        message:
          'Unable to reach geocoding service for live air-quality lookup. Select sample data or enter a manual reading.'
      };
    }
  }

  private async fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' }
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
