import { AIR_QUALITY_STALE_THRESHOLD_MS } from './constants.js';
import type { AirQualityCategory } from './types.js';

interface Breakpoint {
  cLow: number;
  cHigh: number;
  iLow: number;
  iHigh: number;
  category: AirQualityCategory;
}

/**
 * Revised US EPA PM2.5 24-hour AQI breakpoints (effective May 6, 2024).
 */
const PM25_BREAKPOINTS: Breakpoint[] = [
  { cLow: 0.0, cHigh: 9.0, iLow: 0, iHigh: 50, category: 'Good' },
  { cLow: 9.1, cHigh: 35.4, iLow: 51, iHigh: 100, category: 'Moderate' },
  {
    cLow: 35.5,
    cHigh: 55.4,
    iLow: 101,
    iHigh: 150,
    category: 'Unhealthy for Sensitive Groups'
  },
  { cLow: 55.5, cHigh: 125.4, iLow: 151, iHigh: 200, category: 'Unhealthy' },
  {
    cLow: 125.5,
    cHigh: 225.4,
    iLow: 201,
    iHigh: 300,
    category: 'Very Unhealthy'
  },
  { cLow: 225.5, cHigh: 500.4, iLow: 301, iHigh: 500, category: 'Hazardous' }
];

export function computeUsAqiFromPm25(pm25UgM3: number): number {
  const truncated = Math.floor(Math.max(0, pm25UgM3) * 10) / 10;
  for (const bp of PM25_BREAKPOINTS) {
    if (truncated <= bp.cHigh) {
      const ratio = (bp.iHigh - bp.iLow) / (bp.cHigh - bp.cLow);
      return Math.round(ratio * (truncated - bp.cLow) + bp.iLow);
    }
  }
  return 500;
}

export function classifyUsAqi(usAqi: number): AirQualityCategory {
  if (usAqi <= 50) return 'Good';
  if (usAqi <= 100) return 'Moderate';
  if (usAqi <= 150) return 'Unhealthy for Sensitive Groups';
  if (usAqi <= 200) return 'Unhealthy';
  if (usAqi <= 300) return 'Very Unhealthy';
  return 'Hazardous';
}

export function evaluateAirQualityStaleness(
  timestampIso: string,
  nowMs: number = Date.now()
): { isStale: boolean; staleReason: string | null } {
  const parsedMs = Date.parse(timestampIso);
  if (Number.isNaN(parsedMs)) {
    return {
      isStale: true,
      staleReason: 'Observation timestamp could not be parsed; verify with local monitor or enter a manual reading.'
    };
  }
  const ageMs = nowMs - parsedMs;
  if (ageMs > AIR_QUALITY_STALE_THRESHOLD_MS) {
    const ageHours = Math.round((ageMs / (60 * 60 * 1000)) * 10) / 10;
    return {
      isStale: true,
      staleReason: `Reading is ${ageHours} hours old (exceeds 3-hour freshness threshold). Consider refreshing or entering a manual local monitor reading.`
    };
  }
  return { isStale: false, staleReason: null };
}
