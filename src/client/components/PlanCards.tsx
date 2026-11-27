import { formatCurrencyFromInr } from '../../shared/constants.js';
import type {
  AiExplanationResult,
  BudgetCurrency,
  MorningPlan,
  RecommendationBlock
} from '../../shared/types.js';

interface PlanCardsProps {
  plan: MorningPlan;
  aiExplanation: AiExplanationResult;
  currency: BudgetCurrency;
}

function RecommendationCard({
  block,
  isConflict
}: {
  block: RecommendationBlock;
  isConflict?: boolean;
}) {
  return (
    <article
      className={isConflict ? 'rec-card rec-card--conflict' : 'rec-card'}
      aria-labelledby={`rec-title-${block.id}`}
    >
      <h3 id={`rec-title-${block.id}`}>{block.title}</h3>

      <p className="rec-section-label">What should I do?</p>
      <p style={{ marginTop: 0 }}>{block.whatToDo}</p>

      <ul>
        {block.actionChecklist.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ul>

      <p className="rec-section-label">Why does it fit my situation?</p>
      <p style={{ marginTop: 0 }}>{block.whyItFits}</p>

      <p className="rec-section-label">What difference could it make?</p>
      <div className="impact-split">
        <div className="impact-box">
          <h4>Community &amp; Tailpipe Emissions</h4>
          <p>{block.emissionsDifference}</p>
        </div>
        <div className="impact-box">
          <h4>Child&apos;s Personal Exposure</h4>
          <p>{block.personalExposureDifference}</p>
        </div>
      </div>

      <details className="assumptions-box">
        <summary>Visible inputs &amp; assumptions for this estimate</summary>
        <ul className="assumptions-list">
          {block.assumptions.map((entry) => (
            <li key={entry.label}>
              <strong>{entry.label}:</strong> {entry.value}
            </li>
          ))}
        </ul>
      </details>
    </article>
  );
}

export function PlanCards({ plan, aiExplanation, currency }: PlanCardsProps) {
  const isConflict = plan.routineStatus === 'NO_FEASIBLE_OPTION';

  return (
    <div>
      <section
        className={isConflict ? 'alert alert--danger' : 'alert alert--success'}
        role={isConflict ? 'alert' : 'status'}
        aria-live="polite"
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '0.5rem',
            marginBottom: '0.45rem'
          }}
        >
          <strong>
            {isConflict
              ? '[CONFLICT] No Feasible Travel Option Fits All Constraints'
              : `[PLAN READY] Recommended Commute: ${plan.selectedModeLabel} · Depart ${plan.recommendedDepartureTime}`}
          </strong>
          <span className="badge">
            Remaining IAQ Budget:{' '}
            {formatCurrencyFromInr(plan.remainingBudgetInr, currency)}
          </span>
        </div>

        {isConflict && plan.constraintChangePrompts.length > 0 && (
          <div style={{ marginTop: '0.5rem' }}>
            <p style={{ margin: '0 0 0.4rem', fontWeight: 600 }}>
              Which constraint can change today?
            </p>
            <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
              {plan.constraintChangePrompts.map((prompt) => (
                <li key={prompt.constraint}>
                  <strong>{prompt.constraint}:</strong> {prompt.suggestion}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="ai-brief-heading">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '0.5rem',
            marginBottom: '0.5rem'
          }}
        >
          <h2 id="ai-brief-heading" style={{ margin: 0 }}>
            Morning Coach Summary
          </h2>
          <span
            className={
              aiExplanation.usedFallback ? 'badge badge--warn' : 'badge badge--good'
            }
          >
            Source: {aiExplanation.source}
            {aiExplanation.model ? ` (${aiExplanation.model})` : ''}
          </span>
        </div>
        <p style={{ margin: 0 }}>{aiExplanation.text}</p>
        {aiExplanation.note && (
          <p className="field-hint" style={{ marginTop: '0.45rem' }}>
            Note: {aiExplanation.note}
          </p>
        )}
      </section>

      <div className="plan-cards-grid">
        <RecommendationCard
          block={plan.recommendations.routine}
          isConflict={isConflict}
        />
        <RecommendationCard block={plan.recommendations.indoorAirQuality} />
        <RecommendationCard block={plan.recommendations.sustainableAlternative} />
      </div>

      <section className="card" aria-labelledby="travel-eval-heading">
        <h2 id="travel-eval-heading">
          Deterministic Constraint Check Across All Travel Modes
        </h2>
        <p className="aq-meta">
          Available morning window: <strong>{plan.availableWindowMinutes} min</strong> · Baseline
          commute: <strong>{plan.baselineCommuteDurationMinutes} min</strong> · Daily
          budget: <strong>{formatCurrencyFromInr(plan.dailyBudgetInr, currency)}</strong> ·
          Active PM2.5:{' '}
          <strong>{plan.airQualitySnapshot.pm25UgM3.toFixed(1)} µg/m³</strong>
        </p>
        <div className="table-scroll">
          <table className="eval-table">
            <thead>
              <tr>
                <th scope="col">Travel Option</th>
                <th scope="col">Available</th>
                <th scope="col">Cost / Day</th>
                <th scope="col">Door-to-Door</th>
                <th scope="col">Status &amp; Departure</th>
                <th scope="col">Exposure Risk</th>
                <th scope="col">Rule Outcome</th>
              </tr>
            </thead>
            <tbody>
              {plan.evaluatedTravelOptions.map((item) => {
                const isSelected = item.modeId === plan.selectedModeId;
                return (
                  <tr key={item.modeId}>
                    <td>
                      <strong>{item.label}</strong>
                    </td>
                    <td>{item.available ? 'Yes' : 'No'}</td>
                    <td>{item.estimatedCostDisplay}</td>
                    <td>{item.requiredMinutes} min</td>
                    <td>
                      {isSelected ? (
                        <span className="badge badge--good">
                          [SELECTED] {item.recommendedDepartureTime}
                        </span>
                      ) : item.feasible ? (
                        <span className="badge">
                          [FEASIBLE] {item.recommendedDepartureTime}
                        </span>
                      ) : (
                        <span className="badge badge--danger">[EXCLUDED]</span>
                      )}
                    </td>
                    <td>{item.exposureRiskLevel}</td>
                    <td>
                      {item.feasible
                        ? `Fits all constraints (saves ~${item.co2eSavedVsSoloCarKg.toFixed(2)} kg CO2e vs. solo car).`
                        : item.rejectionReasons.join(' ')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
