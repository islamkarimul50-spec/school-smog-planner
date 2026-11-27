import { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_HOUSEHOLD_INPUT,
  SAMPLE_AIR_QUALITY_PRESETS
} from '../shared/constants.js';
import type { PreviousPlanSummaryInput } from '../shared/decisionEngine.js';
import type {
  AirQualityReading,
  CommunityNotice,
  HouseholdInput,
  PlanResponsePayload
} from '../shared/types.js';
import {
  fetchBootstrap,
  fetchLiveAirQuality,
  generateMorningPlan,
  submitManualAirQuality,
  type SamplePresetItem
} from './api/client.js';
import { AirQualityBanner } from './components/AirQualityBanner.js';
import { CommunityActionPanel } from './components/CommunityActionPanel.js';
import { GeminiCoachPanel } from './components/GeminiCoachPanel.js';
import { HeaderBar } from './components/HeaderBar.js';
import { HouseholdForm } from './components/HouseholdForm.js';
import { PlanCards } from './components/PlanCards.js';
import { PlanComparisonDiff } from './components/PlanComparisonDiff.js';

const DEFAULT_SAMPLE_LIST: SamplePresetItem[] = Object.entries(
  SAMPLE_AIR_QUALITY_PRESETS
).map(([key, reading]) => ({ key, reading }));

