import {
  ASSUMED_MOTORIZED_SPEED_KM_PER_HOUR,
  IAQ_ACTION_COSTS_INR,
  INR_PER_USD,
  PM25_ACTIVE_COMMUTE_CAP_UG_M3,
  PM25_MASK_RECOMMENDED_UG_M3,
  PM25_SENSITIVE_ACTIVE_CAP_UG_M3,
  SOLO_CAR_EMISSION_KG_PER_KM,
  TRAVEL_MODE_ORDER,
  TRAVEL_MODE_SPECS,
  convertCurrencyToInr,
  formatCurrencyFromInr
} from './constants.js';
import type {
  AirQualityReading,
  AssumptionEntry,
  BudgetCurrency,
  ConstraintConflictOption,
  HouseholdInput,
  MorningPlan,
  PlanDiff,
  RecommendationBlock,
  TravelModeId,
  TravelOptionEvaluation
} from './types.js';
import { formatMinutesToTime, parseTimeToMinutes } from './validation.js';

export interface PreviousPlanSummaryInput {
  selectedModeId: TravelModeId | null;
  selectedModeLabel: string | null;
  recommendedDepartureTime: string | null;
  allocatedTravelCostInr: number;
  indoorActionTitle: string;
  sustainableActionTitle: string;
  householdInput: HouseholdInput;
}

/**
 * Shared constraint evaluator for any travel mode. All budget, timing, and smog-safety
 * limits live here so variants follow one deterministic code path.
 */
function checkTravelConstraints(
  modeId: TravelModeId,
  input: HouseholdInput,
  availableWindowMinutes: number,
  pm25UgM3: number
): TravelOptionEvaluation {
  const spec = TRAVEL_MODE_SPECS[modeId];
  const available = input.travelOptions[modeId];
  const dailyBudgetInr = convertCurrencyToInr(input.dailyBudget, input.budgetCurrency);
  const schoolStartMins = parseTimeToMinutes(input.schoolStartTime);

  const requiredMinutes =
    Math.round(input.commuteDurationMinutes * spec.durationMultiplier) +
    spec.boardingBufferMinutes;

  const estimatedOneWayDistanceKm =
    (input.commuteDurationMinutes / 60) * ASSUMED_MOTORIZED_SPEED_KM_PER_HOUR;
  const roundTripKm = estimatedOneWayDistanceKm * 2;
  const emissionsKgCo2ePerRoundTrip = Number(
    (roundTripKm * spec.emissionsKgCo2ePerStudentKm).toFixed(2)
  );
  const soloCarEmissions = roundTripKm * SOLO_CAR_EMISSION_KG_PER_KM;
  const co2eSavedVsSoloCarKg = Number(
    Math.max(0, soloCarEmissions - emissionsKgCo2ePerRoundTrip).toFixed(2)
  );

  const rejectionReasons: string[] = [];

  if (!available) {
    rejectionReasons.push(
      `${spec.label} is marked unavailable ("No") in household travel options.`
    );
  }

  if (spec.costInr > dailyBudgetInr) {
    const gapInr = spec.costInr - dailyBudgetInr;
    rejectionReasons.push(
      `Cost ${formatCurrencyFromInr(spec.costInr, input.budgetCurrency)} exceeds daily budget ${formatCurrencyFromInr(dailyBudgetInr, input.budgetCurrency)} by ${formatCurrencyFromInr(gapInr, input.budgetCurrency)}.`
    );
  }

  if (requiredMinutes > availableWindowMinutes) {
    rejectionReasons.push(
      `Needs ${requiredMinutes} min door-to-door, which exceeds the ${availableWindowMinutes} min window between ${input.earliestReadyTime} ready time and ${input.schoolStartTime} start.`
    );
  }

  if (spec.maxSafePm25UgM3 !== null) {
    const effectiveCap = input.childHasAsthmaOrSensitivity
      ? PM25_SENSITIVE_ACTIVE_CAP_UG_M3
      : spec.maxSafePm25UgM3;
    if (pm25UgM3 > effectiveCap) {
      rejectionReasons.push(
        `Outdoor PM2.5 (${pm25UgM3.toFixed(1)} µg/m³) exceeds the child active-commute safety cap (${effectiveCap.toFixed(1)} µg/m³).`
      );
    }
  }

  if (
    spec.maxSafeDurationMinutes !== null &&
    requiredMinutes > spec.maxSafeDurationMinutes
  ) {
    rejectionReasons.push(
      `Active commute (${requiredMinutes} min) exceeds ${spec.maxSafeDurationMinutes} min urban roadside exertion cap.`
    );
  }

  const feasible = rejectionReasons.length === 0;
  const recommendedDepartureTime = feasible
    ? formatMinutesToTime(schoolStartMins - requiredMinutes)
    : null;

  const exposureRiskLevel = computeExposureRiskLevel(
    spec.enclosedCabin,
    pm25UgM3
  );

  return {
    modeId,
    label: spec.label,
    available,
    feasible,
    estimatedCostInr: spec.costInr,
    estimatedCostDisplay: formatCurrencyFromInr(spec.costInr, input.budgetCurrency),
    requiredMinutes,
    recommendedDepartureTime,
    rejectionReasons,
    emissionsKgCo2ePerRoundTrip,
    co2eSavedVsSoloCarKg,
    exposureRiskLevel,
    personalExposureSummary: spec.exposureNotes,
    emissionsSummary: spec.emissionsNotes
  };
}

