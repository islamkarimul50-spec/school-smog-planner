export type BudgetCurrency = 'INR' | 'USD';

export type TravelModeId =
  | 'schoolBus'
  | 'metroOrPublicTransit'
  | 'carpool'
  | 'walkOrCycle'
  | 'privateCar';

export type HomePurifierType = 'none' | 'hepa_purifier' | 'diy_box_fan';

export type HomeVentilationType =
  | 'drafty_windows'
  | 'sealed_windows'
  | 'shared_hallway';

export type AirQualityCategory =
  | 'Good'
  | 'Moderate'
  | 'Unhealthy for Sensitive Groups'
  | 'Unhealthy'
  | 'Very Unhealthy'
  | 'Hazardous';

export type AirQualityDataOrigin = 'live' | 'sample' | 'manual';

export interface AirQualityReading {
  cityQuery: string;
  resolvedLocation: string;
  pm25UgM3: number;
  pm10UgM3: number | null;
  usAqi: number;
  category: AirQualityCategory;
  source: string;
  dataOrigin: AirQualityDataOrigin;
  /** ISO 8601 timestamp when observation was recorded or entered */
  timestampIso: string;
  isStale: boolean;
  staleReason: string | null;
  units: {
    pm25: 'µg/m³';
    pm10: 'µg/m³';
    usAqi: 'US AQI (0-500+)';
  };
}

export interface TravelAvailability {
  schoolBus: boolean;
  metroOrPublicTransit: boolean;
  carpool: boolean;
  walkOrCycle: boolean;
  privateCar: boolean;
}

export interface HouseholdInput {
  city: string;
  /** 24-hour HH:MM string (e.g., "08:00") */
  schoolStartTime: string;
  /** 24-hour HH:MM string (e.g., "07:00") */
  earliestReadyTime: string;
  /** Typical one-way motorized commute duration in minutes */
  commuteDurationMinutes: number;
  dailyBudget: number;
  budgetCurrency: BudgetCurrency;
  homePurifier: HomePurifierType;
  homeVentilation: HomeVentilationType;
  childHasAsthmaOrSensitivity: boolean;
  travelOptions: TravelAvailability;
}

export interface AssumptionEntry {
  label: string;
  value: string;
}

export interface TravelConstraintChecks {
  availability: boolean;
  budget: boolean;
  timing: boolean;
  airQualitySafety: boolean;
  activeDuration: boolean;
}

export interface TravelOptionEvaluation {
  modeId: TravelModeId;
  label: string;
  available: boolean;
  feasible: boolean;
  constraints: TravelConstraintChecks;
  estimatedCostInr: number;
  estimatedCostDisplay: string;
  requiredMinutes: number;
  recommendedDepartureTime: string | null;
  rejectionReasons: string[];
  emissionsKgCo2ePerRoundTrip: number;
  co2eSavedVsSoloCarKg: number;
  exposureRiskLevel: 'Low' | 'Moderate' | 'High';
  personalExposureSummary: string;
  emissionsSummary: string;
}

export interface RecommendationBlock {
  id: 'routine' | 'indoor' | 'sustainable';
  title: string;
  whatToDo: string;
  whyItFits: string;
  emissionsDifference: string;
  personalExposureDifference: string;
  actionChecklist: string[];
  assumptions: AssumptionEntry[];
}

export interface ConstraintConflictOption {
  constraint: string;
  suggestion: string;
}

export interface MorningPlan {
  planId: string;
  generatedAtIso: string;
  routineStatus: 'FEASIBLE' | 'NO_FEASIBLE_OPTION';
  selectedModeId: TravelModeId | null;
  selectedModeLabel: string | null;
  recommendedDepartureTime: string | null;
  availableWindowMinutes: number;
  baselineCommuteDurationMinutes: number;
  dailyBudgetInr: number;
  allocatedTravelCostInr: number;
  remainingBudgetInr: number;
  estimatedOneWayDistanceKm: number;
  airQualitySnapshot: AirQualityReading;
  evaluatedTravelOptions: TravelOptionEvaluation[];
  conflictExplanation: string | null;
  constraintChangePrompts: ConstraintConflictOption[];
  recommendations: {
    routine: RecommendationBlock;
    indoorAirQuality: RecommendationBlock;
    sustainableAlternative: RecommendationBlock;
  };
}

export interface PlanDiff {
  hasPreviousPlan: boolean;
  changedInputs: string[];
  whatChanged: string[];
  whatStayedRelevant: string[];
  whyItChanged: string;
}

export interface AiExplanationResult {
  text: string;
  source: 'Gemini AI' | 'Deterministic Fallback (Gemini Unavailable)';
  model: string | null;
  usedFallback: boolean;
  note: string | null;
}

export interface PlanResponsePayload {
  plan: MorningPlan;
  diff: PlanDiff | null;
  aiExplanation: AiExplanationResult;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatResponsePayload {
  answer: string;
  source: 'Gemini AI' | 'Deterministic Fallback (Gemini Unavailable)';
  model: string | null;
  usedFallback: boolean;
  note: string | null;
}

export type CommunityCategory =
  | 'no-idling'
  | 'carpool-corridor'
  | 'smog-alert';

export interface CommunityNotice {
  id: string;
  category: CommunityCategory;
  corridorZone: string;
  schoolWindow: string;
  message: string;
  createdAtIso: string;
  isSample: boolean;
}
