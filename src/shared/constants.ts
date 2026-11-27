import type {
  AirQualityReading,
  BudgetCurrency,
  CommunityNotice,
  HomePurifierType,
  HomeVentilationType,
  HouseholdInput,
  TravelModeId
} from './types.js';

/** Static INR/USD conversion documented in visible assumptions. */
export const INR_PER_USD = 84;

/** Assumed baseline motorized morning commute speed used to estimate route distance from commuteDurationMinutes. */
export const ASSUMED_MOTORIZED_SPEED_KM_PER_HOUR = 24;

/** Solo car tailpipe emission factor (kg CO2e per passenger-km) for emissions comparison. */
export const SOLO_CAR_EMISSION_KG_PER_KM = 0.18;

/** Air-quality observation older than 3 hours is marked stale. */
export const AIR_QUALITY_STALE_THRESHOLD_MS = 3 * 60 * 60 * 1000;

/** PM2.5 & US AQI thresholds (aligned with May 2024 US EPA breakpoints) governing active travel & masks. */
export const PM25_MASK_RECOMMENDED_UG_M3 = 35.5; // US AQI > 100 (USG+)
export const PM25_ACTIVE_COMMUTE_CAP_UG_M3 = 55.4; // Above this (>150 US AQI) is Unhealthy for all
export const PM25_SENSITIVE_ACTIVE_CAP_UG_M3 = 35.4; // Stricter cap (>100 US AQI) for sensitive children
export const US_AQI_ACTIVE_COMMUTE_CAP = 150;
export const US_AQI_SENSITIVE_ACTIVE_CAP = 100;
export const ACTIVE_COMMUTE_MAX_MINUTES = 25;

export interface TravelModeSpec {
  id: TravelModeId;
  label: string;
  costInr: number;
  durationMultiplier: number;
  boardingBufferMinutes: number;
  maxSafePm25UgM3: number | null;
  maxSafeDurationMinutes: number | null;
  emissionsKgCo2ePerStudentKm: number;
  breathingRateMultiplier: number;
  enclosedCabin: boolean;
  /** Lower number = higher priority when air is polluted (>55.4 µg/m³). */
  smogPriority: number;
  /** Lower number = higher priority when air is clean/moderate (<=55.4 µg/m³). */
  cleanAirPriority: number;
  exposureNotes: string;
  emissionsNotes: string;
}