/**
 * Evaluates school bus availability, budget fit, and morning timing constraints.
 * Referenced directly in the README and regression tests.
 */
export function evaluateBusAvailability(
  input: HouseholdInput,
  availableWindowMinutes: number,
  pm25UgM3: number
): TravelOptionEvaluation {
  return checkTravelConstraints(
    'schoolBus',
    input,
    availableWindowMinutes,
    pm25UgM3
  );
}

export function evaluateAllTravelOptions(
  input: HouseholdInput,
  availableWindowMinutes: number,
  pm25UgM3: number
): TravelOptionEvaluation[] {
  return TRAVEL_MODE_ORDER.map((modeId) =>
    modeId === 'schoolBus'
      ? evaluateBusAvailability(input, availableWindowMinutes, pm25UgM3)
      : checkTravelConstraints(modeId, input, availableWindowMinutes, pm25UgM3)
  );
}

function computeExposureRiskLevel(
  enclosedCabin: boolean,
  pm25UgM3: number
): 'Low' | 'Moderate' | 'High' {
  if (pm25UgM3 <= 35.4) {
    return 'Low';
  }
  if (!enclosedCabin && pm25UgM3 > 55.4) {
    return 'High';
  }
  if (pm25UgM3 > 125.4) {
    return enclosedCabin ? 'Moderate' : 'High';
  }
  return 'Moderate';
}

function selectBestTravelOption(
  evaluations: TravelOptionEvaluation[],
  pm25UgM3: number
): TravelOptionEvaluation | null {
  const feasible = evaluations.filter((item) => item.feasible);
  if (feasible.length === 0) {
    return null;
  }

  const isPollutedMorning = pm25UgM3 > PM25_ACTIVE_COMMUTE_CAP_UG_M3 - 34.6; // > 55.4 µg/m³
  feasible.sort((a, b) => {
    const specA = TRAVEL_MODE_SPECS[a.modeId];
    const specB = TRAVEL_MODE_SPECS[b.modeId];
    const rankA = isPollutedMorning ? specA.smogPriority : specA.cleanAirPriority;
    const rankB = isPollutedMorning ? specB.smogPriority : specB.cleanAirPriority;
    return rankA - rankB;
  });

  return feasible[0] ?? null;
}

