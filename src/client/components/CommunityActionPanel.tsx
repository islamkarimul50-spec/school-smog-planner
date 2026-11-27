import { useState, type FormEvent } from 'react';
import type {
  CommunityCategory,
  CommunityNotice,
  MorningPlan
} from '../../shared/types.js';
import {
  CommunityNoticeInputSchema,
  detectCommunityPii
} from '../../shared/validation.js';
import { postCommunityNotice } from '../api/client.js';

interface CommunityActionPanelProps {
  city: string;
  schoolStartTime: string;
  plan: MorningPlan | null;
  notices: CommunityNotice[];
  onNoticesUpdated: (notices: CommunityNotice[]) => void;
}

function buildDefaultTemplate(
  category: CommunityCategory,
  city: string,
  schoolStartTime: string,
  plan: MorningPlan | null
): string {
  const aqiText = plan
    ? `US AQI ${plan.airQualitySnapshot.usAqi} (${plan.airQualitySnapshot.category})`
    : 'elevated winter smog';

  if (category === 'no-idling') {
    return `With ${aqiText} in ${city}, please switch engines off while waiting near the school pickup zone around ${schoolStartTime} so students breathe less curbside exhaust.`;
  }
  if (category === 'carpool-corridor') {
    return `Coordinating an idle-free shared ride along the main transit corridor for the ${schoolStartTime} bell (${city}); closed AC recirculate + N95 masks.`;
  }
  return `Severe smog advisory (${aqiText} in ${city}): requesting indoor morning assembly and optional staggered entry around ${schoolStartTime}.`;
}

export function CommunityActionPanel({
  city,
  schoolStartTime,
  plan,
  notices,
  onNoticesUpdated
}: CommunityActionPanelProps) {
  const [category, setCategory] = useState<CommunityCategory>('no-idling');
  const [corridorZone, setCorridorZone] = useState('Main Gate Pickup Zone');
  const [schoolWindow, setSchoolWindow] = useState(`${schoolStartTime} bell`);
  const [message, setMessage] = useState(() =>
    buildDefaultTemplate('no-idling', city, schoolStartTime, plan)
  );
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const livePiiHits = detectCommunityPii(`${corridorZone} ${message}`);

  function handleCategoryChange(nextCategory: CommunityCategory) {
    setCategory(nextCategory);
    setMessage(buildDefaultTemplate(nextCategory, city, schoolStartTime, plan));
    setStatusMessage(null);
    setError(null);
  }

  async function handlePostNotice(event: FormEvent) {
    event.preventDefault();
    setStatusMessage(null);

    const parsed = CommunityNoticeInputSchema.safeParse({
      category,
      corridorZone,
      schoolWindow,
      message
    });
    if (!parsed.success) {
      setError(
        parsed.error.issues[0]?.message ??
          'Please resolve privacy or field validation errors.'
      );
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      const result = await postCommunityNotice(parsed.data);
      onNoticesUpdated(result.notices);
      setStatusMessage(
        'Posted privacy-checked notice to the School Corridor Board.'
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Unable to post community notice.'
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCopySafeMessage() {
    setStatusMessage(null);
    const parsed = CommunityNoticeInputSchema.safeParse({
      category,
      corridorZone,
      schoolWindow,
      message
    });
    if (!parsed.success) {
      setError(
        parsed.error.issues[0]?.message ??
          'Fix privacy or validation errors before copying.'
      );
      return;
    }
    setError(null);
    const formatted = `[${corridorZone.trim()} · ${schoolWindow.trim()}] ${message.trim()}`;
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(formatted);
      setStatusMessage('Copied anonymous parent-group message to clipboard.');
    } else {
      setStatusMessage(`Ready to share: ${formatted}`);
    }
  }

  return (
    <section className="card" aria-labelledby="community-heading">
      <h2 id="community-heading">
        Privacy-Safe School Community Action Board
      </h2>
      <p className="aq-meta">
        Share a pickup, carpool, or no-idling message without exposing any
        child&apos;s name, home address, phone number, or household budget.
      </p>

      {livePiiHits.length > 0 && (
        <div id="community-pii-alert" className="alert alert--danger" role="alert">
          <strong>Privacy Guard Warning:</strong> Remove {livePiiHits.join(', ')}{' '}
          before posting or copying.
        </div>
      )}

      {error && (
        <div className="alert alert--danger" role="alert">
          {error}
        </div>
      )}

      {statusMessage && (
        <div className="alert alert--success" role="status" aria-live="polite">
          {statusMessage}
        </div>
      )}

      <form onSubmit={handlePostNotice}>
        <div className="form-row-2">
          <div className="form-field">
            <label htmlFor="community-category">Notice Purpose</label>
            <select
              id="community-category"
              value={category}
              onChange={(e) =>
                handleCategoryChange(e.target.value as CommunityCategory)
              }
            >
              <option value="no-idling">No-Idling Pickup Gate Pledge</option>
              <option value="carpool-corridor">
                Anonymous Corridor Carpool Need
              </option>
              <option value="smog-alert">
                School Smog-Day Schedule Request
              </option>
            </select>
          </div>

          <div className="form-field">
            <label htmlFor="community-window">School Arrival / Pickup Window</label>
            <input
              id="community-window"
              type="text"
              maxLength={40}
              value={schoolWindow}
              onChange={(e) => setSchoolWindow(e.target.value)}
            />
          </div>
        </div>

        <div className="form-field">
          <label htmlFor="community-zone">
            General Corridor or Gate Landmark (no street/house address)
          </label>
          <input
            id="community-zone"
            type="text"
            maxLength={60}
            value={corridorZone}
            onChange={(e) => setCorridorZone(e.target.value)}
          />
        </div>

        <div className="form-field">
          <label htmlFor="community-message">
            Short Anonymous Message (max 240 chars)
          </label>
          <textarea
            id="community-message"
            rows={3}
            maxLength={240}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            aria-invalid={livePiiHits.length > 0}
            aria-describedby={
              livePiiHits.length > 0 ? 'community-pii-alert' : undefined
            }
          />
        </div>

        <div className="button-row">
          <button
            type="submit"
            className="btn btn--primary"
            disabled={submitting || livePiiHits.length > 0}
          >
            {submitting ? 'Posting...' : 'Post to Corridor Board'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={livePiiHits.length > 0}
            onClick={() => void handleCopySafeMessage()}
          >
            Copy Safe Message
          </button>
        </div>
      </form>

      <h3 style={{ marginTop: '1.15rem' }}>Recent School Corridor Notices</h3>
      <ul className="notice-list">
        {notices.map((item) => (
          <li key={item.id} className="notice-item">
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: '0.5rem',
                flexWrap: 'wrap',
                marginBottom: '0.3rem'
              }}
            >
              <strong>
                {item.corridorZone} · {item.schoolWindow}
              </strong>
              <span className="badge">
                {item.isSample ? 'Sample Notice' : 'Posted Safely'} ·{' '}
                {item.category}
              </span>
            </div>
            <p style={{ margin: 0 }}>{item.message}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
