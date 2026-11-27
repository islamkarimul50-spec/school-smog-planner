import fs from 'node:fs';
import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { SAMPLE_AIR_QUALITY_PRESETS } from '../shared/constants.js';
import { createAirQualityRouter } from './routes/airQuality.js';
import { createChatRouter } from './routes/chat.js';
import { createCommunityRouter } from './routes/community.js';
import { createPlanRouter } from './routes/plan.js';
import { AirQualityService } from './services/airQualityService.js';
import { CommunityStore } from './services/communityStore.js';
import { GeminiCoachService } from './services/geminiService.js';

export interface AppDependencies {
  airQualityService?: AirQualityService;
  geminiService?: GeminiCoachService;
  communityStore?: CommunityStore;
  rateLimitMaxPerMinute?: number;
  staticDistDir?: string;
}

interface RateBucket {
  count: number;
  resetAtMs: number;
}

export function sanitizeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : 'Unexpected server error.';
  return raw
    .replace(/AIza[0-9A-Za-z\-_]{20,}/g, '[REDACTED_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9\-_.]{12,}/gi, 'Bearer [REDACTED]');
}

export function createApp(deps?: AppDependencies): {
  app: Express;
  airQualityService: AirQualityService;
  geminiService: GeminiCoachService;
  communityStore: CommunityStore;
} {
  const app = express();
  const airQualityService = deps?.airQualityService ?? new AirQualityService();
  const geminiService = deps?.geminiService ?? new GeminiCoachService();
  const communityStore = deps?.communityStore ?? new CommunityStore();
  const maxPerMinute = deps?.rateLimitMaxPerMinute ?? 120;

  app.disable('x-powered-by');

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'geolocation=()');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    );
    next();
  });

  app.use(express.json({ limit: '64kb' }));

  // Lightweight sliding-window rate limiter on API endpoints
  const rateBuckets = new Map<string, RateBucket>();
  app.use('/api', (req, res, next) => {
    const ip = req.ip || 'local';
    const now = Date.now();
    if (rateBuckets.size > 1000) {
      for (const [key, entry] of rateBuckets.entries()) {
        if (entry.resetAtMs <= now) {
          rateBuckets.delete(key);
        }
      }
    }
    const current = rateBuckets.get(ip);
    if (!current || current.resetAtMs <= now) {
      rateBuckets.set(ip, { count: 1, resetAtMs: now + 60_000 });
      next();
      return;
    }
    if (current.count >= maxPerMinute) {
      res.status(429).json({
        error: 'Too many requests in one minute. Please wait briefly and try again.'
      });
      return;
    }
    current.count += 1;
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      geminiConfigured: geminiService.isConfigured(),
      geminiModel: geminiService.isConfigured() ? geminiService.getModelName() : null
    });
  });

  // Single-request bootstrap to avoid multi-request waterfall on initial page load
  app.get('/api/bootstrap', async (req, res) => {
    const city =
      typeof req.query.city === 'string' && req.query.city.trim().length >= 2
        ? req.query.city.trim().slice(0, 80)
        : 'Delhi-NCR';

    const aqOutcome = await airQualityService.getAirQualityForCity(city);

    res.json({
      airQuality: aqOutcome.ok ? aqOutcome.reading : null,
      airQualityError: aqOutcome.ok ? null : aqOutcome.message,
      samplePresets: Object.entries(SAMPLE_AIR_QUALITY_PRESETS).map(
        ([key, reading]) => ({ key, reading })
      ),
      communityNotices: communityStore.listNotices(),
      geminiConfigured: geminiService.isConfigured()
    });
  });

  app.use('/api/air-quality', createAirQualityRouter(airQualityService));
  app.use('/api/plan', createPlanRouter(airQualityService, geminiService));
  app.use('/api/chat', createChatRouter(geminiService));
  app.use('/api/community', createCommunityRouter(communityStore));

  // JSON parse / oversized body / unhandled API error guard
  app.use('/api', (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const statusCode =
      typeof err === 'object' &&
      err !== null &&
      'status' in err &&
      typeof (err as { status: unknown }).status === 'number'
        ? (err as { status: number }).status
        : 500;
    const safeStatus = statusCode >= 400 && statusCode < 600 ? statusCode : 500;
    console.error('[API Error]', sanitizeErrorMessage(err));
    res.status(safeStatus).json({
      error:
        safeStatus === 413
          ? 'Request payload exceeds 64 KB limit.'
          : safeStatus === 400
            ? 'Malformed JSON request body.'
            : 'Internal server error while processing your request.'
    });
  });

  const staticDir =
    deps?.staticDistDir ?? path.resolve(process.cwd(), 'dist', 'client');
  const indexHtmlPath = path.join(staticDir, 'index.html');

  if (fs.existsSync(indexHtmlPath)) {
    app.use(express.static(staticDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) {
        next();
        return;
      }
      res.sendFile(indexHtmlPath);
    });
  }

  return { app, airQualityService, geminiService, communityStore };
}