function buildConstraintConflictPrompts(
  input: HouseholdInput,
  evaluations: TravelOptionEvaluation[],
  availableWindowMinutes: number,
  pm25UgM3: number
): ConstraintConflictOption[] {
  const prompts: ConstraintConflictOption[] = [];
  const dailyBudgetInr = convertCurrencyToInr(input.dailyBudget, input.budgetCurrency);

  const busEval = evaluations.find((e) => e.modeId === 'schoolBus');
  if (busEval && !busEval.available && busEval.estimatedCostInr <= dailyBudgetInr && busEval.requiredMinutes <= availableWindowMinutes) {
    prompts.push({
      constraint: 'Travel availability (School Bus)',
      suggestion: `Enable School Bus (${busEval.estimatedCostDisplay}, ${busEval.requiredMinutes} min) if a route serves your stop.`
    });
  }

  const sharedAlternative = evaluations.find(
    (e) =>
      (e.modeId === 'carpool' || e.modeId === 'metroOrPublicTransit') &&
      !e.available &&
      e.estimatedCostInr <= dailyBudgetInr &&
      e.requiredMinutes <= availableWindowMinutes
  );
  if (sharedAlternative) {
    prompts.push({
      constraint: `Travel availability (${sharedAlternative.label})`,
      suggestion: `Coordinate ${sharedAlternative.label} (${sharedAlternative.estimatedCostDisplay}, needs ${sharedAlternative.requiredMinutes} min).`
    });
  }

  const budgetBlocked = evaluations
    .filter(
      (e) =>
        e.available &&
        e.estimatedCostInr > dailyBudgetInr &&
        e.requiredMinutes <= availableWindowMinutes
    )
    .sort((a, b) => a.estimatedCostInr - b.estimatedCostInr);

  if (budgetBlocked[0]) {
    const gapInr = budgetBlocked[0].estimatedCostInr - dailyBudgetInr;
    prompts.push({
      constraint: 'Daily budget',
      suggestion: `Increase daily budget by ${formatCurrencyFromInr(gapInr, input.budgetCurrency)} (to ${budgetBlocked[0].estimatedCostDisplay}) to unlock ${budgetBlocked[0].label}.`
    });
  }

  const timingBlocked = evaluations
    .filter((e) => e.available && e.estimatedCostInr <= dailyBudgetInr && e.requiredMinutes > availableWindowMinutes)
    .sort((a, b) => a.requiredMinutes - b.requiredMinutes);

  if (timingBlocked[0]) {
    const extraMinutesNeeded = timingBlocked[0].requiredMinutes - availableWindowMinutes;
    const newReadyTime = formatMinutesToTime(
      parseTimeToMinutes(input.earliestReadyTime) - extraMinutesNeeded
    );
    prompts.push({
      constraint: 'Morning timing window',
      suggestion: `Leave ${extraMinutesNeeded} min earlier (by ${newReadyTime}) so ${timingBlocked[0].label} (${timingBlocked[0].requiredMinutes} min) reaches school before ${input.schoolStartTime}.`
    });
  }

  if (pm25UgM3 > PM25_ACTIVE_COMMUTE_CAP_UG_M3) {
    prompts.push({
      constraint: 'School schedule / smog advisory',
      suggestion: `With PM2.5 at ${pm25UgM3.toFixed(1)} µg/m³, ask the school about remote smog-day learning or a delayed morning bell while arranging enclosed transport.`
    });
  }

  if (prompts.length === 0) {
    prompts.push({
      constraint: 'Available travel modes',
      suggestion:
        'Enable at least one enclosed travel option (School Bus, Metro/Transit, Carpool, or Private Car) and confirm budget and departure time.'
    });
  }

  return prompts.slice(0, 4);
}

function buildSharedDistanceAssumptions(
  input: HouseholdInput,
  estimatedOneWayDistanceKm: number
): AssumptionEntry[] {
  const entries: AssumptionEntry[] = [
    {
      label: 'Estimated one-way route distance',
      value: `${estimatedOneWayDistanceKm.toFixed(1)} km (from ${input.commuteDurationMinutes} min baseline × ${ASSUMED_MOTORIZED_SPEED_KM_PER_HOUR} km/h assumed urban morning speed)`
    },
    {
      label: 'Baseline solo-car emission factor',
      value: `${SOLO_CAR_EMISSION_KG_PER_KM} kg CO2e / passenger-km`
    }
  ];
  if (input.budgetCurrency === 'USD') {
    entries.push({
      label: 'Currency conversion used',
      value: `1 USD = ${INR_PER_USD} INR`
    });
  }
  return entries;
}

