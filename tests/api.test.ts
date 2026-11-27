import {
  IncomingMessage,
  ServerResponse,
  type OutgoingHttpHeaders
} from 'node:http';
import { Socket } from 'node:net';
import type { Express, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { createApp, sanitizeErrorMessage } from '../src/server/app.js';
import { AirQualityService } from '../src/server/services/airQualityService.js';
import {
  GeminiCoachService,
  type GeminiClientLike
} from '../src/server/services/geminiService.js';
import {
  DEFAULT_HOUSEHOLD_INPUT,
  SAMPLE_AIR_QUALITY_PRESETS
} from '../src/shared/constants.js';

/**
 * In-process Express request runner that executes the full middleware & router
 * pipeline without binding a TCP port (works reliably in offline/sandboxed CI).
 */
async function invokeApp(
  app: Express,
  method: 'GET' | 'POST',
  url: string,
  body?: unknown
): Promise<{ status: number; body: any; headers: OutgoingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const req = new IncomingMessage(socket);
    req.method = method;
    req.url = url;
    req.headers = { host: 'localhost' };

    const serialized = body !== undefined ? JSON.stringify(body) : '';
    if (body !== undefined) {
      req.headers['content-type'] = 'application/json';
      req.headers['content-length'] = String(Buffer.byteLength(serialized));
    }

    const res = new ServerResponse(req);
    const chunks: Buffer[] = [];
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);

    res.write = ((chunk: any, ...rest: any[]) => {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return origWrite(chunk, ...rest);
    }) as typeof res.write;

    res.end = ((chunk?: any, ...rest: any[]) => {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsedBody: unknown = raw;
      try {
        parsedBody = raw ? JSON.parse(raw) : {};
      } catch {
        parsedBody = raw;
      }
      const out = origEnd(chunk, ...rest);
      resolve({
        status: res.statusCode,
        body: parsedBody,
        headers: res.getHeaders()
      });
      return out;
    }) as typeof res.end;

    app(req as unknown as Request, res as unknown as Response, (err?: unknown) => {
      if (err) reject(err);
    });

    if (serialized) {
      req.push(serialized);
    }
    req.push(null);
  });
}

function createMockAqService(shouldFail = false): AirQualityService {
  const mockFetch = vi.fn(async (input: string | URL | Request) => {
    if (shouldFail) {
      return new Response('Upstream error', { status: 503 });
    }
    const url = String(input);
    if (url.includes('geocoding-api.open-meteo.com')) {
      return new Response(
        JSON.stringify({
          results: [
            {
              name: 'New Delhi',
              admin1: 'Delhi',
              country: 'India',
              latitude: 28.6139,
              longitude: 77.209
            }
          ]
        }),
        { status: 200 }
      );
    }
    return new Response(
      JSON.stringify({
        current: {
          time: new Date().toISOString().slice(0, 16),
          pm2_5: 245,
          pm10: 360,
          us_aqi: 295
        }
      }),
      { status: 200 }
    );
  });
  return new AirQualityService({ fetchImpl: mockFetch as typeof fetch });
}

