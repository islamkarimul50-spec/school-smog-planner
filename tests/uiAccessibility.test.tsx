// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/client/App.js';
import {
  DEFAULT_HOUSEHOLD_INPUT,
  SAMPLE_AIR_QUALITY_PRESETS,
  SEEDED_COMMUNITY_NOTICES
} from '../src/shared/constants.js';
import { buildMorningPlan, computePlanDiff } from '../src/shared/decisionEngine.js';

describe('UI Accessibility, Keyboard Workflow & Request Efficiency', () => {
  let fetchCalls: Array<{ url: string; method: string }> = [];

  beforeEach(() => {
    fetchCalls = [];
    const delhiAq = SAMPLE_AIR_QUALITY_PRESETS.delhi_severe_winter!;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        fetchCalls.push({ url, method });

        if (url.startsWith('/api/bootstrap')) {
          return new Response(
            JSON.stringify({
              airQuality: {
                ...delhiAq,
                source: 'Live · Open-Meteo Air Quality API',
                dataOrigin: 'live'
              },
              airQualityError: null,
              samplePresets: Object.entries(SAMPLE_AIR_QUALITY_PRESETS).map(
                ([key, reading]) => ({ key, reading })
              ),
              communityNotices: SEEDED_COMMUNITY_NOTICES,
              geminiConfigured: false
            }),
            { status: 200 }
          );
        }

        if (url === '/api/plan' && method === 'POST') {
          const body = JSON.parse(String(init?.body ?? '{}'));
          const plan = buildMorningPlan(body.householdInput, body.airQuality ?? delhiAq);
          const diff = computePlanDiff(
            body.previousPlanSummary,
            plan,
            body.householdInput
          );
          return new Response(
            JSON.stringify({
              plan,
              diff,
              aiExplanation: {
                text: diff?.hasPreviousPlan
                  ? diff.whyItChanged
                  : 'Deterministic test explanation.',
                source: 'Deterministic Fallback (Gemini Unavailable)',
                model: null,
                usedFallback: true,
                note: 'Test mock'
              }
            }),
            { status: 200 }
          );
        }

        if (url === '/api/chat' && method === 'POST') {
          const body = JSON.parse(String(init?.body ?? '{}'));
          return new Response(
            JSON.stringify({
              answer: `Updated plan reflects School Bus = ${body.householdInput.travelOptions.schoolBus ? 'Yes' : 'No'}: ${body.planSummary.selectedModeLabel}.`,
              source: 'Deterministic Fallback (Gemini Unavailable)',
              model: null,
              usedFallback: true,
              note: null
            }),
            { status: 200 }
          );
        }

        return new Response(JSON.stringify({ error: 'Not found' }), {
          status: 404
        });
      })
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('completes keyboard workflow, verifies non-color indicators, and keeps network requests minimal', async () => {
    const user = userEvent.setup();
    render(<App />);

    // 1. Initial load: exactly 1 bootstrap request
    await waitFor(() => {
      expect(screen.getByText(/245\.0 µg\/m³/i)).toBeInTheDocument();
    });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toContain('/api/bootstrap');

    // 2. Typing in city/budget must NOT trigger extra network calls
    const budgetInput = screen.getByLabelText(/Daily Morning Budget/i);
    await user.clear(budgetInput);
    await user.type(budgetInput, String(DEFAULT_HOUSEHOLD_INPUT.dailyBudget));
    expect(fetchCalls).toHaveLength(1);

    // 3. Submit initial plan using keyboard Enter on button
    const generateButton = screen.getByRole('button', {
      name: /Generate Morning Plan/i
    });
    generateButton.focus();
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(
        screen.getByText(/\[PLAN READY\] Recommended Commute: Shared School Bus/i)
      ).toBeInTheDocument();
    });
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[1]).toEqual({ url: '/api/plan', method: 'POST' });

    // 4. Keyboard-toggle ONLY Shared School Bus off via Space and submit Update Morning Plan
    const busCheckbox = screen.getByRole('checkbox', {
      name: /Shared School Bus/i
    });
    busCheckbox.focus();
    await user.keyboard(' ');
    expect(busCheckbox).not.toBeChecked();

    const updateButton = screen.getByRole('button', {
      name: /Update Morning Plan/i
    });
    updateButton.focus();
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(
        screen.getByText(
          /Plan Comparison: What Changed & What Stayed Relevant/i
        )
      ).toBeInTheDocument();
    });

    // Efficiency check: toggling bus + updating added strictly 1 POST /api/plan (zero extra AQ/community calls)
    expect(fetchCalls).toHaveLength(3);
    expect(fetchCalls[2]).toEqual({ url: '/api/plan', method: 'POST' });

    // Non-color indicators check
    expect(screen.getByText(/\[CHANGED\] What Changed/i)).toBeInTheDocument();
    expect(
      screen.getByText(/\[STAYED RELEVANT\] What Stayed Relevant/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/\[SELECTED\] 07:18/i)).toBeInTheDocument();

    // 5. Ask Coach follow-up via keyboard
    const quickQuestionBtn = screen.getByRole('button', {
      name: 'Why did my travel plan change?'
    });
    quickQuestionBtn.focus();
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(
        screen.getByText(/Updated plan reflects School Bus = No/i)
      ).toBeInTheDocument();
    });
  });

  it('announces readable field errors via role="alert" on invalid submission without calling API', async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/245\.0 µg\/m³/i)).toBeInTheDocument();
    });

    const budgetInput = screen.getByLabelText(/Daily Morning Budget/i);
    await user.clear(budgetInput);
    await user.type(budgetInput, '-10');

    await user.click(
      screen.getByRole('button', { name: /Generate Morning Plan/i })
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Daily budget cannot be negative/i
    );
    expect(fetchCalls).toHaveLength(1);
  });
});