function buildRoutineRecommendation(
  input: HouseholdInput,
  airQuality: AirQualityReading,
  selected: TravelOptionEvaluation | null,
  evaluations: TravelOptionEvaluation[],
  availableWindowMinutes: number,
  estimatedOneWayDistanceKm: number
): {
  block: RecommendationBlock;
  conflictExplanation: string | null;
  constraintChangePrompts: ConstraintConflictOption[];
} {
  const maskRequired =
    airQuality.pm25UgM3 >= PM25_MASK_RECOMMENDED_UG_M3 ||
    input.childHasAsthmaOrSensitivity;
  const baseAssumptions = buildSharedDistanceAssumptions(
    input,
    estimatedOneWayDistanceKm
  );

  if (!selected) {
    const conflictSummary = evaluations
      .map((item) => `${item.label}: ${item.rejectionReasons.join(' ')}`)
      .join(' | ');
    const constraintChangePrompts = buildConstraintConflictPrompts(
      input,
      evaluations,
      availableWindowMinutes,
      airQuality.pm25UgM3
    );

    return {
      conflictExplanation: `No travel option fits all active constraints (${input.city}, ${input.schoolStartTime} start, ${input.earliestReadyTime} earliest departure, ${formatCurrencyFromInr(convertCurrencyToInr(input.dailyBudget, input.budgetCurrency), input.budgetCurrency)} budget, PM2.5 ${airQuality.pm25UgM3.toFixed(1)} µg/m³). ${conflictSummary}`,
      constraintChangePrompts,
      block: {
        id: 'routine',
        title: 'Travel Conflict — No Feasible Option Today',
        whatToDo:
          'Hold departure until one household constraint is adjusted or verify whether the school offers remote/delayed-start smog relief today.',
        whyItFits: `Every travel mode was disqualified by your current availability, ${formatCurrencyFromInr(convertCurrencyToInr(input.dailyBudget, input.budgetCurrency), input.budgetCurrency)} budget, ${availableWindowMinutes}-minute morning window, or ${airQuality.pm25UgM3.toFixed(1)} µg/m³ outdoor PM2.5 safety rule.`,
        emissionsDifference:
          'Pausing an unplanned solo car trip avoids ~' +
          (estimatedOneWayDistanceKm * 2 * SOLO_CAR_EMISSION_KG_PER_KM).toFixed(2) +
          ' kg CO2e of tailpipe emissions this morning.',
        personalExposureDifference:
          'Keeping the child indoors while resolving transport prevents unmasked roadside PM2.5 spikes during severe winter morning inversion.',
        actionChecklist: constraintChangePrompts.map(
          (item) => `Adjust ${item.constraint}: ${item.suggestion}`
        ),
        assumptions: [
          ...baseAssumptions,
          {
            label: 'Child outdoor active-commute PM2.5 safety cap',
            value: `${(input.childHasAsthmaOrSensitivity ? PM25_SENSITIVE_ACTIVE_CAP_UG_M3 : PM25_ACTIVE_COMMUTE_CAP_UG_M3).toFixed(1)} µg/m³`
          }
        ]
      }
    };
  }

  const spec = TRAVEL_MODE_SPECS[selected.modeId];
  const maskAction = maskRequired
    ? 'Wear a snug child-sized N95/KF94 mask from doorstep to school building.'
    : 'Mask optional at current PM2.5; monitor midday spike alerts.';
  const cabinAction =
    selected.modeId === 'walkOrCycle'
      ? 'Choose shaded side streets away from heavy bus/truck lanes and keep pace steady.'
      : selected.modeId === 'schoolBus'
        ? 'Request closed bus windows along congested intersections and sit away from the rear exhaust.'
        : 'Set vehicle cabin vents to RECIRCULATE (never outside intake) during congested stretches.';

  const rejectedSummary = evaluations
    .filter((item) => item.modeId !== selected.modeId)
    .map((item) =>
      item.feasible
        ? `${item.label} (feasible, ranked lower for ${airQuality.pm25UgM3 > 55.4 ? 'smog protection/consolidation' : 'cost'})`
        : `${item.label} (excluded: ${item.rejectionReasons[0]})`
    )
    .slice(0, 3)
    .join('; ');

  const checklist = [
    `Leave home at ${selected.recommendedDepartureTime} (${selected.requiredMinutes} min door-to-door for ${input.schoolStartTime} start).`,
    maskAction,
    cabinAction,
    'Wash hands and face immediately on school arrival to remove settled dust.'
  ];

  const emissionsDifference =
    selected.co2eSavedVsSoloCarKg > 0
      ? `Estimated ${selected.emissionsKgCo2ePerRoundTrip.toFixed(2)} kg CO2e per student round-trip — saves ~${selected.co2eSavedVsSoloCarKg.toFixed(2)} kg CO2e compared with a solo car trip.`
      : `Estimated ${selected.emissionsKgCo2ePerRoundTrip.toFixed(2)} kg CO2e per round-trip (solo vehicle adds congestion and gate idling).`;

  return {
    conflictExplanation: null,
    constraintChangePrompts: [],
    block: {
      id: 'routine',
      title: `Low-Emission Routine: ${selected.label}`,
      whatToDo: `Take the ${selected.label} departing at ${selected.recommendedDepartureTime} (${selected.estimatedCostDisplay}). ${maskAction}`,
      whyItFits: `Fits your ${input.schoolStartTime} start (${selected.requiredMinutes} min <= ${availableWindowMinutes} min window), stays within your ${formatCurrencyFromInr(convertCurrencyToInr(input.dailyBudget, input.budgetCurrency), input.budgetCurrency)} budget, and accounts for ${airQuality.cityQuery} PM2.5 (${airQuality.pm25UgM3.toFixed(1)} µg/m³). Other options: ${rejectedSummary}.`,
      emissionsDifference,
      personalExposureDifference: selected.personalExposureSummary,
      actionChecklist: checklist,
      assumptions: [
        ...baseAssumptions,
        {
          label: `${selected.label} cost & emission factor`,
          value: `${formatCurrencyFromInr(spec.costInr, input.budgetCurrency)}, ${spec.emissionsKgCo2ePerStudentKm} kg CO2e / student-km`
        },
        {
          label: 'Travel time formula',
          value: `${input.commuteDurationMinutes} min × ${spec.durationMultiplier} + ${spec.boardingBufferMinutes} min buffer = ${selected.requiredMinutes} min`
        }
      ]
    }
  };
}

