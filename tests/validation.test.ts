import { describe, expect, it } from 'vitest';
import { DEFAULT_HOUSEHOLD_INPUT } from '../src/shared/constants.js';
import {
  CommunityNoticeInputSchema,
  HouseholdInputSchema,
  ManualAirQualityInputSchema,
  detectCommunityPii
} from '../src/shared/validation.js';

describe('validation & privacy guards', () => {
  it('rejects invalid city names, negative budgets, out-of-range duration, and reversed start/ready times', () => {
    expect(
      HouseholdInputSchema.safeParse({
        ...DEFAULT_HOUSEHOLD_INPUT,
        city: '<script>'
      }).success
    ).toBe(false);

    expect(
      HouseholdInputSchema.safeParse({
        ...DEFAULT_HOUSEHOLD_INPUT,
        dailyBudget: -20
      }).success
    ).toBe(false);

    expect(
      HouseholdInputSchema.safeParse({
        ...DEFAULT_HOUSEHOLD_INPUT,
        commuteDurationMinutes: 250
      }).success
    ).toBe(false);

    const reversedTimes = HouseholdInputSchema.safeParse({
      ...DEFAULT_HOUSEHOLD_INPUT,
      schoolStartTime: '08:00',
      earliestReadyTime: '08:15'
    });
    expect(reversedTimes.success).toBe(false);
  });

  it('rejects out-of-bounds manual PM2.5 readings', () => {
    expect(
      ManualAirQualityInputSchema.safeParse({
        city: 'Delhi-NCR',
        pm25UgM3: 1500
      }).success
    ).toBe(false);
  });

  it('blocks community messages containing phone numbers, home addresses, child names, or budget figures', () => {
    expect(detectCommunityPii('Call me on +91 9876543210')).toContain(
      'phone number'
    );
    expect(detectCommunityPii('Pick up at Flat 402 near gate')).toContain(
      'specific home/apartment address'
    );
    expect(detectCommunityPii('Looking for ride for my daughter Ananya')).toContain(
      'child name or personal family identifier'
    );
    expect(detectCommunityPii('Our budget is ₹150 per day')).toContain(
      'household financial or budget figure'
    );

    const blockedPost = CommunityNoticeInputSchema.safeParse({
      category: 'carpool-corridor',
      corridorZone: 'South Metro Gate',
      schoolWindow: '07:45-08:00',
      message: 'Call 9876543210 at House 12 for pickup.'
    });
    expect(blockedPost.success).toBe(false);

    const safePost = CommunityNoticeInputSchema.safeParse({
      category: 'no-idling',
      corridorZone: 'South Gate Pickup Bay',
      schoolWindow: '07:45-08:05',
      message:
        'Please switch engines off while waiting near the pickup gate during severe winter smog.'
    });
    expect(safePost.success).toBe(true);
  });
});
