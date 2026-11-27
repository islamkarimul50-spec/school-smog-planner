import { Router } from 'express';
import {
  classifyUsAqi,
  computeUsAqiFromPm25,
  evaluateAirQualityStaleness
} from '../../shared/airQualityUtils.js';
import { SAMPLE_AIR_QUALITY_PRESETS } from '../../shared/constants.js';
import { ManualAirQualityInputSchema } from '../../shared/validation.js';
import type { AirQualityService } from '../services/airQualityService.js';

export function createAirQualityRouter(
  airQualityService: AirQualityService
): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const rawCity =
      typeof req.query.city === 'string' ? req.query.city.trim() : '';

    if (rawCity.length < 2 || rawCity.length > 80) {
      res.status(400).json({
        status: 'invalid',
        error: 'City query parameter must be between 2 and 80 characters.'
      });
      return;
    }

    const result = await airQualityService.getAirQualityForCity(rawCity);
    if (!result.ok) {
      res.status(result.code === 'NOT_FOUND' ? 404 : 503).json({
        status: 'unavailable',
        code: result.code,
        error: result.message,
        samplePresets: Object.entries(SAMPLE_AIR_QUALITY_PRESETS).map(
          ([key, value]) => ({ key, reading: value })
        )
      });
      return;
    }

    res.json({
      status: 'ok',
      cached: result.cached,
      airQuality: result.reading
    });
  });

  router.get('/samples', (_req, res) => {
    res.json({
      samples: Object.entries(SAMPLE_AIR_QUALITY_PRESETS).map(
        ([key, reading]) => ({ key, reading })
      )
    });
  });

  router.post('/manual', (req, res) => {
    const parsed = ManualAirQualityInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        status: 'invalid',
        error: parsed.error.issues[0]?.message ?? 'Invalid manual air-quality reading.',
        fieldErrors: parsed.error.flatten().fieldErrors
      });
      return;
    }

    const { city, pm25UgM3 } = parsed.data;
    const roundedPm25 = Number(pm25UgM3.toFixed(1));
    const usAqi = computeUsAqiFromPm25(roundedPm25);
    const timestampIso = new Date().toISOString();
    const staleness = evaluateAirQualityStaleness(timestampIso);

    res.json({
      status: 'ok',
      airQuality: {
        cityQuery: city,
        resolvedLocation: `${city} (Manual Parent Entry)`,
        pm25UgM3: roundedPm25,
        pm10UgM3: null,
        usAqi,
        category: classifyUsAqi(usAqi),
        source: 'Manual · Parent-Entered Local Reading',
        dataOrigin: 'manual',
        timestampIso,
        isStale: staleness.isStale,
        staleReason: staleness.staleReason,
        units: {
          pm25: 'µg/m³',
          pm10: 'µg/m³',
          usAqi: 'US AQI (0-500+)'
        }
      }
    });
  });

  return router;
}