function buildIndoorAirQualityRecommendation(
  input: HouseholdInput,
  airQuality: AirQualityReading,
  remainingBudgetInr: number
): RecommendationBlock {
  const currency: BudgetCurrency = input.budgetCurrency;
  const pm25 = airQuality.pm25UgM3;
  const isHighSmog = pm25 > 55.4;

  const draftGuidance =
    input.homeVentilation === 'drafty_windows'
      ? 'Place rolled damp towels or low-cost foam weatherstripping along bedroom window/door gaps between 06:00 and 10:30 when winter inversion traps exhaust.'
      : input.homeVentilation === 'shared_hallway'
        ? 'Hang a heavy door sweep/curtain at the shared corridor entry and isolate one clean prep bedroom.'
        : 'Keep sealed windows closed during peak morning traffic and open only briefly if outdoor PM2.5 drops in afternoon.';

  if (input.homePurifier === 'hepa_purifier') {
    const affordable = remainingBudgetInr >= IAQ_ACTION_COSTS_INR.hepaOperationDaily;
    const estCostDisplay = formatCurrencyFromInr(
      IAQ_ACTION_COSTS_INR.hepaOperationDaily,
      currency
    );
    return {
      id: 'indoor',
      title: 'Indoor Air Quality: HEPA Clean-Room Pre-Filtration + Window Sealing',
      whatToDo: affordable
        ? `Run your portable HEPA purifier on Medium-High in the child’s sleeping/morning prep room 45 minutes before waking (${estCostDisplay} est. electricity + filter share), and keep doors shut.`
        : `Run your portable HEPA purifier on Low/Sleep mode in a single closed bedroom (prioritizing sleeping hours) while wet-wiping dust and sealing drafts.`,
      whyItFits: `Tailored to your existing HEPA purifier, ${input.homeVentilation.replace('_', ' ')}, outdoor PM2.5 of ${pm25.toFixed(1)} µg/m³, and ${formatCurrencyFromInr(remainingBudgetInr, currency)} remaining daily budget after travel.`,
      emissionsDifference:
        'Using one single-room HEPA unit (~35W) adds minimal electricity demand (~0.03 kg CO2e/morning) compared with whole-house heating/filtration.',
      personalExposureDifference:
        'Reduces indoor PM2.5 inside the child’s prep room directly before school, cutting baseline overnight and morning lung burden — unlike outdoor transit choices which only help once outside.',
      actionChecklist: [
        draftGuidance,
        'Avoid incense, candles, or frying without kitchen exhaust during morning prep.',
        'Wet-mop hard floors instead of dry sweeping so settled fine dust is not resuspended.'
      ],
      assumptions: [
        {
          label: 'HEPA daily amortized cost estimate',
          value: `${estCostDisplay} (assuming ~35W × 8h overnight/morning run + amortized HEPA filter share)`
        },
        {
          label: 'Morning pre-filtration electricity CO2e',
          value: '0.035 kW × 1 h pre-school run = 0.035 kWh × ~0.82 kg CO2e/kWh grid factor ≈ 0.03 kg CO2e'
        },
        {
          label: 'Remaining daily budget after travel',
          value: formatCurrencyFromInr(remainingBudgetInr, currency)
        }
      ]
    };
  }

  if (
    input.homePurifier === 'diy_box_fan' ||
    (isHighSmog && remainingBudgetInr >= IAQ_ACTION_COSTS_INR.diyFilterUpkeep)
  ) {
    const diyCostDisplay = formatCurrencyFromInr(
      IAQ_ACTION_COSTS_INR.diyFilterUpkeep,
      currency
    );
    return {
      id: 'indoor',
      title: 'Indoor Air Quality: Single-Room Box-Fan MERV-13 Filtration + Draft Seal',
      whatToDo:
        input.homePurifier === 'diy_box_fan'
          ? `Run your DIY box-fan MERV-13 filter in the child’s closed bedroom during morning prep (${diyCostDisplay} upkeep share) and seal window gaps.`
          : `Use ${diyCostDisplay} of your ${formatCurrencyFromInr(remainingBudgetInr, currency)} remaining daily budget toward a single-room DIY box-fan + MERV-13 filter setup alongside zero-cost draft sealing.`,
      whyItFits: `Matches your home without a commercial HEPA purifier, addresses ${input.homeVentilation.replace('_', ' ')}, and stays inside your ${formatCurrencyFromInr(remainingBudgetInr, currency)} post-travel budget.`,
      emissionsDifference:
        'A standard 45W fan + MERV-13 filter extends hardware life and keeps daily energy use low.',
      personalExposureDifference:
        'Directly lowers indoor fine particulate inhalation during the 10–14 hours a child spends at home, especially if windows are leaky during severe morning smog.',
      actionChecklist: [
        draftGuidance,
        'Keep kitchen exhaust on (or cover pans) during morning breakfast prep.',
        'Wet-wipe study table and bedside surfaces; avoid dry dusting.'
      ],
      assumptions: [
        {
          label: 'DIY MERV-13 filter amortized cost',
          value: `${diyCostDisplay} (filter + fan cost amortized over ~90 winter smog days)`
        },
        {
          label: 'Remaining daily budget after travel',
          value: formatCurrencyFromInr(remainingBudgetInr, currency)
        }
      ]
    };
  }

  return {
    id: 'indoor',
    title: 'Indoor Air Quality: Zero-Cost Inversion Timing & Source Control',
    whatToDo:
      'Seal bedroom window gaps with damp cloth/towels before 06:00, halt indoor smoke/frying aerosols during morning prep, and ventilate only if afternoon PM2.5 drops.',
    whyItFits: `Requires ${formatCurrencyFromInr(0, currency)} cash outlay, matching your ${formatCurrencyFromInr(remainingBudgetInr, currency)} post-travel budget and ${input.homeVentilation.replace('_', ' ')} setup.`,
    emissionsDifference:
      'Zero additional electricity consumption while cutting indoor combustion spikes.',
    personalExposureDifference:
      'Prevents morning outdoor smog intrusion and indoor cooking PM2.5 peaks in the child’s breathing zone at zero cost.',
    actionChecklist: [
      draftGuidance,
      'Wet-mop floors instead of dry sweeping before the child wakes.',
      'Hold outdoor balcony/courtyard play until afternoon mixing lowers ambient PM2.5.'
    ],
    assumptions: [
      {
        label: 'Behavioral & draft-sealing cost',
        value: `${formatCurrencyFromInr(0, currency)} using household materials`
      },
      {
        label: 'Remaining daily budget after travel',
        value: formatCurrencyFromInr(remainingBudgetInr, currency)
      }
    ]
  };
}

