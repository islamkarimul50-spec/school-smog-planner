import { z } from 'zod';

const TIME_24H_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseTimeToMinutes(timeStr: string): number {
  const match = TIME_24H_REGEX.exec(timeStr);
  if (!match) {
    throw new Error(`Invalid HH:MM time string: ${timeStr}`);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours * 60 + minutes;
}

export function formatMinutesToTime(totalMinutes: number): string {
  const clamped = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
  const hh = String(Math.floor(clamped / 60)).padStart(2, '0');
  const mm = String(clamped % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

export const TravelAvailabilitySchema = z.object({
  schoolBus: z.boolean(),
  metroOrPublicTransit: z.boolean(),
  carpool: z.boolean(),
  walkOrCycle: z.boolean(),
  privateCar: z.boolean()
});

export const HouseholdInputSchema = z
  .object({
    city: z
      .string()
      .trim()
      .min(2, 'City must be at least 2 characters.')
      .max(80, 'City name must be 80 characters or fewer.')
      .regex(
        /^[a-zA-Z0-9\s,.\-()/]+$/,
        'City may contain letters, numbers, spaces, commas, periods, and hyphens only.'
      ),
    schoolStartTime: z
      .string()
      .regex(TIME_24H_REGEX, 'School start time must use HH:MM (24-hour) format.'),
    earliestReadyTime: z
      .string()
      .regex(TIME_24H_REGEX, 'Earliest departure time must use HH:MM (24-hour) format.'),
    commuteDurationMinutes: z
      .number({ invalid_type_error: 'Commute duration must be a number in minutes.' })
      .int('Commute duration must be a whole number of minutes.')
      .min(5, 'Commute duration must be at least 5 minutes.')
      .max(180, 'Commute duration cannot exceed 180 minutes.'),
    dailyBudget: z
      .number({ invalid_type_error: 'Daily budget must be a valid number.' })
      .min(0, 'Daily budget cannot be negative.')
      .max(100000, 'Daily budget exceeds supported upper bound (100,000).'),
    budgetCurrency: z.enum(['INR', 'USD']),
    homePurifier: z.enum(['none', 'hepa_purifier', 'diy_box_fan']),
    homeVentilation: z.enum(['drafty_windows', 'sealed_windows', 'shared_hallway']),
    childHasAsthmaOrSensitivity: z.boolean(),
    travelOptions: TravelAvailabilitySchema
  })
  .superRefine((data, ctx) => {
    if (
      !TIME_24H_REGEX.test(data.schoolStartTime) ||
      !TIME_24H_REGEX.test(data.earliestReadyTime)
    ) {
      return;
    }
    const startMins = parseTimeToMinutes(data.schoolStartTime);
    const readyMins = parseTimeToMinutes(data.earliestReadyTime);
    if (readyMins >= startMins) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['earliestReadyTime'],
        message: 'Earliest home departure time must be earlier than school start time.'
      });
    }
  });

export const AirQualityReadingSchema = z.object({
  cityQuery: z.string().trim().min(2).max(80),
  resolvedLocation: z.string().trim().min(2).max(120),
  pm25UgM3: z.number().min(0).max(1500),
  pm10UgM3: z.number().min(0).max(2000).nullable(),
  usAqi: z.number().min(0).max(3500),
  category: z.enum([
    'Good',
    'Moderate',
    'Unhealthy for Sensitive Groups',
    'Unhealthy',
    'Very Unhealthy',
    'Hazardous'
  ]),
  source: z.string().trim().min(2).max(140),
  dataOrigin: z.enum(['live', 'sample', 'manual']),
  timestampIso: z.string().trim().min(10).max(40),
  isStale: z.boolean(),
  staleReason: z.string().max(300).nullable(),
  units: z.object({
    pm25: z.literal('µg/m³'),
    pm10: z.literal('µg/m³'),
    usAqi: z.literal('US AQI (0-500+)')
  })
});

export const ManualAirQualityInputSchema = z.object({
  city: z.string().trim().min(2).max(80),
  pm25UgM3: z
    .number({ invalid_type_error: 'PM2.5 must be a number in µg/m³.' })
    .min(0, 'PM2.5 cannot be negative.')
    .max(1000, 'PM2.5 cannot exceed 1000 µg/m³.')
});

