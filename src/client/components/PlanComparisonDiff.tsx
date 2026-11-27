import type { PlanDiff } from '../../shared/types.js';

interface PlanComparisonDiffProps {
  diff: PlanDiff | null;
}

export function PlanComparisonDiff({ diff }: PlanComparisonDiffProps) {
  if (!diff || !diff.hasPreviousPlan) {
    return null;
  }

  return (
    <section
      className="diff-card"
      aria-labelledby="plan-diff-heading"
      aria-live="polite"
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '0.5rem',
          marginBottom: '0.6rem'
        }}
      >
        <h2 id="plan-diff-heading" style={{ margin: 0 }}>
          Plan Comparison: What Changed &amp; What Stayed Relevant
        </h2>
        <span className="badge">UPDATED PLAN DIFF</span>
      </div>

      {diff.changedInputs.length > 0 && (
        <p style={{ marginTop: 0 }}>
          <strong>Input changed:</strong> {diff.changedInputs.join(' · ')}
        </p>
      )}

      <div className="diff-grid">
        <div className="impact-box">
          <h4>[CHANGED] What Changed</h4>
          {diff.whatChanged.length > 0 ? (
            <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
              {diff.whatChanged.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <p>Selected travel mode and actions remained unchanged.</p>
          )}
        </div>

        <div className="impact-box">
          <h4>[STAYED RELEVANT] What Stayed Relevant</h4>
          <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
            {diff.whatStayedRelevant.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </div>

      <p style={{ margin: '0.75rem 0 0' }}>
        <strong>Why:</strong> {diff.whyItChanged}
      </p>
    </section>
  );
}