function buildSustainableAlternativeRecommendation(
  input: HouseholdInput,
  airQuality: AirQualityReading,
  selected: TravelOptionEvaluation | null
): RecommendationBlock {
  if (!input.travelOptions.schoolBus || !selected) {
    return {
      id: 'sustainable',
      title: 'Community Alternative: Verified Corridor Carpool & Clean School Bus Advocacy',
      whatToDo: `Organize a 3-family verified pickup corridor for the ${input.schoolStartTime} bell and ask your PTA/school transport office to expand electric or filtered school bus stops in ${input.city}.`,
      whyItFits:
        'Because the school bus is currently unavailable or constraints conflict, pooling nearby households immediately cuts gate congestion without exposing children to roadside walking in high smog.',
      emissionsDifference:
        'Every 3-family shared vehicle removes 2 solo morning cars (~67% reduction in per-family commuter tailpipe CO2e and school-gate NOx/PM).',
      personalExposureDifference:
        'Moving drop-offs into consolidated, idle-free vehicles lowers localized curbside PM2.5 spikes right where children step out at the school gate.',
      actionChecklist: [
        'Post an anonymous corridor-only notice (no child name or home address) using the Community Action panel below.',
        'Ask the school to designate an idle-free drop-off bay 100 m upwind of classroom windows.',
        'Propose staggered/hybrid severe-smog mornings when PM2.5 exceeds 200 µg/m³.'
      ],
      assumptions: [
        {
          label: 'Carpool consolidation basis',
          value: '3 students per shared vehicle vs. 3 separate 1-student private car trips'
        }
      ]
    };
  }

  return {
    id: 'sustainable',
    title: 'Community Alternative: Idle-Free School Gate & HEPA-Retrofitted Bus Drive',
    whatToDo: `Champion a parent-school "Engines Off at Pickup" zone at the ${input.city} gate and advocate for cabin air filtration or electric bus procurement on your ${input.schoolStartTime} route.`,
    whyItFits: `Your family already uses or has access to ${selected.label}; extending clean-air standards at the school gate multiplies impact across dozens of classrooms.`,
    emissionsDifference:
      'Eliminating 10 minutes of morning idling across 40 pickup cars avoids ~1.5–2.0 kg CO2e and dense curbside diesel/petrol exhaust every school morning.',
    personalExposureDifference:
      'Cutting gate idling directly lowers peak PM2.5 concentrations breathed by every student walking from buses/cars into classrooms — protecting both bus riders and walkers.',
    actionChecklist: [
      'Share the pre-written anonymous No-Idling gate reminder in your parent group below.',
      'Ask the school to move morning assembly indoors whenever US AQI exceeds 150.',
      'Partner with the PTA to check bus door seals and cabin air filters before peak winter smog months.'
    ],
    assumptions: [
      {
        label: 'Gate idling benchmark',
        value: '40 waiting vehicles × 10 min idling ≈ 0.04–0.05 kg CO2e/vehicle + concentrated curbside exhaust'
      }
    ]
  };
}

