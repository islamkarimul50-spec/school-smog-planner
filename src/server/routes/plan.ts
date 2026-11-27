import { Router } from 'express';
import { evaluateAirQualityStaleness } from '../../shared/airQualityUtils.js';
import { buildMorningPlan, computePlanDiff } from '../../shared/decisionEngine.js';
import { PlanRequestSchema } from '../../shared/validation.js';
import type { AirQualityService } from '../services/airQualityService.js';
import type { GeminiCoachService } from '../services/geminiService.js';

export function createPlanRouter(
  airQualityService: AirQualityService,
  geminiService: GeminiCoachService
): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    const parsed = PlanRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error:
          parsed.error.issues[0]?.message ??
          'Invalid household inputs for morning plan.',
        fieldErrors: parsed.error.flatten().fieldErrors
      });
      return;
    }

    const { householdInput, airQuality: suppliedAq, previousPlanSummary } =
      parsed.data;

    let activeAirQuality = suppliedAq;

    if (
      !activeAirQuality ||
      activeAirQuality.cityQuery.trim().toLowerCase() !==
        householdInput.city.trim().toLowerCase()
    ) {
      // Only fetch live AQ if caller didn't provide an active snapshot for this city
      // (and sample/manual readings explicitly chosen by the parent are preserved).
      if (!activeAirQuality || activeAirQuality.dataOrigin === 'live') {
        const fetched = await airQualityService.getAirQualityForCity(
          householdInput.city
        );
        if (!fetched.ok) {
          res.status(fetched.code === 'NOT_FOUND' ? 404 : 503).json({
            error: fetched.message,
            code: fetched.code
          });
          return;
        }
        activeAirQuality = fetched.reading;
      }
    }

    const staleness =
      activeAirQuality.dataOrigin === 'sample'
        ? { isStale: activeAirQuality.isStale, staleReason: activeAirQuality.staleReason }
        : evaluateAirQualityStaleness(activeAirQuality.timestampIso);

    const normalizedAq = {
      ...activeAirQuality,
      isStale: staleness.isStale,
      staleReason: staleness.staleReason
    };

    const plan = buildMorningPlan(householdInput, normalizedAq);
    const diff = computePlanDiff(previousPlanSummary, plan, householdInput);
    const aiExplanation = await geminiService.explainMorningPlan(
      householdInput,
      plan,
      diff
    );

    res.json({
      plan,
      diff,
      aiExplanation
    });
  });

  return router;
}
