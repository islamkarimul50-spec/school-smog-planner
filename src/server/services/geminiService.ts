import { ApiError, GoogleGenAI } from '@google/genai';
import {
  convertCurrencyToInr,
  formatCurrencyFromInr
} from '../../shared/constants.js';
import { computeAvailableWindowMinutes } from '../../shared/decisionEngine.js';
import type {
  AiExplanationResult,
  AirQualityReading,
  ChatMessage,
  ChatResponsePayload,
  HouseholdInput,
  MorningPlan,
  PlanDiff
} from '../../shared/types.js';
import { BoundedTtlCache } from './boundedCache.js';

const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
const GEMINI_TIMEOUT_MS = 18000;
const DEFAULT_TRANSIENT_RETRY_DELAY_MS = 300;
const PLAN_EXPLANATION_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_EXPLANATION_CACHE_ENTRIES = 100;

export type GeminiFailureCategory =
  | 'timeout'
  | 'rate_limit'
  | 'config_error'
  | 'provider_error';

export interface GeminiFailureDiagnosis {
  category: GeminiFailureCategory;
  status: number | null;
  note: string;
}

export interface GeminiClientLike {
  generateText(params: {
    model: string;
    systemInstruction: string;
    contents: string;
    abortSignal?: AbortSignal;
  }): Promise<string>;
}

export class SdkGeminiClient implements GeminiClientLike {
  private readonly ai: GoogleGenAI;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async generateText(params: {
    model: string;
    systemInstruction: string;
    contents: string;
    abortSignal?: AbortSignal;
  }): Promise<string> {
    const response = await this.ai.models.generateContent({
      model: params.model,
      contents: params.contents,
      config: {
        systemInstruction: params.systemInstruction,
        temperature: 0.2,
        maxOutputTokens: 500,
        abortSignal: params.abortSignal
      }
    });
    const text = response.text?.trim();
    if (!text) {
      throw new Error('Empty Gemini response');
    }
    return text;
  }
}

export interface ChatContextInput {
  question: string;
  householdInput: HouseholdInput;
  airQuality: AirQualityReading;
  planSummary: {
    routineStatus: 'FEASIBLE' | 'NO_FEASIBLE_OPTION';
    selectedModeLabel: string | null;
    recommendedDepartureTime: string | null;
    availableWindowMinutes?: number;
    baselineCommuteDurationMinutes?: number;
    selectedModeDurationMinutes?: number | null;
    allocatedTravelCostInr: number;
    remainingBudgetInr: number;
    conflictExplanation: string | null;
    constraintChangePrompts: Array<{ constraint: string; suggestion: string }>;
    routineWhat: string;
    indoorWhat: string;
    sustainableWhat: string;
    rejectedModes: Array<{ label: string; reasons: string[] }>;
  };
  planDiff?: PlanDiff | null;
  history: ChatMessage[];
}

export interface TimingFacts {
  earliestReadyTime: string;
  schoolStartTime: string;
  availableWindowMinutes: number;
  baselineCommuteDurationMinutes: number;
  selectedModeDurationMinutes: number | null;
  recommendedDepartureTime: string | null;
}

export function classifyGeminiError(err: unknown): GeminiFailureDiagnosis {
  let status: number | null = null;
  if (err instanceof ApiError) {
    status = err.status;
  } else if (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof (err as { status: unknown }).status === 'number'
  ) {
    status = (err as { status: number }).status;
  }

  const name = err instanceof Error ? err.name.toLowerCase() : '';
  const msg = err instanceof Error ? err.message.toLowerCase() : '';

  if (
    name === 'aborterror' ||
    msg.includes('timed out') ||
    msg.includes('timeout') ||
    msg.includes('aborted') ||
    status === 408 ||
    status === 504
  ) {
    return {
      category: 'timeout',
      status,
      note: 'Gemini request timed out; showing deterministic grounded response.'
    };
  }

  if (
    status === 429 ||
    msg.includes('resource_exhausted') ||
    msg.includes('rate limit') ||
    msg.includes('quota')
  ) {
    return {
      category: 'rate_limit',
      status: status ?? 429,
      note: 'Gemini rate limit or quota reached (HTTP 429); showing deterministic grounded response.'
    };
  }

  if (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 404 ||
    msg.includes('api_key') ||
    msg.includes('api key') ||
    msg.includes('permission_denied') ||
    msg.includes('unauthenticated') ||
    msg.includes('not found')
  ) {
    return {
      category: 'config_error',
      status,
      note: `Gemini configuration error${status ? ` (HTTP ${status})` : ''}; verify GEMINI_API_KEY and GEMINI_MODEL. Showing deterministic grounded response.`
    };
  }

  return {
    category: 'provider_error',
    status,
    note: `Gemini provider unavailable${status ? ` (HTTP ${status})` : ''}; showing deterministic grounded response.`
  };
}