export function buildMorningPlan(
  input: HouseholdInput,
  airQuality: AirQualityReading,
  nowIso: string = new Date().toISOString()
): MorningPlan {
  const startMins = parseTimeToMinutes(input.schoolStartTime);
  const readyMins = parseTimeToMinutes(input.earliestReadyTime);
  const availableWindowMinutes = startMins - readyMins;

  const estimatedOneWayDistanceKm =
    (input.commuteDurationMinutes / 60) * ASSUMED_MOTORIZED_SPEED_KM_PER_HOUR;
  const dailyBudgetInr = convertCurrencyToInr(
    input.dailyBudget,
    input.budgetCurrency
  );

  const evaluations = evaluateAllTravelOptions(
    input,
    availableWindowMinutes,
    airQuality.pm25UgM3
  );
  const selected = selectBestTravelOption(evaluations, airQuality.pm25UgM3);

  const allocatedTravelCostInr = selected ? selected.estimatedCostInr : 0;
  const remainingBudgetInr = Math.max(0, dailyBudgetInr - allocatedTravelCostInr);

  const routineResult = buildRoutineRecommendation(
    input,
    airQuality,
    selected,
    evaluations,
    availableWindowMinutes,
    estimatedOneWayDistanceKm
  );

  const indoorAirQuality = buildIndoorAirQualityRecommendation(
    input,
    airQuality,
    remainingBudgetInr
  );
  const sustainableAlternative = buildSustainableAlternativeRecommendation(
    input,
    airQuality,
    selected
  );

  return {
    planId: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    generatedAtIso: nowIso,
    routineStatus: selected ? 'FEASIBLE' : 'NO_FEASIBLE_OPTION',
    selectedModeId: selected ? selected.modeId : null,
    selectedModeLabel: selected ? selected.label : null,
    recommendedDepartureTime: selected ? selected.recommendedDepartureTime : null,
    availableWindowMinutes,
    dailyBudgetInr,
    allocatedTravelCostInr,
    remainingBudgetInr,
    estimatedOneWayDistanceKm: Number(estimatedOneWayDistanceKm.toFixed(1)),
    airQualitySnapshot: airQuality,
    evaluatedTravelOptions: evaluations,
    conflictExplanation: routineResult.conflictExplanation,
    constraintChangePrompts: routineResult.constraintChangePrompts,
    recommendations: {
      routine: routineResult.block,
      indoorAirQuality,
      sustainableAlternative
    }
  };
}

/**
 * Computes a human-readable diff between a previous plan and the new plan
 * so parents clearly see what changed, what stayed relevant, and why.
 */