export function App() {
  const [householdInput, setHouseholdInput] = useState<HouseholdInput>(
    DEFAULT_HOUSEHOLD_INPUT
  );
  const [airQuality, setAirQuality] = useState<AirQualityReading | null>(null);
  const [airQualityError, setAirQualityError] = useState<string | null>(null);
  const [samplePresets, setSamplePresets] =
    useState<SamplePresetItem[]>(DEFAULT_SAMPLE_LIST);
  const [communityNotices, setCommunityNotices] = useState<CommunityNotice[]>([]);
  const [aqLoading, setAqLoading] = useState(true);

  const [planResult, setPlanResult] = useState<PlanResponsePayload | null>(null);
  const [planInputSnapshot, setPlanInputSnapshot] =
    useState<HouseholdInput | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planLoading, setPlanLoading] = useState(false);

  const bootstrapCityRef = useRef(DEFAULT_HOUSEHOLD_INPUT.city);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    async function loadInitial() {
      setAqLoading(true);
      try {
        const data = await fetchBootstrap(
          bootstrapCityRef.current,
          controller.signal
        );
        if (!active) return;
        setAirQuality(data.airQuality);
        setAirQualityError(data.airQualityError);
        if (data.samplePresets.length > 0) {
          setSamplePresets(data.samplePresets);
        }
        setCommunityNotices(data.communityNotices);
      } catch (err) {
        if (!active || (err instanceof Error && err.name === 'AbortError')) {
          return;
        }
        setAirQualityError(
          err instanceof Error
            ? err.message
            : 'Unable to load initial air-quality data.'
        );
      } finally {
        if (active) {
          setAqLoading(false);
        }
      }
    }

    void loadInitial();
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  async function handleRefreshLiveAq() {
    const cityToFetch = householdInput.city.trim();
    if (cityToFetch.length < 2) {
      setAirQualityError('Enter a city name of at least 2 characters first.');
      return;
    }
    setAqLoading(true);
    setAirQualityError(null);
    try {
      const liveReading = await fetchLiveAirQuality(cityToFetch);
      setAirQuality(liveReading);
    } catch (err) {
      setAirQualityError(
        err instanceof Error
          ? err.message
          : 'Live air-quality data unavailable. Choose a sample preset or manual entry.'
      );
    } finally {
      setAqLoading(false);
    }
  }

  function handleSelectSample(preset: AirQualityReading) {
    setAirQuality({
      ...preset,
      cityQuery: householdInput.city.trim() || preset.cityQuery
    });
    setAirQualityError(null);
  }

  async function handleApplyManualAq(pm25UgM3: number) {
    const cityName = householdInput.city.trim() || 'Delhi-NCR';
    setAqLoading(true);
    setAirQualityError(null);
    try {
      const manual = await submitManualAirQuality(cityName, pm25UgM3);
      setAirQuality(manual);
    } catch (err) {
      setAirQualityError(
        err instanceof Error ? err.message : 'Unable to apply manual reading.'
      );
    } finally {
      setAqLoading(false);
    }
  }

  async function handleGeneratePlan(validatedInput: HouseholdInput) {
    setPlanLoading(true);
    setPlanError(null);

    let previousPlanSummary: PreviousPlanSummaryInput | undefined;
    if (planResult && planInputSnapshot) {
      previousPlanSummary = {
        selectedModeId: planResult.plan.selectedModeId,
        selectedModeLabel: planResult.plan.selectedModeLabel,
        recommendedDepartureTime: planResult.plan.recommendedDepartureTime,
        allocatedTravelCostInr: planResult.plan.allocatedTravelCostInr,
        indoorActionTitle:
          planResult.plan.recommendations.indoorAirQuality.title,
        sustainableActionTitle:
          planResult.plan.recommendations.sustainableAlternative.title,
        householdInput: planInputSnapshot
      };
    }

    try {
      const sameCityActiveAq =
        airQuality &&
        (airQuality.dataOrigin !== 'live' ||
          airQuality.cityQuery.trim().toLowerCase() ===
            validatedInput.city.trim().toLowerCase())
          ? airQuality
          : undefined;

      const response = await generateMorningPlan({
        householdInput: validatedInput,
        airQuality: sameCityActiveAq,
        previousPlanSummary
      });

      setAirQuality(response.plan.airQualitySnapshot);
      setAirQualityError(null);
      setPlanResult(response);
      setPlanInputSnapshot(validatedInput);
    } catch (err) {
      setPlanError(
        err instanceof Error
          ? err.message
          : 'Could not generate morning plan. Try selecting sample or manual air-quality data.'
      );
    } finally {
      setPlanLoading(false);
    }
  }

  function handleResetDefaults() {
    setHouseholdInput(DEFAULT_HOUSEHOLD_INPUT);
    setPlanResult(null);
    setPlanInputSnapshot(null);
    setPlanError(null);
  }

  const hasUnappliedFormEdits =
    planInputSnapshot !== null &&
    JSON.stringify(planInputSnapshot) !== JSON.stringify(householdInput);

  return (
    <div className="page-shell">
      <a href="#main-content" className="skip-link">
        Skip to main planner
      </a>

      <HeaderBar />

      <main id="main-content">
        <AirQualityBanner
          city={householdInput.city}
          airQuality={airQuality}
          airQualityError={airQualityError}
          samplePresets={samplePresets}
          loading={aqLoading}
          onRefreshLive={handleRefreshLiveAq}
          onSelectSample={handleSelectSample}
          onApplyManual={handleApplyManualAq}
        />

        <div className="layout-grid">
          <HouseholdForm
            value={householdInput}
            onChange={setHouseholdInput}
            onSubmit={handleGeneratePlan}
            onResetDefaults={handleResetDefaults}
            hasGeneratedPlan={Boolean(planResult)}
            isSubmitting={planLoading}
          />

          <div>
            {planError && (
              <div className="alert alert--danger" role="alert">
                <strong>Plan generation failed:</strong> {planError}
              </div>
            )}

            {!planResult ? (
              <section className="card" aria-labelledby="empty-plan-heading">
                <h2 id="empty-plan-heading">Ready to Build Your Morning Plan</h2>
                <p style={{ marginBottom: '0.5rem' }}>
                  Confirm your city, school start time, available travel modes,
                  and daily budget on the left, then select{' '}
                  <strong>Generate Morning Plan</strong>.
                </p>
                <p className="aq-meta" style={{ marginBottom: 0 }}>
                  All availability, budget, timing, and smog-safety limits are
                  enforced deterministically in code before Gemini explains your
                  plan.
                </p>
              </section>
            ) : (
              <>
                {hasUnappliedFormEdits && (
                  <div className="alert alert--warn" role="status">
                    Household inputs changed — select{' '}
                    <strong>Update Morning Plan</strong> to apply your new
                    constraints before asking follow-up questions.
                  </div>
                )}
                <PlanComparisonDiff diff={planResult.diff} />
                <PlanCards
                  plan={planResult.plan}
                  aiExplanation={planResult.aiExplanation}
                  currency={(planInputSnapshot ?? householdInput).budgetCurrency}
                />
                <GeminiCoachPanel
                  householdInput={planInputSnapshot ?? householdInput}
                  airQuality={planResult.plan.airQualitySnapshot}
                  plan={planResult.plan}
                  planDiff={planResult.diff}
                />
              </>
            )}

            <CommunityActionPanel
              city={householdInput.city}
              schoolStartTime={householdInput.schoolStartTime}
              plan={planResult?.plan ?? null}
              notices={communityNotices}
              onNoticesUpdated={setCommunityNotices}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
