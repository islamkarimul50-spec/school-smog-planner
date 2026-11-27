import { describe, expect, it } from 'vitest';
import {
  classifyUsAqi,
  computeUsAqiFromPm25,
  evaluateAirQualityStaleness
} from '../src/shared/airQualityUtils.js';
import {
  DEFAULT_HOUSEHOLD_INPUT,
  SAMPLE_AIR_QUALITY_PRESETS
} from '../src/shared/constants.js';
import {
  buildMorningPlan,
  computePlanDiff,
  evaluateBusAvailability
} from '../src/shared/decisionEngine.js';
import type { HouseholdInput } from '../src/shared/types.js';

const SEVERE_DELHI_AQ = SAMPLE_AIR_QUALITY_PRESETS.delhi_severe_winter!;
const CLEAN_AQ = SAMPLE_AIR_QUALITY_PRESETS.clean_morning!;

describe('decisionEngine — School Bus availability & acceptance scenarios', () => {
  it('evaluateBusAvailability accepts Shared School Bus when available, affordable, and on time', () => {
    const busEval = evaluateBusAvailability(
      DEFAULT_HOUSEHOLD_INPUT,
      60,
      SEVERE_DELHI_AQ.pm25UgM3
    );

    expect(busEval.available).toBe(true);
    expect(busEval.feasible).toBe(true);
    expect(busEval.estimatedCostInr).toBe(60);
    expect(busEval.requiredMinutes).toBe(34);
    expect(busEval.recommendedDepartureTime).toBe('07:26');
    expect(busEval.rejectionReasons).toEqual([]);
  });

  it('selects Shared School Bus when available, then switches cleanly when ONLY bus availability changes to false', () => {
    const busAvailablePlan = buildMorningPlan(
      DEFAULT_HOUSEHOLD_INPUT,
      SEVERE_DELHI_AQ
    );

    expect(busAvailablePlan.routineStatus).toBe('FEASIBLE');
    expect(busAvailablePlan.selectedModeId).toBe('schoolBus');
    expect(busAvailablePlan.recommendedDepartureTime).toBe('07:26');
    expect(busAvailablePlan.recommendations.routine.emissionsDifference).toContain(
      'CO2e'
    );
    expect(
      busAvailablePlan.recommendations.routine.personalExposureDifference
    ).toContain('cabin PM2.5');

    const busUnavailableInput: HouseholdInput = {
      ...DEFAULT_HOUSEHOLD_INPUT,
      travelOptions: {
        ...DEFAULT_HOUSEHOLD_INPUT.travelOptions,
        schoolBus: false
      }
    };

    const busEvalAfterToggle = evaluateBusAvailability(
      busUnavailableInput,
      60,
      SEVERE_DELHI_AQ.pm25UgM3
    );
    expect(busEvalAfterToggle.available).toBe(false);
    expect(busEvalAfterToggle.feasible).toBe(false);
    expect(busEvalAfterToggle.rejectionReasons[0]).toContain('unavailable');

    const busUnavailablePlan = buildMorningPlan(
      busUnavailableInput,
      SEVERE_DELHI_AQ
    );

    expect(busUnavailablePlan.routineStatus).toBe('FEASIBLE');
    expect(busUnavailablePlan.selectedModeId).toBe('metroOrPublicTransit');
    expect(busUnavailablePlan.recommendedDepartureTime).toBe('07:18');

    const diff = computePlanDiff(
      {
        selectedModeId: busAvailablePlan.selectedModeId,
        selectedModeLabel: busAvailablePlan.selectedModeLabel,
        recommendedDepartureTime: busAvailablePlan.recommendedDepartureTime,
        allocatedTravelCostInr: busAvailablePlan.allocatedTravelCostInr,
        indoorActionTitle:
          busAvailablePlan.recommendations.indoorAirQuality.title,
        sustainableActionTitle:
          busAvailablePlan.recommendations.sustainableAlternative.title,
        householdInput: DEFAULT_HOUSEHOLD_INPUT
      },
      busUnavailablePlan,
      busUnavailableInput
    );

    expect(diff).not.toBeNull();
    expect(diff?.changedInputs[0]).toContain('Shared School Bus availability: Yes → No');
    expect(diff?.whatChanged[0]).toContain('Shared School Bus');
    expect(diff?.whatChanged[0]).toContain('Metro / Public Transit');
    expect(diff?.whatStayedRelevant.some((s) => s.includes('Indoor Air Quality'))).toBe(
      true
    );
    expect(diff?.whyItChanged).toContain('Shared School Bus');
  });

  it('returns NO_FEASIBLE_OPTION with conflict explanation and prompts when budget/smog/availability leave zero valid modes', () => {
    const noFitInput: HouseholdInput = {
      ...DEFAULT_HOUSEHOLD_INPUT,
      dailyBudget: 150,
      travelOptions: {
        schoolBus: false,
        metroOrPublicTransit: false,
        carpool: false,
        walkOrCycle: true, // Blocked by 245 µg/m³ severe smog & 47 min walk
        privateCar: true // Costs ₹220/day > ₹150 budget
      }
    };

    const plan = buildMorningPlan(noFitInput, SEVERE_DELHI_AQ);

    expect(plan.routineStatus).toBe('NO_FEASIBLE_OPTION');
    expect(plan.selectedModeId).toBeNull();
    expect(plan.conflictExplanation).toContain('Private Car');
    expect(plan.conflictExplanation).toContain('Walk / Cycle');
    expect(plan.constraintChangePrompts.length).toBeGreaterThanOrEqual(2);
    expect(
      plan.constraintChangePrompts.some((p) => p.constraint.includes('Daily budget'))
    ).toBe(true);
  });

  it('returns NO_FEASIBLE_OPTION when morning timing window is too short for any motorized commute', () => {
    const tightTimingInput: HouseholdInput = {
      ...DEFAULT_HOUSEHOLD_INPUT,
      schoolStartTime: '08:00',
      earliestReadyTime: '07:40', // 20-minute window
      commuteDurationMinutes: 30,
      travelOptions: {
        schoolBus: true,
        metroOrPublicTransit: true,
        carpool: true,
        walkOrCycle: false,
        privateCar: true
      }
    };

    const plan = buildMorningPlan(tightTimingInput, SEVERE_DELHI_AQ);

    expect(plan.routineStatus).toBe('NO_FEASIBLE_OPTION');
    expect(
      plan.constraintChangePrompts.some((p) =>
        p.constraint.includes('Morning timing window')
      )
    ).toBe(true);
  });

  it('prioritizes Walk / Cycle on clean air days when duration is within active cap', () => {
    const shortCleanInput: HouseholdInput = {
      ...DEFAULT_HOUSEHOLD_INPUT,
      city: 'Shimla',
      commuteDurationMinutes: 10
    };

    const plan = buildMorningPlan(shortCleanInput, CLEAN_AQ);

    expect(plan.routineStatus).toBe('FEASIBLE');
    expect(plan.selectedModeId).toBe('walkOrCycle');
  });

  it('blocks Walk / Cycle on live-typical Delhi-NCR PM2.5 (72.6 µg/m³, US AQI 210)', () => {
    const liveTypicalAq = {
      ...SEVERE_DELHI_AQ,
      pm25UgM3: 72.6,
      usAqi: 210,
      category: 'Very Unhealthy' as const
    };
    const noFitInput: HouseholdInput = {
      ...DEFAULT_HOUSEHOLD_INPUT,
      commuteDurationMinutes: 10,
      travelOptions: {
        schoolBus: false,
        metroOrPublicTransit: false,
        carpool: false,
        walkOrCycle: true,
        privateCar: true
      }
    };

    const plan = buildMorningPlan(noFitInput, liveTypicalAq);
    expect(plan.routineStatus).toBe('NO_FEASIBLE_OPTION');
    expect(plan.conflictExplanation).toContain('72.6 µg/m³');
  });

  it('tailors indoor air quality recommendation to HEPA ownership vs zero remaining budget', () => {
    const hepaPlan = buildMorningPlan(
      { ...DEFAULT_HOUSEHOLD_INPUT, homePurifier: 'hepa_purifier' },
      SEVERE_DELHI_AQ
    );
    expect(hepaPlan.recommendations.indoorAirQuality.title).toContain('HEPA');

    const zeroRemainderPlan = buildMorningPlan(
      {
        ...DEFAULT_HOUSEHOLD_INPUT,
        dailyBudget: 60, // Exactly consumed by schoolBus (₹60)
        homePurifier: 'none'
      },
      SEVERE_DELHI_AQ
    );
    expect(zeroRemainderPlan.remainingBudgetInr).toBe(0);
    expect(zeroRemainderPlan.recommendations.indoorAirQuality.title).toContain(
      'Zero-Cost'
    );
  });
});

