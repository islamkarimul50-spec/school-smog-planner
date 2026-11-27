import { ApiError } from '@google/genai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GeminiCoachService,
  classifyGeminiError,
  type GeminiClientLike
} from '../src/server/services/geminiService.js';
import {
  DEFAULT_HOUSEHOLD_INPUT,
  SAMPLE_AIR_QUALITY_PRESETS,
  formatCurrencyFromInr
} from '../src/shared/constants.js';
import { buildMorningPlan } from '../src/shared/decisionEngine.js';
import type { HouseholdInput } from '../src/shared/types.js';

const DEL_AQ = SAMPLE_AIR_QUALITY_PRESETS.delhi_severe_winter!;

describe('GeminiCoachService diagnostics & timing consistency', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('classifies timeout, rate limit, configuration error, and provider error distinctly', () => {
    expect(
      classifyGeminiError(new Error('Gemini request timed out after 18000ms'))
        .category
    ).toBe('timeout');
    expect(
      classifyGeminiError(new ApiError({ status: 429, message: 'Quota hit' }))
        .category
    ).toBe('rate_limit');
    expect(
      classifyGeminiError(new ApiError({ status: 403, message: 'Bad key' }))
        .category
    ).toBe('config_error');
    expect(
      classifyGeminiError(new ApiError({ status: 503, message: 'Unavailable' }))
        .category
    ).toBe('provider_error');
  });

  it('retries transient 503/429 once and logs only safe metadata without keys, prompts, or household data', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const generateText = vi
      .fn<GeminiClientLike['generateText']>()
      .mockRejectedValueOnce(
        new ApiError({ status: 429, message: 'Rate limited for AIzaSecretLeakCheck' })
      )
      .mockResolvedValueOnce('Recovered Gemini response.');

    const service = new GeminiCoachService({
      client: { generateText },
      retryDelayMs: 0
    });

    const plan = buildMorningPlan(DEFAULT_HOUSEHOLD_INPUT, DEL_AQ);
    const result = await service.explainMorningPlan(
      DEFAULT_HOUSEHOLD_INPUT,
      plan,
      null
    );

    expect(result.usedFallback).toBe(false);
    expect(result.text).toBe('Recovered Gemini response.');
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    const logged = JSON.stringify(warnSpy.mock.calls[0]);
    expect(logged).toContain('rate_limit');
    expect(logged).not.toContain('AIza');
    expect(logged).not.toContain('Delhi-NCR');
    expect(logged).not.toContain('08:00');
  });

  it('does not retry config_error and surfaces labeled fallback with safe note', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const generateText = vi
      .fn<GeminiClientLike['generateText']>()
      .mockRejectedValue(
        new ApiError({ status: 401, message: 'Invalid key AIzaDummy' })
      );

    const service = new GeminiCoachService({
      client: { generateText },
      retryDelayMs: 0
    });

    const plan = buildMorningPlan(DEFAULT_HOUSEHOLD_INPUT, DEL_AQ);
    const result = await service.explainMorningPlan(
      DEFAULT_HOUSEHOLD_INPUT,
      plan,
      null
    );

    expect(result.usedFallback).toBe(true);
    expect(result.source).toBe('Deterministic Fallback (Gemini Unavailable)');
    expect(result.note).toContain('configuration error');
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warnSpy.mock.calls[0])).not.toContain('AIzaDummy');
  });

  it('aborts and falls back cleanly when Gemini exceeds timeoutMs', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let observedAbort = false;
    const slowClient: GeminiClientLike = {
      generateText: vi.fn(
        ({ abortSignal }) =>
          new Promise<string>((resolve) => {
            abortSignal?.addEventListener('abort', () => {
              observedAbort = true;
            });
            setTimeout(() => resolve('Too late'), 150);
          })
      )
    };

    const service = new GeminiCoachService({
      client: slowClient,
      timeoutMs: 25,
      retryDelayMs: 0
    });

    const plan = buildMorningPlan(DEFAULT_HOUSEHOLD_INPUT, DEL_AQ);
    const result = await service.explainMorningPlan(
      DEFAULT_HOUSEHOLD_INPUT,
      plan,
      null
    );

    expect(observedAbort).toBe(true);
    expect(result.usedFallback).toBe(true);
    expect(result.note).toContain('timed out');
  });

  it('passes computed availableWindowMinutes and baselineCommuteDurationMinutes to Gemini and updates fallback timing answers when inputs change', async () => {
    const capturedPayloads: string[] = [];
    const mockClient: GeminiClientLike = {
      generateText: vi.fn(async ({ contents }) => {
        capturedPayloads.push(contents);
        return 'Mock Gemini timing reply.';
      })
    };

    const liveCoach = new GeminiCoachService({ client: mockClient });
    const fallbackCoach = new GeminiCoachService({ apiKey: '' });

    const defaultPlan = buildMorningPlan(DEFAULT_HOUSEHOLD_INPUT, DEL_AQ);
    const busEvalDefault = defaultPlan.evaluatedTravelOptions.find(
      (e) => e.modeId === 'schoolBus'
    )!;

    const timingQuestion =
      'What is our morning timing window versus commute duration?';

    await liveCoach.answerFollowUp({
      question: timingQuestion,
      householdInput: DEFAULT_HOUSEHOLD_INPUT,
      airQuality: DEL_AQ,
      planSummary: {
        routineStatus: defaultPlan.routineStatus,
        selectedModeLabel: defaultPlan.selectedModeLabel,
        recommendedDepartureTime: defaultPlan.recommendedDepartureTime,
        availableWindowMinutes: defaultPlan.availableWindowMinutes,
        baselineCommuteDurationMinutes:
          defaultPlan.baselineCommuteDurationMinutes,
        selectedModeDurationMinutes: busEvalDefault.requiredMinutes,
        allocatedTravelCostInr: defaultPlan.allocatedTravelCostInr,
        remainingBudgetInr: defaultPlan.remainingBudgetInr,
        conflictExplanation: defaultPlan.conflictExplanation,
        constraintChangePrompts: defaultPlan.constraintChangePrompts,
        routineWhat: defaultPlan.recommendations.routine.whatToDo,
        indoorWhat: defaultPlan.recommendations.indoorAirQuality.whatToDo,
        sustainableWhat:
          defaultPlan.recommendations.sustainableAlternative.whatToDo,
        rejectedModes: []
      },
      planDiff: null,
      history: []
    });

    const firstGeminiFacts = JSON.parse(capturedPayloads[0]!).timingFacts;
    expect(firstGeminiFacts.availableWindowMinutes).toBe(60);
    expect(firstGeminiFacts.baselineCommuteDurationMinutes).toBe(25);
    expect(firstGeminiFacts.selectedModeDurationMinutes).toBe(34);

    const fallbackDefault = await fallbackCoach.answerFollowUp({
      question: timingQuestion,
      householdInput: DEFAULT_HOUSEHOLD_INPUT,
      airQuality: DEL_AQ,
      planSummary: {
        routineStatus: defaultPlan.routineStatus,
        selectedModeLabel: defaultPlan.selectedModeLabel,
        recommendedDepartureTime: defaultPlan.recommendedDepartureTime,
        availableWindowMinutes: defaultPlan.availableWindowMinutes,
        baselineCommuteDurationMinutes:
          defaultPlan.baselineCommuteDurationMinutes,
        selectedModeDurationMinutes: busEvalDefault.requiredMinutes,
        allocatedTravelCostInr: defaultPlan.allocatedTravelCostInr,
        remainingBudgetInr: defaultPlan.remainingBudgetInr,
        conflictExplanation: defaultPlan.conflictExplanation,
        constraintChangePrompts: defaultPlan.constraintChangePrompts,
        routineWhat: defaultPlan.recommendations.routine.whatToDo,
        indoorWhat: defaultPlan.recommendations.indoorAirQuality.whatToDo,
        sustainableWhat:
          defaultPlan.recommendations.sustainableAlternative.whatToDo,
        rejectedModes: []
      },
      planDiff: null,
      history: []
    });

    expect(fallbackDefault.usedFallback).toBe(true);
    expect(fallbackDefault.answer).toContain('60 minutes');
    expect(fallbackDefault.answer).toContain('25 minutes');
    expect(fallbackDefault.answer).toContain('34 minutes door-to-door');

    // Change household times and commute duration and verify both Gemini payload & fallback answer reflect the new numbers
    const changedInput: HouseholdInput = {
      ...DEFAULT_HOUSEHOLD_INPUT,
      earliestReadyTime: '07:20',
      schoolStartTime: '08:05',
      commuteDurationMinutes: 30
    };
    const changedPlan = buildMorningPlan(changedInput, DEL_AQ);
    const busEvalChanged = changedPlan.evaluatedTravelOptions.find(
      (e) => e.modeId === 'schoolBus'
    )!;

    await liveCoach.answerFollowUp({
      question: timingQuestion,
      householdInput: changedInput,
      airQuality: DEL_AQ,
      planSummary: {
        routineStatus: changedPlan.routineStatus,
        selectedModeLabel: changedPlan.selectedModeLabel,
        recommendedDepartureTime: changedPlan.recommendedDepartureTime,
        availableWindowMinutes: changedPlan.availableWindowMinutes,
        baselineCommuteDurationMinutes:
          changedPlan.baselineCommuteDurationMinutes,
        selectedModeDurationMinutes: busEvalChanged.requiredMinutes,
        allocatedTravelCostInr: changedPlan.allocatedTravelCostInr,
        remainingBudgetInr: changedPlan.remainingBudgetInr,
        conflictExplanation: changedPlan.conflictExplanation,
        constraintChangePrompts: changedPlan.constraintChangePrompts,
        routineWhat: changedPlan.recommendations.routine.whatToDo,
        indoorWhat: changedPlan.recommendations.indoorAirQuality.whatToDo,
        sustainableWhat:
          changedPlan.recommendations.sustainableAlternative.whatToDo,
        rejectedModes: []
      },
      planDiff: null,
      history: []
    });

    const secondGeminiFacts = JSON.parse(capturedPayloads[1]!).timingFacts;
    expect(secondGeminiFacts.availableWindowMinutes).toBe(45);
    expect(secondGeminiFacts.baselineCommuteDurationMinutes).toBe(30);
    expect(secondGeminiFacts.selectedModeDurationMinutes).toBe(40);

    const fallbackChanged = await fallbackCoach.answerFollowUp({
      question: timingQuestion,
      householdInput: changedInput,
      airQuality: DEL_AQ,
      planSummary: {
        routineStatus: changedPlan.routineStatus,
        selectedModeLabel: changedPlan.selectedModeLabel,
        recommendedDepartureTime: changedPlan.recommendedDepartureTime,
        availableWindowMinutes: changedPlan.availableWindowMinutes,
        baselineCommuteDurationMinutes:
          changedPlan.baselineCommuteDurationMinutes,
        selectedModeDurationMinutes: busEvalChanged.requiredMinutes,
        allocatedTravelCostInr: changedPlan.allocatedTravelCostInr,
        remainingBudgetInr: changedPlan.remainingBudgetInr,
        conflictExplanation: changedPlan.conflictExplanation,
        constraintChangePrompts: changedPlan.constraintChangePrompts,
        routineWhat: changedPlan.recommendations.routine.whatToDo,
        indoorWhat: changedPlan.recommendations.indoorAirQuality.whatToDo,
        sustainableWhat:
          changedPlan.recommendations.sustainableAlternative.whatToDo,
        rejectedModes: []
      },
      planDiff: null,
      history: []
    });

    expect(fallbackChanged.answer).toContain('45 minutes');
    expect(fallbackChanged.answer).toContain('30 minutes');
    expect(fallbackChanged.answer).toContain('40 minutes door-to-door');
    expect(fallbackChanged.answer).not.toContain('60 minutes');
  });

  it('agrees with decisionEngine budget formatting for both INR and USD using shared currency conversion', async () => {
    const fallbackCoach = new GeminiCoachService({ apiKey: '' });

    for (const caseCfg of [
      { dailyBudget: 150, budgetCurrency: 'INR' as const },
      { dailyBudget: 2, budgetCurrency: 'USD' as const },
      { dailyBudget: 1.79, budgetCurrency: 'USD' as const }
    ]) {
      const input: HouseholdInput = {
        ...DEFAULT_HOUSEHOLD_INPUT,
        dailyBudget: caseCfg.dailyBudget,
        budgetCurrency: caseCfg.budgetCurrency
      };
      const plan = buildMorningPlan(input, DEL_AQ);
      const expectedBudgetText = formatCurrencyFromInr(
        plan.dailyBudgetInr,
        input.budgetCurrency
      );

      const planFallback = await fallbackCoach.explainMorningPlan(
        input,
        plan,
        null
      );
      expect(planFallback.text).toContain(expectedBudgetText);

      const busEval = plan.evaluatedTravelOptions.find(
        (e) => e.modeId === 'schoolBus'
      )!;
      const chatFallback = await fallbackCoach.answerFollowUp({
        question: 'What is our budget and commute plan?',
        householdInput: input,
        airQuality: DEL_AQ,
        planSummary: {
          routineStatus: plan.routineStatus,
          selectedModeLabel: plan.selectedModeLabel,
          recommendedDepartureTime: plan.recommendedDepartureTime,
          availableWindowMinutes: plan.availableWindowMinutes,
          baselineCommuteDurationMinutes: plan.baselineCommuteDurationMinutes,
          selectedModeDurationMinutes: busEval.requiredMinutes,
          allocatedTravelCostInr: plan.allocatedTravelCostInr,
          remainingBudgetInr: plan.remainingBudgetInr,
          conflictExplanation: plan.conflictExplanation,
          constraintChangePrompts: plan.constraintChangePrompts,
          routineWhat: plan.recommendations.routine.whatToDo,
          indoorWhat: plan.recommendations.indoorAirQuality.whatToDo,
          sustainableWhat:
            plan.recommendations.sustainableAlternative.whatToDo,
          rejectedModes: []
        },
        planDiff: null,
        history: []
      });

      expect(chatFallback.answer).toContain(expectedBudgetText);
    }
  });
});