export const PlanRequestSchema = z.object({
  householdInput: HouseholdInputSchema,
  airQuality: AirQualityReadingSchema.optional(),
  previousPlanSummary: z
    .object({
      selectedModeId: z
        .enum(['schoolBus', 'metroOrPublicTransit', 'carpool', 'walkOrCycle', 'privateCar'])
        .nullable(),
      selectedModeLabel: z.string().max(100).nullable(),
      recommendedDepartureTime: z.string().max(10).nullable(),
      allocatedTravelCostInr: z.number().min(0).max(100000),
      indoorActionTitle: z.string().max(160),
      sustainableActionTitle: z.string().max(160),
      householdInput: HouseholdInputSchema
    })
    .optional()
});

export const ChatRequestSchema = z.object({
  question: z
    .string()
    .trim()
    .min(2, 'Please enter a question for the clean-air coach.')
    .max(500, 'Question must be 500 characters or fewer.'),
  householdInput: HouseholdInputSchema,
  airQuality: AirQualityReadingSchema,
  planSummary: z.object({
    routineStatus: z.enum(['FEASIBLE', 'NO_FEASIBLE_OPTION']),
    selectedModeLabel: z.string().max(100).nullable(),
    recommendedDepartureTime: z.string().max(10).nullable(),
    allocatedTravelCostInr: z.number().min(0).max(100000),
    remainingBudgetInr: z.number().min(0).max(100000),
    conflictExplanation: z.string().max(600).nullable(),
    constraintChangePrompts: z.array(
      z.object({
        constraint: z.string().max(100),
        suggestion: z.string().max(240)
      })
    ).max(6),
    routineWhat: z.string().max(500),
    indoorWhat: z.string().max(500),
    sustainableWhat: z.string().max(500),
    rejectedModes: z.array(
      z.object({
        label: z.string().max(100),
        reasons: z.array(z.string().max(240)).max(5)
      })
    ).max(6)
  }),
  planDiff: z
    .object({
      hasPreviousPlan: z.boolean(),
      changedInputs: z.array(z.string().max(180)).max(12),
      whatChanged: z.array(z.string().max(260)).max(8),
      whatStayedRelevant: z.array(z.string().max(260)).max(8),
      whyItChanged: z.string().max(500)
    })
    .nullable()
    .optional(),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().trim().min(1).max(600)
      })
    )
    .max(6)
    .default([])
});

/**
 * Patterns disallowed in public school community messages to protect children and households.
 */
const PII_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: 'phone number', regex: /(?:\+?\d[\d\s\-()]{7,}\d)/ },
  { label: 'email address', regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  {
    label: 'specific home/apartment address',
    regex:
      /\b(?:house|flat|apt|apartment|plot|door|street|st\.|lane|block)\s*(?:no\.?|number|#)?\s*[A-Z0-9-]*\d+[A-Z0-9-]*\b/i
  },
  {
    label: 'child name or personal family identifier',
    regex: /\b(?:my\s+(?:son|daughter|kid|child)\s+[A-Z][a-z]+)\b/
  },
  {
    label: 'household financial or budget figure',
    regex: /(?:₹|\$|INR|USD)\s*\d+/i
  }
];

export function detectCommunityPii(text: string): string[] {
  const hits: string[] = [];
  for (const rule of PII_PATTERNS) {
    if (rule.regex.test(text)) {
      hits.push(rule.label);
    }
  }
  return hits;
}

export const CommunityNoticeInputSchema = z
  .object({
    category: z.enum(['no-idling', 'carpool-corridor', 'smog-alert']),
    corridorZone: z
      .string()
      .trim()
      .min(3, 'Enter a general landmark or corridor zone (at least 3 characters).')
      .max(60, 'Corridor zone must be 60 characters or fewer.'),
    schoolWindow: z
      .string()
      .trim()
      .min(3, 'Enter a general arrival or pickup window (e.g., 07:45-08:05).')
      .max(40, 'Time window must be 40 characters or fewer.'),
    message: z
      .string()
      .trim()
      .min(10, 'Message must be at least 10 characters.')
      .max(240, 'Keep community messages under 240 characters.')
  })
  .superRefine((data, ctx) => {
    const combined = `${data.corridorZone} ${data.message}`;
    const piiHits = detectCommunityPii(combined);
    if (piiHits.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['message'],
        message: `Privacy guard blocked this post because it appears to contain: ${piiHits.join(', ')}. Use only a general corridor landmark and school window.`
      });
    }
  });