function buildTimingFacts(
  input: HouseholdInput,
  options: {
    availableWindowMinutes?: number;
    baselineCommuteDurationMinutes?: number;
    selectedModeDurationMinutes?: number | null;
    recommendedDepartureTime?: string | null;
  }
): TimingFacts {
  const computedWindow = computeAvailableWindowMinutes(
    input.earliestReadyTime,
    input.schoolStartTime
  );
  return {
    earliestReadyTime: input.earliestReadyTime,
    schoolStartTime: input.schoolStartTime,
    availableWindowMinutes: computedWindow,
    baselineCommuteDurationMinutes: input.commuteDurationMinutes,
    selectedModeDurationMinutes: options.selectedModeDurationMinutes ?? null,
    recommendedDepartureTime: options.recommendedDepartureTime ?? null
  };
}

export class GeminiCoachService {
  private readonly model: string;
  private readonly client: GeminiClientLike | null;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly explanationCache = new BoundedTtlCache<AiExplanationResult>(
    MAX_EXPLANATION_CACHE_ENTRIES
  );

  constructor(options?: {
    apiKey?: string;
    model?: string;
    client?: GeminiClientLike | null;
    timeoutMs?: number;
    retryDelayMs?: number;
  }) {
    const resolvedKey = (
      options?.apiKey ??
      process.env.GEMINI_API_KEY ??
      ''
    ).trim();
    this.model =
      (
        options?.model ??
        process.env.GEMINI_MODEL ??
        DEFAULT_GEMINI_MODEL
      ).trim() || DEFAULT_GEMINI_MODEL;
    this.timeoutMs = options?.timeoutMs ?? GEMINI_TIMEOUT_MS;
    this.retryDelayMs = options?.retryDelayMs ?? DEFAULT_TRANSIENT_RETRY_DELAY_MS;

    if (options?.client !== undefined) {
      this.client = options.client;
    } else {
      this.client = resolvedKey ? new SdkGeminiClient(resolvedKey) : null;
    }
  }

  public isConfigured(): boolean {
    return this.client !== null;
  }

  public getModelName(): string {
    return this.model;
  }

  public async explainMorningPlan(
    input: HouseholdInput,
    plan: MorningPlan,
    diff: PlanDiff | null
  ): Promise<AiExplanationResult> {
    if (!this.client) {
      return this.buildDeterministicPlanFallback(
        input,
        plan,
        diff,
        'GEMINI_API_KEY is not configured on the server.'
      );
    }

    const cacheKey = JSON.stringify({
      city: input.city,
      start: input.schoolStartTime,
      ready: input.earliestReadyTime,
      dur: input.commuteDurationMinutes,
      budget: input.dailyBudget,
      currency: input.budgetCurrency,
      travel: input.travelOptions,
      purifier: input.homePurifier,
      vent: input.homeVentilation,
      asthma: input.childHasAsthmaOrSensitivity,
      pm25: plan.airQualitySnapshot.pm25UgM3,
      mode: plan.selectedModeId,
      diffChanged: diff?.changedInputs ?? []
    });

    const cached = this.explanationCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const selectedEval = plan.evaluatedTravelOptions.find(
      (item) => item.modeId === plan.selectedModeId
    );
    const timingFacts = buildTimingFacts(input, {
      availableWindowMinutes: plan.availableWindowMinutes,
      baselineCommuteDurationMinutes: plan.baselineCommuteDurationMinutes,
      selectedModeDurationMinutes: selectedEval?.requiredMinutes ?? null,
      recommendedDepartureTime: plan.recommendedDepartureTime
    });

    const systemInstruction = [
      'You are the School Smog Planner family coach.',
      'Explain the computed morning plan concisely in plain language using ONLY the structured plan facts provided.',
      'Never override or invent travel feasibility, costs, departure times, or air-quality readings.',
      'Distinguish timingFacts.availableWindowMinutes (schoolStartTime minus earliestReadyTime) from timingFacts.baselineCommuteDurationMinutes (the baseline one-way commute duration before mode multipliers and boarding buffers).',
      'Explicitly distinguish community/tailpipe emissions from what the child personally breathes.',
      'If routineStatus is NO_FEASIBLE_OPTION, clearly explain the constraint conflict and ask the parent which constraint can change today.',
      'If a planDiff is present, briefly state what changed, what stayed relevant, and why.'
    ].join(' ');

    const contents = JSON.stringify({
      householdInput: input,
      timingFacts,
      airQuality: {
        location: plan.airQualitySnapshot.resolvedLocation,
        pm25UgM3: plan.airQualitySnapshot.pm25UgM3,
        usAqi: plan.airQualitySnapshot.usAqi,
        category: plan.airQualitySnapshot.category,
        source: plan.airQualitySnapshot.source
      },
      computedPlan: {
        routineStatus: plan.routineStatus,
        selectedModeLabel: plan.selectedModeLabel,
        recommendedDepartureTime: plan.recommendedDepartureTime,
        availableWindowMinutes: timingFacts.availableWindowMinutes,
        baselineCommuteDurationMinutes: timingFacts.baselineCommuteDurationMinutes,
        remainingBudgetInr: plan.remainingBudgetInr,
        conflictExplanation: plan.conflictExplanation,
        constraintChangePrompts: plan.constraintChangePrompts,
        routine: plan.recommendations.routine.whatToDo,
        indoorAirQuality: plan.recommendations.indoorAirQuality.whatToDo,
        sustainableAlternative:
          plan.recommendations.sustainableAlternative.whatToDo
      },
      planDiff: diff
    });

    const outcome = await this.generateWithDiagnostics(
      'explainMorningPlan',
      systemInstruction,
      contents
    );

    if (!outcome.ok) {
      return this.buildDeterministicPlanFallback(
        input,
        plan,
        diff,
        outcome.diagnosis.note
      );
    }

    const result: AiExplanationResult = {
      text: outcome.text,
      source: 'Gemini AI',
      model: this.model,
      usedFallback: false,
      note: null
    };
    this.explanationCache.set(
      cacheKey,
      result,
      PLAN_EXPLANATION_CACHE_TTL_MS
    );
    return result;
  }