export const TRAVEL_MODE_SPECS: Record<TravelModeId, TravelModeSpec> = {
  schoolBus: {
    id: 'schoolBus',
    label: 'Shared School Bus',
    costInr: 60,
    durationMultiplier: 1.15,
    boardingBufferMinutes: 5,
    maxSafePm25UgM3: null,
    maxSafeDurationMinutes: null,
    emissionsKgCo2ePerStudentKm: 0.028,
    breathingRateMultiplier: 1.0,
    enclosedCabin: true,
    smogPriority: 1,
    cleanAirPriority: 2,
    emissionsNotes:
      'Consolidates ~25–35 student trips into one vehicle, avoiding a separate household car trip.',
    exposureNotes:
      'A shared bus lowers road emissions, but cabin PM2.5 still tracks busy-road exhaust unless windows stay shut and the child wears a well-fitted N95/KF94 mask.'
  },
  metroOrPublicTransit: {
    id: 'metroOrPublicTransit',
    label: 'Metro / Public Transit + Covered Feeder',
    costInr: 90,
    durationMultiplier: 1.35,
    boardingBufferMinutes: 8,
    maxSafePm25UgM3: null,
    maxSafeDurationMinutes: null,
    emissionsKgCo2ePerStudentKm: 0.025,
    breathingRateMultiplier: 1.05,
    enclosedCabin: true,
    smogPriority: 2,
    cleanAirPriority: 3,
    emissionsNotes:
      'Electric rail + short shared feeder produces the lowest motorized per-rider tailpipe CO2e.',
    exposureNotes:
      'Air-conditioned metro coaches filter some coarse dust, though station stairs and feeder legs still require a snug N95/KF94 mask during smog.'
  },
  carpool: {
    id: 'carpool',
    label: '3-Family School Carpool',
    costInr: 85,
    durationMultiplier: 1.15,
    boardingBufferMinutes: 5,
    maxSafePm25UgM3: null,
    maxSafeDurationMinutes: null,
    emissionsKgCo2ePerStudentKm: 0.06,
    breathingRateMultiplier: 1.0,
    enclosedCabin: true,
    smogPriority: 3,
    cleanAirPriority: 4,
    emissionsNotes:
      'Splits one vehicle across 3 families, removing 2 morning school-gate cars from the corridor.',
    exposureNotes:
      'Sealed windows with cabin AC on RECIRCULATE (never outside air intake) plus a cabin HEPA filter or N95 mask significantly cuts in-car PM2.5.'
  },
  walkOrCycle: {
    id: 'walkOrCycle',
    label: 'Walk / Cycle',
    costInr: 0,
    durationMultiplier: 1.8,
    boardingBufferMinutes: 2,
    maxSafePm25UgM3: PM25_ACTIVE_COMMUTE_CAP_UG_M3,
    maxSafeDurationMinutes: ACTIVE_COMMUTE_MAX_MINUTES,
    emissionsKgCo2ePerStudentKm: 0,
    breathingRateMultiplier: 2.5,
    enclosedCabin: false,
    smogPriority: 4,
    cleanAirPriority: 1,
    emissionsNotes: 'Zero tailpipe emissions and zero fuel cost.',
    exposureNotes:
      'Active travel increases child breathing volume ~2.5x along roadside exhaust corridors; safe only when PM2.5 and duration stay below health caps.'
  },
  privateCar: {
    id: 'privateCar',
    label: 'Private Car / Solo Cab',
    costInr: 220,
    durationMultiplier: 1.0,
    boardingBufferMinutes: 3,
    maxSafePm25UgM3: null,
    maxSafeDurationMinutes: null,
    emissionsKgCo2ePerStudentKm: SOLO_CAR_EMISSION_KG_PER_KM,
    breathingRateMultiplier: 1.0,
    enclosedCabin: true,
    smogPriority: 5,
    cleanAirPriority: 5,
    emissionsNotes:
      'Highest per-student tailpipe emissions and adds idling congestion directly outside school gates.',
    exposureNotes:
      'Cabin AC on RECIRCULATE lowers the child’s immediate PM2.5 inhalation compared to walking, at the cost of higher neighborhood emissions.'
  }
};

export const TRAVEL_MODE_ORDER: TravelModeId[] = [
  'schoolBus',
  'metroOrPublicTransit',
  'carpool',
  'walkOrCycle',
  'privateCar'
];

export const HOME_PURIFIER_LABELS: Record<HomePurifierType, string> = {
  none: 'No air purifier at home',
  hepa_purifier: 'Portable HEPA air purifier',
  diy_box_fan: 'DIY box-fan MERV-13 filter'
};

export const HOME_VENTILATION_LABELS: Record<HomeVentilationType, string> = {
  drafty_windows: 'Older / drafty window frames',
  sealed_windows: 'Well-sealed windows / split AC',
  shared_hallway: 'Open courtyard or shared corridor entry'
};

export const IAQ_ACTION_COSTS_INR = {
  zeroCostSealing: 0,
  diyFilterUpkeep: 35,
  hepaOperationDaily: 30
} as const;

export const DEFAULT_HOUSEHOLD_INPUT: HouseholdInput = {
  city: 'Delhi-NCR',
  schoolStartTime: '08:00',
  earliestReadyTime: '07:00',
  commuteDurationMinutes: 25,
  dailyBudget: 150,
  budgetCurrency: 'INR',
  homePurifier: 'none',
  homeVentilation: 'drafty_windows',
  childHasAsthmaOrSensitivity: false,
  travelOptions: {
    schoolBus: true,
    metroOrPublicTransit: true,
    carpool: true,
    walkOrCycle: true,
    privateCar: true
  }
};

