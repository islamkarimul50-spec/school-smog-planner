import { GoogleGenAI } from '@google/genai';
import { formatCurrencyFromInr } from '../../shared/constants.js';
import type {
  AiExplanationResult,
  AirQualityReading,
  ChatMessage,
  ChatResponsePayload,
  HouseholdInput,
  MorningPlan,
  PlanDiff
} from '../../shared/types.js';

const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
const GEMINI_TIMEOUT_MS = 10000;

export interface GeminiClientLike {
  generateText(params: {
    model: string;
    systemInstruction: string;
    contents: string;
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
  }): Promise<string> {
    const response = await this.ai.models.generateContent({
      model: params.model,
      contents: params.contents,
      config: {
        systemInstruction: params.systemInstruction,
        temperature: 0.2,
        maxOutputTokens: 450
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

const PLAN_EXPLANATION_CACHE_TTL_MS = 5 * 60 * 1000;

export class GeminiCoachService {
  private readonly model: string;
  private readonly client: GeminiClientLike | null;
  private readonly explanationCache = new Map<
    string,
    { result: AiExplanationResult; expiresAtMs: number }
  >();

  constructor(options?: {
    apiKey?: string;
    model?: string;
    client?: GeminiClientLike | null;
  }) {
    const resolvedKey = (options?.apiKey ?? process.env.GEMINI_API_KEY ?? '').trim();
    this.model = (
      options?.model ??
      process.env.GEMINI_MODEL ??
      DEFAULT_GEMINI_MODEL
    ).trim() || DEFAULT_GEMINI_MODEL;

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
    if (cached && cached.expiresAtMs > Date.now()) {
      return cached.result;
    }

    const systemInstruction = [
      'You are the School Smog Planner family coach.',
      'Explain the computed morning plan concisely in plain language using ONLY the structured plan facts provided.',
      'Never override or invent travel feasibility, costs, departure times, or air-quality readings.',
      'Explicitly distinguish community/tailpipe emissions from what the child personally breathes.',
      'If routineStatus is NO_FEASIBLE_OPTION, clearly explain the constraint conflict and ask the parent which constraint can change today.',
      'If a planDiff is present, briefly state what changed, what stayed relevant, and why.'
    ].join(' ');

    const contents = JSON.stringify({
      householdInput: input,
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
        remainingBudgetInr: plan.remainingBudgetInr,
        conflictExplanation: plan.conflictExplanation,
        constraintChangePrompts: plan.constraintChangePrompts,
        routine: plan.recommendations.routine.whatToDo,
        indoorAirQuality: plan.recommendations.indoorAirQuality.whatToDo,
        sustainableAlternative: plan.recommendations.sustainableAlternative.whatToDo
      },
      planDiff: diff
    });

    try {
      const text = await this.withTimeout(
        this.client.generateText({
          model: this.model,
          systemInstruction,
          contents
        })
      );
      const result: AiExplanationResult = {
        text,
        source: 'Gemini AI',
        model: this.model,
        usedFallback: false,
        note: null
      };
      this.explanationCache.set(cacheKey, {
        result,
        expiresAtMs: Date.now() + PLAN_EXPLANATION_CACHE_TTL_MS
      });
      return result;
    } catch {
      return this.buildDeterministicPlanFallback(
        input,
        plan,
        diff,
        'Gemini service was unavailable or timed out; showing deterministic grounded explanation.'
      );
    }
  }

  public async answerFollowUp(
    context: ChatContextInput
  ): Promise<ChatResponsePayload> {
    if (!this.client) {
      return this.buildDeterministicChatFallback(
        context,
        'GEMINI_API_KEY is not configured on the server.'
      );
    }

    const systemInstruction = [
      'You are the School Smog Planner follow-up Q&A assistant.',
      'Answer the parent’s question using ONLY the latest household inputs, air-quality snapshot, computed plan, and planDiff provided.',
      'Be specific about constraints (travel availability, budget with units, timing window, and PM2.5 safety thresholds).',
      'Distinguish reduced tailpipe emissions from personal child PM2.5 exposure whenever travel modes are discussed.',
      'If routineStatus is NO_FEASIBLE_OPTION, explain why every option failed and ask which constraint the parent can change.',
      'If planDiff is provided and the user asks why the plan changed, directly explain what changed, what stayed relevant (like IAQ/community actions), and why.'
    ].join(' ');

    const contents = JSON.stringify({
      latestHouseholdInput: context.householdInput,
      airQuality: context.airQuality,
      currentPlan: context.planSummary,
      planDiff: context.planDiff ?? null,
      recentHistory: context.history.slice(-4),
      userQuestion: context.question
    });

    try {
      const text = await this.withTimeout(
        this.client.generateText({
          model: this.model,
          systemInstruction,
          contents
        })
      );
      return {
        answer: text,
        source: 'Gemini AI',
        model: this.model,
        usedFallback: false,
        note: null
      };
    } catch {
      return this.buildDeterministicChatFallback(
        context,
        'Gemini service failed or timed out; showing deterministic grounded response.'
      );
    }
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
        `No travel option fits all active constraints for ${input.city} (${input.schoolStartTime} start, ${budgetText} budget, PM2.5 ${plan.airQualitySnapshot.pm25UgM3.toFixed(1)} µg/m³). Which constraint can change today? Options: ${promptText}.`
      );
    } else {
      parts.push(
        `For ${input.city} (PM2.5 ${plan.airQualitySnapshot.pm25UgM3.toFixed(1)} µg/m³, ${plan.airQualitySnapshot.category}), the deterministic planner recommends ${plan.selectedModeLabel} leaving at ${plan.recommendedDepartureTime} to reach school by ${input.schoolStartTime} within your ${budgetText} budget.`
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
    note: string
  ): ChatResponsePayload {
    const q = context.question.toLowerCase();
    const { householdInput, airQuality, planSummary, planDiff } = context;
    const budgetText = formatCurrencyFromInr(
      householdInput.budgetCurrency === 'INR'
        ? householdInput.dailyBudget
        : householdInput.dailyBudget * 84,
      householdInput.budgetCurrency
    );

    let answer: string;

    if (
      (q.includes('change') || q.includes('why') || q.includes('bus')) &&
      planDiff?.hasPreviousPlan
    ) {
      const changed = planDiff.whatChanged.join(' ') || 'Your travel constraint updated.';
      const stayed =
        planDiff.whatStayedRelevant.join(' ') ||
        'Indoor air quality and school community actions stayed relevant.';
      answer = `${changed} Reason: ${planDiff.whyItChanged} What stayed relevant: ${stayed} (Current inputs: ${householdInput.city}, ${householdInput.schoolStartTime} start, School Bus = ${householdInput.travelOptions.schoolBus ? 'Yes' : 'No'}, budget ${budgetText}, PM2.5 ${airQuality.pm25UgM3.toFixed(1)} µg/m³).`;
    } else if (planSummary.routineStatus === 'NO_FEASIBLE_OPTION') {
      const suggestions = planSummary.constraintChangePrompts
        .map((c) => `${c.constraint}: ${c.suggestion}`)
        .join(' | ');
      answer = `No travel option currently fits all constraints for ${householdInput.city} (${householdInput.schoolStartTime} start, ${budgetText} budget, PM2.5 ${airQuality.pm25UgM3.toFixed(1)} µg/m³). Conflict: ${planSummary.conflictExplanation ?? 'All options disqualified.'} Which constraint can change today? Suggested adjustments: ${suggestions}`;
    } else {
      const rejected =
        planSummary.rejectedModes.length > 0
          ? `Excluded options: ${planSummary.rejectedModes
              .map((m) => `${m.label} (${m.reasons.join('; ')})`)
              .join(' | ')}.`
          : '';
      answer = `Based on your latest inputs for ${householdInput.city} (${householdInput.schoolStartTime} start, ${budgetText} budget, School Bus = ${householdInput.travelOptions.schoolBus ? 'Yes' : 'No'}, PM2.5 ${airQuality.pm25UgM3.toFixed(1)} µg/m³): ${planSummary.routineWhat} ${rejected} Meanwhile, indoor protection (${planSummary.indoorWhat}) lowers what your child breathes at home, separate from commute tailpipe emissions.`;
    }

    return {
      answer,
      source: 'Deterministic Fallback (Gemini Unavailable)',
      model: null,
      usedFallback: true,
      note
    };
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error('Gemini request timed out')),
        GEMINI_TIMEOUT_MS
      );
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}
