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
  let fetchCalls: Array<{ url: string; method: string; body?: string }> = [];

  beforeEach(() => {
    fetchCalls = [];
    const delhiAq = SAMPLE_AIR_QUALITY_PRESETS.delhi_severe_winter!;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        fetchCalls.push({
          url,
          method,
          body: typeof init?.body === 'string' ? init.body : undefined
        });

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

        if (url === '/api/community' && method === 'POST') {
          const body = JSON.parse(String(init?.body ?? '{}'));
          const notice = {
            id: 'posted-1',
            ...body,
            createdAtIso: '2026-11-27T07:05:00.000Z',
            isSample: false
          };
          return new Response(
            JSON.stringify({
              notice,
              notices: [notice, ...SEEDED_COMMUNITY_NOTICES]
            }),
            { status: 201 }
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
    expect(fetchCalls[1]).toMatchObject({ url: '/api/plan', method: 'POST' });

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
    expect(fetchCalls[2]).toMatchObject({ url: '/api/plan', method: 'POST' });

    // Non-color indicators check
    expect(screen.getByText(/\[CHANGED\] What Changed/i)).toBeInTheDocument();
    expect(
      screen.getByText(/\[STAYED RELEVANT\] What Stayed Relevant/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/\[SELECTED\] 07:18/i)).toBeInTheDocument();

    // 5. Ask Coach follow-up via keyboard and verify timing facts sent
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
    const chatPayload = JSON.parse(fetchCalls[3]!.body!);
    expect(chatPayload.planSummary.availableWindowMinutes).toBe(60);
    expect(chatPayload.planSummary.baselineCommuteDurationMinutes).toBe(25);
  });

  it('enforces community privacy guard and allows safe corridor posting via keyboard', async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/245\.0 µg\/m³/i)).toBeInTheDocument();
    });

    const msgBox = screen.getByLabelText(/Short Anonymous Message/i);
    const postBtn = screen.getByRole('button', {
      name: /Post to Corridor Board/i
    });

    await user.type(msgBox, ' call 9876543210');
    expect(screen.getByRole('alert')).toHaveTextContent(/Privacy Guard Warning/i);
    expect(postBtn).toBeDisabled();

    await user.clear(msgBox);
    await user.type(
      msgBox,
      'Engines off near Main Gate during 08:00 morning drop-off.'
    );
    expect(postBtn).toBeEnabled();

    postBtn.focus();
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(
        screen.getByText(/Posted privacy-checked notice to the School Corridor Board/i)
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

  it('recovers from unavailable live air quality via sample preset and manual PM2.5 entry', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.startsWith('/api/bootstrap')) {
          return new Response(
            JSON.stringify({
              airQuality: null,
              airQualityError: 'Simulated Open-Meteo outage',
              samplePresets: Object.entries(SAMPLE_AIR_QUALITY_PRESETS).map(
                ([key, reading]) => ({ key, reading })
              ),
              communityNotices: SEEDED_COMMUNITY_NOTICES,
              geminiConfigured: false
            }),
            { status: 200 }
          );
        }
        if (url === '/api/air-quality/manual' && method === 'POST') {
          const body = JSON.parse(String(init?.body ?? '{}'));
          return new Response(
            JSON.stringify({
              status: 'ok',
              airQuality: {
                ...SAMPLE_AIR_QUALITY_PRESETS.delhi_severe_winter!,
                pm25UgM3: body.pm25UgM3,
                usAqi: 240,
                category: 'Very Unhealthy',
                source: 'Manual · Parent-Entered Local Reading',
                dataOrigin: 'manual'
              }
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ error: 'Not found' }), {
          status: 404
        });
      })
    );

    render(<App />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Simulated Open-Meteo outage/i
    );

    await user.click(
      screen.getByRole('button', {
        name: /Load Delhi-NCR Winter Inversion Scenario/i
      })
    );
    expect(screen.getByText(/245\.0 µg\/m³/i)).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: /Enter PM2\.5 Manually/i })
    );
    const manualInput = screen.getByLabelText(/Manual Local PM2\.5 Reading/i);
    await user.clear(manualInput);
    await user.type(manualInput, '180');
    await user.click(
      screen.getByRole('button', { name: /Apply Manual Reading/i })
    );

    await waitFor(() => {
      expect(screen.getByText(/180\.0 µg\/m³/i)).toBeInTheDocument();
    });
  });
});