  public async answerFollowUp(
    context: ChatContextInput
  ): Promise<ChatResponsePayload> {
    const timingFacts = buildTimingFacts(context.householdInput, {
      availableWindowMinutes: context.planSummary.availableWindowMinutes,
      baselineCommuteDurationMinutes:
        context.planSummary.baselineCommuteDurationMinutes,
      selectedModeDurationMinutes:
        context.planSummary.selectedModeDurationMinutes ?? null,
      recommendedDepartureTime: context.planSummary.recommendedDepartureTime
    });

    if (!this.client) {
      return this.buildDeterministicChatFallback(
        context,
        timingFacts,
        'GEMINI_API_KEY is not configured on the server.'
      );
    }

    const systemInstruction = [
      'You are the School Smog Planner follow-up Q&A assistant.',
      'Answer the parent’s question using ONLY the latest household inputs, timingFacts, air-quality snapshot, computed plan, and planDiff provided.',
      'Be specific about constraints (travel availability, budget with units, timing window, and PM2.5 safety thresholds).',
      'When timing is relevant, clearly distinguish timingFacts.availableWindowMinutes (schoolStartTime minus earliestReadyTime) from timingFacts.baselineCommuteDurationMinutes (the baseline one-way commute duration before mode multipliers/buffers) and selectedModeDurationMinutes.',
      'Distinguish reduced tailpipe emissions from personal child PM2.5 exposure whenever travel modes are discussed.',
      'If routineStatus is NO_FEASIBLE_OPTION, explain why every option failed and ask which constraint the parent can change.',
      'If planDiff is provided and the user asks why the plan changed, directly explain what changed, what stayed relevant (like IAQ/community actions), and why.'
    ].join(' ');

    const contents = JSON.stringify({
      latestHouseholdInput: context.householdInput,
      timingFacts,
      airQuality: context.airQuality,
      currentPlan: {
        ...context.planSummary,
        availableWindowMinutes: timingFacts.availableWindowMinutes,
        baselineCommuteDurationMinutes:
          timingFacts.baselineCommuteDurationMinutes
      },
      planDiff: context.planDiff ?? null,
      recentHistory: context.history.slice(-4),
      userQuestion: context.question
    });

    const outcome = await this.generateWithDiagnostics(
      'answerFollowUp',
      systemInstruction,
      contents
    );

    if (!outcome.ok) {
      return this.buildDeterministicChatFallback(
        context,
        timingFacts,
        outcome.diagnosis.note
      );
    }

    return {
      answer: outcome.text,
      source: 'Gemini AI',
      model: this.model,
      usedFallback: false,
      note: null
    };
  }

