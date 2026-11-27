import { useState, type FormEvent } from 'react';
import {
  HOME_PURIFIER_LABELS,
  HOME_VENTILATION_LABELS,
  TRAVEL_MODE_ORDER,
  TRAVEL_MODE_SPECS,
  formatCurrencyFromInr
} from '../../shared/constants.js';
import type {
  HomePurifierType,
  HomeVentilationType,
  HouseholdInput,
  TravelModeId
} from '../../shared/types.js';
import { HouseholdInputSchema } from '../../shared/validation.js';

interface HouseholdFormProps {
  value: HouseholdInput;
  onChange: (next: HouseholdInput) => void;
  onSubmit: (validated: HouseholdInput) => Promise<void>;
  onResetDefaults: () => void;
  hasGeneratedPlan: boolean;
  isSubmitting: boolean;
}

export function HouseholdForm({
  value,
  onChange,
  onSubmit,
  onResetDefaults,
  hasGeneratedPlan,
  isSubmitting
}: HouseholdFormProps) {
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [summaryError, setSummaryError] = useState<string | null>(null);

  function updateTravelOption(modeId: TravelModeId, checked: boolean) {
    onChange({
      ...value,
      travelOptions: {
        ...value.travelOptions,
        [modeId]: checked
      }
    });
  }

  async function handleFormSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = HouseholdInputSchema.safeParse(value);
    if (!parsed.success) {
      const nextErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? 'form');
        if (!nextErrors[key]) {
          nextErrors[key] = issue.message;
        }
      }
      setFieldErrors(nextErrors);
      setSummaryError(
        parsed.error.issues[0]?.message ??
          'Please fix the highlighted fields before generating your plan.'
      );
      return;
    }

    setFieldErrors({});
    setSummaryError(null);
    await onSubmit(parsed.data);
  }

  return (
    <section className="card" aria-labelledby="household-form-heading">
      <h2 id="household-form-heading">Household Constraints &amp; Options</h2>

      {summaryError && (
        <div className="alert alert--danger" role="alert">
          <strong>Check form inputs:</strong> {summaryError}
        </div>
      )}

      <form onSubmit={handleFormSubmit} noValidate>
        <div className="form-field">
          <label htmlFor="city-input">City / Metro Area</label>
          <input
            id="city-input"
            type="text"
            value={value.city}
            onChange={(e) => onChange({ ...value, city: e.target.value })}
            aria-invalid={Boolean(fieldErrors.city)}
            aria-describedby={fieldErrors.city ? 'city-error' : 'city-hint'}
          />
          <span id="city-hint" className="field-hint">
            Example: Delhi-NCR, Lahore, Bengaluru, London.
          </span>
          {fieldErrors.city && (
            <p id="city-error" className="field-error">
              {fieldErrors.city}
            </p>
          )}
        </div>

        <div className="form-row-2">
          <div className="form-field">
            <label htmlFor="school-start-time">School Start Time</label>
            <input
              id="school-start-time"
              type="time"
              value={value.schoolStartTime}
              onChange={(e) =>
                onChange({ ...value, schoolStartTime: e.target.value })
              }
              aria-invalid={Boolean(fieldErrors.schoolStartTime)}
              aria-describedby={
                fieldErrors.schoolStartTime ? 'school-start-error' : undefined
              }
            />
            {fieldErrors.schoolStartTime && (
              <p id="school-start-error" className="field-error">
                {fieldErrors.schoolStartTime}
              </p>
            )}
          </div>

          <div className="form-field">
            <label htmlFor="earliest-ready-time">Earliest Home Departure</label>
            <input
              id="earliest-ready-time"
              type="time"
              value={value.earliestReadyTime}
              onChange={(e) =>
                onChange({ ...value, earliestReadyTime: e.target.value })
              }
              aria-invalid={Boolean(fieldErrors.earliestReadyTime)}
              aria-describedby={
                fieldErrors.earliestReadyTime
                  ? 'earliest-ready-error'
                  : 'earliest-ready-hint'
              }
            />
            <span id="earliest-ready-hint" className="field-hint">
              When your child is ready to step out.
            </span>
            {fieldErrors.earliestReadyTime && (
              <p id="earliest-ready-error" className="field-error">
                {fieldErrors.earliestReadyTime}
              </p>
            )}
          </div>
        </div>

        <div className="form-field">
          <label htmlFor="commute-duration">
            Baseline One-Way Commute Duration (minutes)
          </label>
          <input
            id="commute-duration"
            type="number"
            min={5}
            max={180}
            value={Number.isNaN(value.commuteDurationMinutes) ? '' : value.commuteDurationMinutes}
            onChange={(e) =>
              onChange({
                ...value,
                commuteDurationMinutes: e.target.value === '' ? NaN : Number(e.target.value)
              })
            }
            aria-invalid={Boolean(fieldErrors.commuteDurationMinutes)}
            aria-describedby={
              fieldErrors.commuteDurationMinutes
                ? 'commute-duration-error'
                : 'commute-duration-hint'
            }
          />
          <span id="commute-duration-hint" className="field-hint">
            Used to compute door-to-door time and estimated distance per mode.
          </span>
          {fieldErrors.commuteDurationMinutes && (
            <p id="commute-duration-error" className="field-error">
              {fieldErrors.commuteDurationMinutes}
            </p>
          )}
        </div>

        <div className="form-row-2">
          <div className="form-field">
            <label htmlFor="daily-budget">
              Daily Morning Budget ({value.budgetCurrency === 'INR' ? '₹ INR/day' : '$ USD/day'})
            </label>
            <input
              id="daily-budget"
              type="number"
              min={0}
              max={100000}
              step={value.budgetCurrency === 'INR' ? 5 : 0.25}
              value={Number.isNaN(value.dailyBudget) ? '' : value.dailyBudget}
              onChange={(e) =>
                onChange({
                  ...value,
                  dailyBudget: e.target.value === '' ? NaN : Number(e.target.value)
                })
              }
              aria-invalid={Boolean(fieldErrors.dailyBudget)}
              aria-describedby={
                fieldErrors.dailyBudget ? 'daily-budget-error' : undefined
              }
            />
            {fieldErrors.dailyBudget && (
              <p id="daily-budget-error" className="field-error">
                {fieldErrors.dailyBudget}
              </p>
            )}
          </div>

          <div className="form-field">
            <label htmlFor="budget-currency">Budget Currency</label>
            <select
              id="budget-currency"
              value={value.budgetCurrency}
              onChange={(e) =>
                onChange({
                  ...value,
                  budgetCurrency: e.target.value as 'INR' | 'USD'
                })
              }
            >
              <option value="INR">INR (₹ / day)</option>
              <option value="USD">USD ($ / day)</option>
            </select>
          </div>
        </div>

        <fieldset>
          <legend>Travel Options Actually Available Today</legend>
          {TRAVEL_MODE_ORDER.map((modeId) => {
            const spec = TRAVEL_MODE_SPECS[modeId];
            const costLabel = formatCurrencyFromInr(
              spec.costInr,
              value.budgetCurrency
            );
            return (
              <label key={modeId} className="checkbox-item">
                <input
                  type="checkbox"
                  checked={value.travelOptions[modeId]}
                  onChange={(e) => updateTravelOption(modeId, e.target.checked)}
                />
                <span>
                  {spec.label} ({costLabel})
                </span>
              </label>
            );
          })}
        </fieldset>

        <fieldset>
          <legend>Home Indoor Air &amp; Health Context</legend>
          <div className="form-field">
            <label htmlFor="home-purifier">Air Filtration Equipment</label>
            <select
              id="home-purifier"
              value={value.homePurifier}
              onChange={(e) =>
                onChange({
                  ...value,
                  homePurifier: e.target.value as HomePurifierType
                })
              }
            >
              {Object.entries(HOME_PURIFIER_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div className="form-field">
            <label htmlFor="home-ventilation">Home Window / Entry Setup</label>
            <select
              id="home-ventilation"
              value={value.homeVentilation}
              onChange={(e) =>
                onChange({
                  ...value,
                  homeVentilation: e.target.value as HomeVentilationType
                })
              }
            >
              {Object.entries(HOME_VENTILATION_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <label className="checkbox-item" style={{ marginBottom: 0 }}>
            <input
              type="checkbox"
              checked={value.childHasAsthmaOrSensitivity}
              onChange={(e) =>
                onChange({
                  ...value,
                  childHasAsthmaOrSensitivity: e.target.checked
                })
              }
            />
            <span>
              Child has asthma or respiratory sensitivity (stricter 35.4 µg/m³ /
              US AQI 100 active-commute limit)
            </span>
          </label>
        </fieldset>

        <div className="button-row">
          <button
            type="submit"
            className="btn btn--primary"
            disabled={isSubmitting}
          >
            {isSubmitting
              ? 'Calculating Plan...'
              : hasGeneratedPlan
                ? 'Update Morning Plan'
                : 'Generate Morning Plan'}
          </button>
          <button
            type="button"
            className="btn"
            onClick={onResetDefaults}
            disabled={isSubmitting}
          >
            Reset Delhi-NCR Defaults
          </button>
        </div>
      </form>
    </section>
  );
}