export const SAMPLE_AIR_QUALITY_PRESETS: Record<string, AirQualityReading> = {
  delhi_severe_winter: {
    cityQuery: 'Delhi-NCR',
    resolvedLocation: 'Sample: Delhi-NCR Winter Inversion Scenario',
    pm25UgM3: 245,
    pm10UgM3: 365,
    usAqi: 315,
    category: 'Hazardous',
    source: 'Sample Dataset · Severe Winter Smog Baseline',
    dataOrigin: 'sample',
    timestampIso: '2026-11-27T07:00:00.000Z',
    isStale: false,
    staleReason: null,
    units: { pm25: 'µg/m³', pm10: 'µg/m³', usAqi: 'US AQI (0-500)' }
  },
  moderate_urban: {
    cityQuery: 'Bengaluru',
    resolvedLocation: 'Sample: Moderate Urban Morning Scenario',
    pm25UgM3: 38,
    pm10UgM3: 68,
    usAqi: 107,
    category: 'Unhealthy for Sensitive Groups',
    source: 'Sample Dataset · Moderate Urban Morning',
    dataOrigin: 'sample',
    timestampIso: '2026-11-27T07:00:00.000Z',
    isStale: false,
    staleReason: null,
    units: { pm25: 'µg/m³', pm10: 'µg/m³', usAqi: 'US AQI (0-500)' }
  },
  clean_morning: {
    cityQuery: 'Shimla',
    resolvedLocation: 'Sample: Clean Air Morning Scenario',
    pm25UgM3: 8.5,
    pm10UgM3: 18,
    usAqi: 47,
    category: 'Good',
    source: 'Sample Dataset · Clean Air Morning',
    dataOrigin: 'sample',
    timestampIso: '2026-11-27T07:00:00.000Z',
    isStale: false,
    staleReason: null,
    units: { pm25: 'µg/m³', pm10: 'µg/m³', usAqi: 'US AQI (0-500)' }
  }
};

export const SEEDED_COMMUNITY_NOTICES: CommunityNotice[] = [
  {
    id: 'sample-notice-1',
    category: 'no-idling',
    corridorZone: 'South Gate Pickup Lane (Sample)',
    schoolWindow: '07:45–08:10',
    message:
      'Sample notice: Please switch engines off while waiting near the school gate during morning smog hours.',
    createdAtIso: '2026-11-27T06:45:00.000Z',
    isSample: true
  },
  {
    id: 'sample-notice-2',
    category: 'carpool-corridor',
    corridorZone: 'Sector Corridor North -> Main Campus (Sample)',
    schoolWindow: '07:20 departure',
    message:
      'Sample notice: Parent carpool has 1 open seat on the Sector North corridor for 08:00 arrival; AC recirculate + masks.',
    createdAtIso: '2026-11-27T06:50:00.000Z',
    isSample: true
  }
];

export function convertInrToCurrency(
  amountInr: number,
  currency: BudgetCurrency
): number {
  if (currency === 'INR') {
    return Math.round(amountInr);
  }
  return Number((amountInr / INR_PER_USD).toFixed(2));
}

export function convertCurrencyToInr(
  amount: number,
  currency: BudgetCurrency
): number {
  if (currency === 'INR') {
    return Math.round(amount);
  }
  return Math.round(amount * INR_PER_USD);
}

export function formatCurrencyFromInr(
  amountInr: number,
  currency: BudgetCurrency
): string {
  if (currency === 'INR') {
    return `₹${Math.round(amountInr)}/day`;
  }
  return `$${(amountInr / INR_PER_USD).toFixed(2)}/day`;
}