  private async generateWithDiagnostics(
    operation: 'explainMorningPlan' | 'answerFollowUp',
    systemInstruction: string,
    contents: string
  ): Promise<
    { ok: true; text: string } | { ok: false; diagnosis: GeminiFailureDiagnosis }
  > {
    if (!this.client) {
      return {
        ok: false,
        diagnosis: {
          category: 'config_error',
          status: null,
          note: 'GEMINI_API_KEY is not configured on the server.'
        }
      };
    }

    const maxAttempts = 2;
    let lastDiagnosis: GeminiFailureDiagnosis = {
      category: 'provider_error',
      status: null,
      note: 'Gemini service unavailable; showing deterministic grounded response.'
    };

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const text = await this.callWithTimeout(
          systemInstruction,
          contents
        );
        return { ok: true, text };
      } catch (err) {
        lastDiagnosis = classifyGeminiError(err);
        // Log only non-sensitive metadata (no API key, prompts, or household data).
        console.warn(
          '[GeminiCoachFallback]',
          JSON.stringify({
            operation,
            attempt,
            category: lastDiagnosis.category,
            status: lastDiagnosis.status,
            model: this.model
          })
        );

        const isTransient =
          lastDiagnosis.category === 'rate_limit' ||
          lastDiagnosis.category === 'provider_error';
        if (!isTransient || attempt >= maxAttempts) {
          break;
        }
        if (this.retryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
        }
      }
    }

    return { ok: false, diagnosis: lastDiagnosis };
  }

  private buildDeterministicPlanFallback(
    input: HouseholdInput,
    plan: MorningPlan,
    diff: PlanDiff | null,
    note: string
  ): AiExplanationResult {
    const budgetText = formatCurrencyFromInr(
      plan.dailyBudgetInr,
      input.budgetCurrency
    );
    const parts: string[] = [];

    if (diff?.hasPreviousPlan) {
      parts.push(
        `Update summary: ${diff.whyItChanged} Stayed relevant: ${diff.whatStayedRelevant.join(' ') || 'Indoor and community actions remain aligned.'}`
      );
    }

    if (plan.routineStatus === 'NO_FEASIBLE_OPTION') {
      const promptText = plan.constraintChangePrompts
        .map((c) => `${c.constraint} (${c.suggestion})`)
        .join('; ');
      parts.push(
        `No travel option fits all active constraints for ${input.city} (${input.earliestReadyTime} ready to ${input.schoolStartTime} start = ${plan.availableWindowMinutes} min window, ${plan.baselineCommuteDurationMinutes} min baseline commute, ${budgetText} budget, PM2.5 ${plan.airQualitySnapshot.pm25UgM3.toFixed(1)} µg/m³). Which constraint can change today? Options: ${promptText}.`
      );
    } else {
      parts.push(
        `For ${input.city} (PM2.5 ${plan.airQualitySnapshot.pm25UgM3.toFixed(1)} µg/m³, ${plan.airQualitySnapshot.category}), the deterministic planner recommends ${plan.selectedModeLabel} leaving at ${plan.recommendedDepartureTime} within your ${plan.availableWindowMinutes}-minute morning window (${input.earliestReadyTime} ready to ${input.schoolStartTime} start; ${plan.baselineCommuteDurationMinutes}-minute baseline commute) and ${budgetText} budget.`
      );
      parts.push(
        `Remember: shared transit cuts per-student tailpipe emissions, while closed windows plus a snug N95/KF94 mask and home filtration (${plan.recommendations.indoorAirQuality.title}) protect what your child actually breathes.`
      );
    }

    return {
      text: parts.join(' '),
      source: 'Deterministic Fallback (Gemini Unavailable)',
      model: null,
      usedFallback: true,
      note
    };
  }

  private buildDeterministicChatFallback(
    context: ChatContextInput,
    timing: TimingFacts,
    note: string
  ): ChatResponsePayload {
    const q = context.question.toLowerCase();
    const { householdInput, airQuality, planSummary, planDiff } = context;
    const budgetText = formatCurrencyFromInr(
      convertCurrencyToInr(
        householdInput.dailyBudget,
        householdInput.budgetCurrency
      ),
      householdInput.budgetCurrency
    );

    const asksAboutTiming =
      /\b(time|timing|window|minute|minutes|start|ready|depart|departure|leave|duration|commute|buffer|schedule|early|late)\b/.test(
        q
      );

    const timingExplanation = this.formatTimingExplanation(timing, planSummary);

    let answer: string;

    if (
      (q.includes('change') || q.includes('why') || q.includes('bus')) &&
      planDiff?.hasPreviousPlan
    ) {
      const changed =
        planDiff.whatChanged.join(' ') || 'Your travel constraint updated.';
      const stayed =
        planDiff.whatStayedRelevant.join(' ') ||
        'Indoor air quality and school community actions stayed relevant.';
      answer = `${changed} Reason: ${planDiff.whyItChanged} What stayed relevant: ${stayed}${asksAboutTiming ? ` ${timingExplanation}` : ''} (Current inputs: ${householdInput.city}, ${timing.earliestReadyTime} ready to ${timing.schoolStartTime} start [${timing.availableWindowMinutes} min window, ${timing.baselineCommuteDurationMinutes} min baseline commute], School Bus = ${householdInput.travelOptions.schoolBus ? 'Yes' : 'No'}, budget ${budgetText}, PM2.5 ${airQuality.pm25UgM3.toFixed(1)} µg/m³).`;
    } else if (asksAboutTiming) {
      answer = `${timingExplanation} (Current inputs: ${householdInput.city}, School Bus = ${householdInput.travelOptions.schoolBus ? 'Yes' : 'No'}, budget ${budgetText}, PM2.5 ${airQuality.pm25UgM3.toFixed(1)} µg/m³).`;
    } else if (planSummary.routineStatus === 'NO_FEASIBLE_OPTION') {
      const suggestions = planSummary.constraintChangePrompts
        .map((c) => `${c.constraint}: ${c.suggestion}`)
        .join(' | ');
      answer = `No travel option currently fits all constraints for ${householdInput.city} (${timing.earliestReadyTime} ready to ${timing.schoolStartTime} start = ${timing.availableWindowMinutes} min window, ${timing.baselineCommuteDurationMinutes} min baseline commute, ${budgetText} budget, PM2.5 ${airQuality.pm25UgM3.toFixed(1)} µg/m³). Conflict: ${planSummary.conflictExplanation ?? 'All options disqualified.'} Which constraint can change today? Suggested adjustments: ${suggestions}`;
    } else {
      const rejected =
        planSummary.rejectedModes.length > 0
          ? `Excluded options: ${planSummary.rejectedModes
              .map((m) => `${m.label} (${m.reasons.join('; ')})`)
              .join(' | ')}.`
          : '';
      answer = `Based on your latest inputs for ${householdInput.city} (${timing.earliestReadyTime} ready to ${timing.schoolStartTime} start = ${timing.availableWindowMinutes} min window, ${timing.baselineCommuteDurationMinutes} min baseline commute, ${budgetText} budget, School Bus = ${householdInput.travelOptions.schoolBus ? 'Yes' : 'No'}, PM2.5 ${airQuality.pm25UgM3.toFixed(1)} µg/m³): ${planSummary.routineWhat} ${rejected} Meanwhile, indoor protection (${planSummary.indoorWhat}) lowers what your child breathes at home, separate from commute tailpipe emissions.`;
    }

    return {
      answer,
      source: 'Deterministic Fallback (Gemini Unavailable)',
      model: null,
      usedFallback: true,
      note
    };
  }

  private formatTimingExplanation(
    timing: TimingFacts,
    planSummary: ChatContextInput['planSummary']
  ): string {
    const windowSentence = `Your available morning window is ${timing.availableWindowMinutes} minutes (from ${timing.earliestReadyTime} earliest ready time to ${timing.schoolStartTime} school start), while your baseline one-way commute duration is ${timing.baselineCommuteDurationMinutes} minutes.`;

    if (
      planSummary.routineStatus === 'FEASIBLE' &&
      planSummary.selectedModeLabel &&
      timing.recommendedDepartureTime
    ) {
      if (timing.selectedModeDurationMinutes !== null) {
        const slack =
          timing.availableWindowMinutes - timing.selectedModeDurationMinutes;
        return `${windowSentence} ${planSummary.selectedModeLabel} takes ${timing.selectedModeDurationMinutes} minutes door-to-door (including mode factor and boarding buffer), so departing at ${timing.recommendedDepartureTime} fits inside your ${timing.availableWindowMinutes}-minute window with ${Math.max(0, slack)} minutes of margin before ${timing.schoolStartTime}.`;
      }
      return `${windowSentence} ${planSummary.selectedModeLabel} departs at ${timing.recommendedDepartureTime} to arrive by ${timing.schoolStartTime}.`;
    }

    return `${windowSentence} No enabled travel option fits inside this ${timing.availableWindowMinutes}-minute window together with your active budget and smog safety limits.`;
  }

  private async callWithTimeout(
    systemInstruction: string,
    contents: string
  ): Promise<string> {
    if (!this.client) {
      throw new Error('Gemini client is not configured');
    }

    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(new Error(`Gemini request timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
    });

    try {
      return await Promise.race([
        this.client.generateText({
          model: this.model,
          systemInstruction,
          contents,
          abortSignal: controller.signal
        }),
        timeoutPromise
      ]);
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}