export function computePlanDiff(
  previous: PreviousPlanSummaryInput | undefined,
  current: MorningPlan,
  currentInput: HouseholdInput
): PlanDiff | null {
  if (!previous) {
    return null;
  }

  const changedInputs: string[] = [];
  const prevIn = previous.householdInput;

  if (prevIn.city !== currentInput.city) {
    changedInputs.push(`City: ${prevIn.city} → ${currentInput.city}`);
  }
  if (prevIn.schoolStartTime !== currentInput.schoolStartTime) {
    changedInputs.push(
      `School start: ${prevIn.schoolStartTime} → ${currentInput.schoolStartTime}`
    );
  }
  if (prevIn.earliestReadyTime !== currentInput.earliestReadyTime) {
    changedInputs.push(
      `Earliest ready time: ${prevIn.earliestReadyTime} → ${currentInput.earliestReadyTime}`
    );
  }
  if (prevIn.commuteDurationMinutes !== currentInput.commuteDurationMinutes) {
    changedInputs.push(
      `Commute duration: ${prevIn.commuteDurationMinutes} min → ${currentInput.commuteDurationMinutes} min`
    );
  }
  if (
    prevIn.dailyBudget !== currentInput.dailyBudget ||
    prevIn.budgetCurrency !== currentInput.budgetCurrency
  ) {
    changedInputs.push(
      `Budget: ${prevIn.dailyBudget} ${prevIn.budgetCurrency} → ${currentInput.dailyBudget} ${currentInput.budgetCurrency}`
    );
  }
  for (const modeId of TRAVEL_MODE_ORDER) {
    if (prevIn.travelOptions[modeId] !== currentInput.travelOptions[modeId]) {
      const label = TRAVEL_MODE_SPECS[modeId].label;
      changedInputs.push(
        `${label} availability: ${prevIn.travelOptions[modeId] ? 'Yes' : 'No'} → ${currentInput.travelOptions[modeId] ? 'Yes' : 'No'}`
      );
    }
  }
  if (prevIn.homePurifier !== currentInput.homePurifier) {
    changedInputs.push(
      `Home purifier: ${prevIn.homePurifier} → ${currentInput.homePurifier}`
    );
  }

  const whatChanged: string[] = [];
  const whatStayedRelevant: string[] = [];

  if (previous.selectedModeId !== current.selectedModeId) {
    const prevDesc = previous.selectedModeLabel
      ? `${previous.selectedModeLabel} (depart ${previous.recommendedDepartureTime ?? 'N/A'}, ${formatCurrencyFromInr(previous.allocatedTravelCostInr, currentInput.budgetCurrency)})`
      : 'No feasible travel option';
    const currDesc = current.selectedModeLabel
      ? `${current.selectedModeLabel} (depart ${current.recommendedDepartureTime ?? 'N/A'}, ${formatCurrencyFromInr(current.allocatedTravelCostInr, currentInput.budgetCurrency)})`
      : 'No feasible travel option (constraint conflict)';
    whatChanged.push(`Morning travel routine: ${prevDesc} → ${currDesc}.`);
  } else {
    whatStayedRelevant.push(
      `Morning travel option stayed ${current.selectedModeLabel ?? 'in conflict state'}.`
    );
  }

  if (
    previous.indoorActionTitle === current.recommendations.indoorAirQuality.title
  ) {
    whatStayedRelevant.push(
      `Indoor Air Quality action stayed relevant (${current.recommendations.indoorAirQuality.title}) because outdoor PM2.5 (${current.airQualitySnapshot.pm25UgM3.toFixed(1)} µg/m³), home setup, and remaining budget (${formatCurrencyFromInr(current.remainingBudgetInr, currentInput.budgetCurrency)}) still support it.`
    );
  } else {
    whatChanged.push(
      `Indoor Air Quality action adjusted: ${previous.indoorActionTitle} → ${current.recommendations.indoorAirQuality.title}.`
    );
  }

  if (
    previous.sustainableActionTitle ===
    current.recommendations.sustainableAlternative.title
  ) {
    whatStayedRelevant.push(
      `Sustainable Community Alternative stayed relevant (${current.recommendations.sustainableAlternative.title}).`
    );
  } else {
    whatChanged.push(
      `Sustainable Community Alternative updated: ${previous.sustainableActionTitle} → ${current.recommendations.sustainableAlternative.title}.`
    );
  }

  let whyItChanged = 'Plan recalculated using your latest household inputs.';
  if (
    previous.selectedModeId === 'schoolBus' &&
    !currentInput.travelOptions.schoolBus
  ) {
    const busEval = current.evaluatedTravelOptions.find(
      (e) => e.modeId === 'schoolBus'
    );
    const busReason = busEval?.rejectionReasons[0] ?? 'School Bus marked unavailable.';
    whyItChanged = current.selectedModeLabel
      ? `${busReason} The solver selected ${current.selectedModeLabel} as the next lowest-emission enclosed option fitting your ${currentInput.schoolStartTime} bell and ${formatCurrencyFromInr(current.dailyBudgetInr, currentInput.budgetCurrency)} budget.`
      : `${busReason} No remaining enabled travel option satisfied all timing, budget, and smog safety constraints.`;
  } else if (current.routineStatus === 'NO_FEASIBLE_OPTION') {
    whyItChanged =
      current.conflictExplanation ??
      'Updated constraints left no travel mode feasible.';
  } else if (changedInputs.length > 0 && current.selectedModeLabel) {
    whyItChanged = `After updating (${changedInputs.join('; ')}), ${current.selectedModeLabel} became the top-ranked feasible choice under your active rules.`;
  }

  return {
    hasPreviousPlan: true,
    changedInputs,
    whatChanged,
    whatStayedRelevant,
    whyItChanged
  };
}