describe('Express API integration (offline, repeatable without live API keys)', () => {
  it('runs the full Delhi-NCR acceptance workflow with deterministic fallback when Gemini fails or has no key', async () => {
    const failingClient: GeminiClientLike = {
      generateText: vi.fn(async () => {
        throw new Error('Simulated Gemini 503 outage');
      })
    };

    const { app } = createApp({
      airQualityService: createMockAqService(false),
      geminiService: new GeminiCoachService({
        client: failingClient,
        model: 'gemini-3.5-flash-lite'
      })
    });

    const bootstrapRes = await invokeApp(app, 'GET', '/api/bootstrap?city=Delhi-NCR');
    expect(bootstrapRes.status).toBe(200);
    expect(bootstrapRes.body.airQuality.pm25UgM3).toBe(245);
    expect(bootstrapRes.headers['x-content-type-options']).toBe('nosniff');

    // Step 1: Bus available = true
    const plan1Res = await invokeApp(app, 'POST', '/api/plan', {
      householdInput: DEFAULT_HOUSEHOLD_INPUT,
      airQuality: bootstrapRes.body.airQuality
    });

    expect(plan1Res.status).toBe(200);
    expect(plan1Res.body.plan.selectedModeId).toBe('schoolBus');
    expect(plan1Res.body.aiExplanation.usedFallback).toBe(true);
    expect(plan1Res.body.aiExplanation.source).toBe(
      'Deterministic Fallback (Gemini Unavailable)'
    );

    // Step 2: Change ONLY bus availability to false
    const updatedInput = {
      ...DEFAULT_HOUSEHOLD_INPUT,
      travelOptions: {
        ...DEFAULT_HOUSEHOLD_INPUT.travelOptions,
        schoolBus: false
      }
    };

    const plan2Res = await invokeApp(app, 'POST', '/api/plan', {
      householdInput: updatedInput,
      airQuality: bootstrapRes.body.airQuality,
      previousPlanSummary: {
        selectedModeId: plan1Res.body.plan.selectedModeId,
        selectedModeLabel: plan1Res.body.plan.selectedModeLabel,
        recommendedDepartureTime: plan1Res.body.plan.recommendedDepartureTime,
        allocatedTravelCostInr: plan1Res.body.plan.allocatedTravelCostInr,
        indoorActionTitle:
          plan1Res.body.plan.recommendations.indoorAirQuality.title,
        sustainableActionTitle:
          plan1Res.body.plan.recommendations.sustainableAlternative.title,
        householdInput: DEFAULT_HOUSEHOLD_INPUT
      }
    });

    expect(plan2Res.status).toBe(200);
    expect(plan2Res.body.plan.selectedModeId).toBe('metroOrPublicTransit');
    expect(plan2Res.body.diff.whatChanged[0]).toContain('Shared School Bus');
    expect(plan2Res.body.diff.whatStayedRelevant.length).toBeGreaterThan(0);

    // Step 3: Ask follow-up question "Why did my travel plan change?"
    const chatRes = await invokeApp(app, 'POST', '/api/chat', {
      question: 'Why did my travel plan change?',
      householdInput: updatedInput,
      airQuality: bootstrapRes.body.airQuality,
      planSummary: {
        routineStatus: plan2Res.body.plan.routineStatus,
        selectedModeLabel: plan2Res.body.plan.selectedModeLabel,
        recommendedDepartureTime: plan2Res.body.plan.recommendedDepartureTime,
        allocatedTravelCostInr: plan2Res.body.plan.allocatedTravelCostInr,
        remainingBudgetInr: plan2Res.body.plan.remainingBudgetInr,
        conflictExplanation: plan2Res.body.plan.conflictExplanation,
        constraintChangePrompts: plan2Res.body.plan.constraintChangePrompts,
        routineWhat: plan2Res.body.plan.recommendations.routine.whatToDo,
        indoorWhat:
          plan2Res.body.plan.recommendations.indoorAirQuality.whatToDo,
        sustainableWhat:
          plan2Res.body.plan.recommendations.sustainableAlternative.whatToDo,
        rejectedModes: plan2Res.body.plan.evaluatedTravelOptions
          .filter((o: { feasible: boolean }) => !o.feasible)
          .map((o: { label: string; rejectionReasons: string[] }) => ({
            label: o.label,
            reasons: o.rejectionReasons
          }))
      },
      planDiff: plan2Res.body.diff,
      history: []
    });

    expect(chatRes.status).toBe(200);
    expect(chatRes.body.usedFallback).toBe(true);
    expect(chatRes.body.answer).toContain('Shared School Bus');
    expect(chatRes.body.answer).toContain('School Bus = No');
  });

  it('passes latest household inputs & diff to Gemini client when configured', async () => {
    const generateSpy = vi.fn<GeminiClientLike['generateText']>(async () => {
      return 'Your plan moved from Shared School Bus to Metro / Public Transit because School Bus was set to No, while your Indoor Air Quality action stayed relevant.';
    });
    const mockGeminiClient: GeminiClientLike = { generateText: generateSpy };

    const { app } = createApp({
      airQualityService: createMockAqService(false),
      geminiService: new GeminiCoachService({
        client: mockGeminiClient,
        model: 'gemini-3.5-flash-lite'
      })
    });

    const sampleAq = SAMPLE_AIR_QUALITY_PRESETS.delhi_severe_winter!;
    const planRes = await invokeApp(app, 'POST', '/api/plan', {
      householdInput: DEFAULT_HOUSEHOLD_INPUT,
      airQuality: sampleAq
    });
    expect(planRes.status).toBe(200);
    expect(planRes.body.aiExplanation.usedFallback).toBe(false);
    expect(planRes.body.aiExplanation.source).toBe('Gemini AI');

    const chatRes = await invokeApp(app, 'POST', '/api/chat', {
      question: 'Why did my travel plan change?',
      householdInput: {
        ...DEFAULT_HOUSEHOLD_INPUT,
        travelOptions: {
          ...DEFAULT_HOUSEHOLD_INPUT.travelOptions,
          schoolBus: false
        }
      },
      airQuality: sampleAq,
      planSummary: {
        routineStatus: 'FEASIBLE',
        selectedModeLabel: 'Metro / Public Transit + Covered Feeder',
        recommendedDepartureTime: '07:18',
        allocatedTravelCostInr: 90,
        remainingBudgetInr: 60,
        conflictExplanation: null,
        constraintChangePrompts: [],
        routineWhat: 'Take Metro',
        indoorWhat: 'Run DIY filter',
        sustainableWhat: 'Carpool',
        rejectedModes: []
      },
      planDiff: {
        hasPreviousPlan: true,
        changedInputs: ['Shared School Bus availability: Yes → No'],
        whatChanged: ['Switched to Metro'],
        whatStayedRelevant: ['Indoor Air Quality stayed relevant'],
        whyItChanged: 'Bus marked No'
      },
      history: []
    });

    expect(chatRes.status).toBe(200);
    expect(chatRes.body.usedFallback).toBe(false);
    expect(generateSpy).toHaveBeenCalled();
    const lastCallArg =
      generateSpy.mock.calls[generateSpy.mock.calls.length - 1]?.[0];
    expect(lastCallArg).toBeDefined();
    expect(lastCallArg?.contents).toContain('"schoolBus":false');
    expect(lastCallArg?.contents).toContain('Why did my travel plan change?');
  });

  it('handles unavailable live air quality gracefully, rejects invalid input & PII, and enforces body size/security', async () => {
    const { app } = createApp({
      airQualityService: createMockAqService(true),
      geminiService: new GeminiCoachService({ apiKey: '' })
    });

    const aqFailRes = await invokeApp(
      app,
      'GET',
      '/api/air-quality?city=Delhi-NCR'
    );
    expect(aqFailRes.status).toBe(503);
    expect(aqFailRes.body.status).toBe('unavailable');
    expect(aqFailRes.body.samplePresets.length).toBeGreaterThan(0);

    const invalidPlanRes = await invokeApp(app, 'POST', '/api/plan', {
      householdInput: {
        ...DEFAULT_HOUSEHOLD_INPUT,
        schoolStartTime: 'bad-time'
      }
    });
    expect(invalidPlanRes.status).toBe(400);

    const piiPostRes = await invokeApp(app, 'POST', '/api/community', {
      category: 'carpool-corridor',
      corridorZone: 'Main Gate',
      schoolWindow: '07:45-08:00',
      message: 'Pick up my son Aarav at Flat 12B, call 9988776655.'
    });
    expect(piiPostRes.status).toBe(400);
    expect(piiPostRes.body.error).toContain('Privacy guard');

    const oversizedPayload = { pad: 'a'.repeat(70_000) };
    const oversizedRes = await invokeApp(
      app,
      'POST',
      '/api/plan',
      oversizedPayload
    );
    expect(oversizedRes.status).toBe(413);

    const syntheticKeyPattern = ['AIza', 'SyD1234567890ABCDEFGHIJKLMNOP'].join('');
    expect(
      sanitizeErrorMessage(new Error(`Failed using ${syntheticKeyPattern}`))
    ).toBe('Failed using [REDACTED_KEY]');

    const manualAqRes = await invokeApp(app, 'POST', '/api/air-quality/manual', {
      city: 'Delhi-NCR',
      pm25UgM3: 185
    });
    expect(manualAqRes.status).toBe(200);
    expect(manualAqRes.body.airQuality.dataOrigin).toBe('manual');
    expect(manualAqRes.body.airQuality.pm25UgM3).toBe(185);
    expect(manualAqRes.body.airQuality.usAqi).toBeGreaterThanOrEqual(200);

    const { app: strictRateApp } = createApp({
      airQualityService: createMockAqService(false),
      geminiService: new GeminiCoachService({ apiKey: '' }),
      rateLimitMaxPerMinute: 2
    });
    expect((await invokeApp(strictRateApp, 'GET', '/api/health')).status).toBe(200);
    expect((await invokeApp(strictRateApp, 'GET', '/api/health')).status).toBe(200);
    expect((await invokeApp(strictRateApp, 'GET', '/api/health')).status).toBe(429);
  });
});
