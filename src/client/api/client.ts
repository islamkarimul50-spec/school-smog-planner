import type {
  AirQualityReading,
  ChatMessage,
  ChatResponsePayload,
  CommunityCategory,
  CommunityNotice,
  HouseholdInput,
  MorningPlan,
  PlanDiff,
  PlanResponsePayload
} from '../../shared/types.js';
import type { PreviousPlanSummaryInput } from '../../shared/decisionEngine.js';

export interface SamplePresetItem {
  key: string;
  reading: AirQualityReading;
}

export interface BootstrapPayload {
  airQuality: AirQualityReading | null;
  airQualityError: string | null;
  samplePresets: SamplePresetItem[];
  communityNotices: CommunityNotice[];
  geminiConfigured: boolean;
}

async function parseJsonOrThrow<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  return payload as T;
}

export async function fetchBootstrap(
  city: string,
  signal?: AbortSignal
): Promise<BootstrapPayload> {
  const res = await fetch(
    `/api/bootstrap?city=${encodeURIComponent(city.trim())}`,
    { signal }
  );
  return parseJsonOrThrow<BootstrapPayload>(res);
}

export async function fetchLiveAirQuality(
  city: string,
  signal?: AbortSignal
): Promise<AirQualityReading> {
  const res = await fetch(
    `/api/air-quality?city=${encodeURIComponent(city.trim())}`,
    { signal }
  );
  const data = await parseJsonOrThrow<{ airQuality: AirQualityReading }>(res);
  return data.airQuality;
}

export async function submitManualAirQuality(
  city: string,
  pm25UgM3: number
): Promise<AirQualityReading> {
  const res = await fetch('/api/air-quality/manual', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ city: city.trim(), pm25UgM3 })
  });
  const data = await parseJsonOrThrow<{ airQuality: AirQualityReading }>(res);
  return data.airQuality;
}

export async function generateMorningPlan(params: {
  householdInput: HouseholdInput;
  airQuality?: AirQualityReading;
  previousPlanSummary?: PreviousPlanSummaryInput;
}): Promise<PlanResponsePayload> {
  const res = await fetch('/api/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  return parseJsonOrThrow<PlanResponsePayload>(res);
}

export async function askCoachFollowUp(params: {
  question: string;
  householdInput: HouseholdInput;
  airQuality: AirQualityReading;
  plan: MorningPlan;
  planDiff: PlanDiff | null;
  history: ChatMessage[];
}): Promise<ChatResponsePayload> {
  const selectedEval = params.plan.evaluatedTravelOptions.find(
    (item) => item.modeId === params.plan.selectedModeId
  );
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: params.question,
      householdInput: params.householdInput,
      airQuality: params.airQuality,
      planSummary: {
        routineStatus: params.plan.routineStatus,
        selectedModeLabel: params.plan.selectedModeLabel,
        recommendedDepartureTime: params.plan.recommendedDepartureTime,
        availableWindowMinutes: params.plan.availableWindowMinutes,
        baselineCommuteDurationMinutes:
          params.plan.baselineCommuteDurationMinutes,
        selectedModeDurationMinutes: selectedEval?.requiredMinutes ?? null,
        allocatedTravelCostInr: params.plan.allocatedTravelCostInr,
        remainingBudgetInr: params.plan.remainingBudgetInr,
        conflictExplanation: params.plan.conflictExplanation,
        constraintChangePrompts: params.plan.constraintChangePrompts,
        routineWhat: params.plan.recommendations.routine.whatToDo,
        indoorWhat: params.plan.recommendations.indoorAirQuality.whatToDo,
        sustainableWhat:
          params.plan.recommendations.sustainableAlternative.whatToDo,
        rejectedModes: params.plan.evaluatedTravelOptions
          .filter((item) => !item.feasible)
          .map((item) => ({
            label: item.label,
            reasons: item.rejectionReasons
          }))
      },
      planDiff: params.planDiff,
      history: params.history.slice(-6)
    })
  });
  return parseJsonOrThrow<ChatResponsePayload>(res);
}

export async function postCommunityNotice(params: {
  category: CommunityCategory;
  corridorZone: string;
  schoolWindow: string;
  message: string;
}): Promise<{ notice: CommunityNotice; notices: CommunityNotice[] }> {
  const res = await fetch('/api/community', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  return parseJsonOrThrow<{
    notice: CommunityNotice;
    notices: CommunityNotice[];
  }>(res);
}