describe('airQualityUtils — 2024 EPA breakpoints & staleness', () => {
  it('computes revised 2024 EPA US AQI breakpoints across Good through Hazardous', () => {
    expect(computeUsAqiFromPm25(0)).toBe(0);
    expect(computeUsAqiFromPm25(8.5)).toBe(47);
    expect(classifyUsAqi(47)).toBe('Good');
    expect(computeUsAqiFromPm25(9.0)).toBe(50);
    expect(computeUsAqiFromPm25(9.1)).toBe(51);
    expect(computeUsAqiFromPm25(35.4)).toBe(100);
    expect(computeUsAqiFromPm25(35.5)).toBe(101);
    expect(computeUsAqiFromPm25(55.4)).toBe(150);
    expect(computeUsAqiFromPm25(55.5)).toBe(151);
    expect(computeUsAqiFromPm25(125.4)).toBe(200);
    expect(computeUsAqiFromPm25(125.5)).toBe(201);
    expect(computeUsAqiFromPm25(225.4)).toBe(300);
    expect(computeUsAqiFromPm25(245)).toBe(340);
    expect(classifyUsAqi(computeUsAqiFromPm25(245))).toBe('Hazardous');
  });

  it('maps exact Hazardous endpoints 225.5 µg/m³ -> AQI 301 and 325.4 µg/m³ -> AQI 500', () => {
    expect(computeUsAqiFromPm25(225.5)).toBe(301);
    expect(computeUsAqiFromPm25(325.4)).toBe(500);
    expect(computeUsAqiFromPm25(325.49)).toBe(500); // EPA truncates PM2.5 to 1 decimal place
  });

  it('extrapolates linearly beyond AQI 500 above 325.4 µg/m³ using Hazardous slope', () => {
    expect(computeUsAqiFromPm25(326.0)).toBe(501);
    expect(computeUsAqiFromPm25(375.5)).toBe(600);
    expect(classifyUsAqi(600)).toBe('Hazardous');
  });

  it('marks readings older than 3 hours as stale', () => {
    const now = Date.parse('2026-11-27T12:00:00.000Z');
    const fourHoursOld = '2026-11-27T08:00:00.000Z';
    const fresh = '2026-11-27T11:30:00.000Z';

    expect(evaluateAirQualityStaleness(fourHoursOld, now).isStale).toBe(true);
    expect(evaluateAirQualityStaleness(fresh, now).isStale).toBe(false);
  });
});
