import { useState, type FormEvent } from 'react';
import type { AirQualityReading } from '../../shared/types.js';
import type { SamplePresetItem } from '../api/client.js';

interface AirQualityBannerProps {
  city: string;
  airQuality: AirQualityReading | null;
  airQualityError: string | null;
  samplePresets: SamplePresetItem[];
  loading: boolean;
  onRefreshLive: () => void;
  onSelectSample: (preset: AirQualityReading) => void;
  onApplyManual: (pm25UgM3: number) => Promise<void>;
}

function formatReadableTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return iso;
  }
  return `${parsed.toLocaleString()} (${iso})`;
}

function getSeverityBadgeClass(category: AirQualityReading['category']): string {
  if (category === 'Good') return 'badge badge--good';
  if (category === 'Moderate' || category === 'Unhealthy for Sensitive Groups') {
    return 'badge badge--warn';
  }
  return 'badge badge--danger';
}

export function AirQualityBanner({
  city,
  airQuality,
  airQualityError,
  samplePresets,
  loading,
  onRefreshLive,
  onSelectSample,
  onApplyManual
}: AirQualityBannerProps) {
  const [showManualForm, setShowManualForm] = useState(false);
  const [manualPm25Input, setManualPm25Input] = useState('245');
  const [manualError, setManualError] = useState<string | null>(null);

  async function handleManualSubmit(event: FormEvent) {
    event.preventDefault();
    const num = Number(manualPm25Input);
    if (!Number.isFinite(num) || num < 0 || num > 1000) {
      setManualError('Enter a valid PM2.5 reading between 0 and 1000 µg/m³.');
      return;
    }
    setManualError(null);
    await onApplyManual(num);
    setShowManualForm(false);
  }

  return (
    <section
      className="card"
      aria-labelledby="air-quality-heading"
    >
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
        <h2 id="air-quality-heading" style={{ margin: 0 }}>
          Local Air Quality Snapshot
        </h2>
        {airQuality && (
          <span className={getSeverityBadgeClass(airQuality.category)}>
            {airQuality.category.toUpperCase()}
            {airQuality.usAqi > 500 ? ' (BEYOND THE AQI)' : ''} · US AQI{' '}
            {airQuality.usAqi}
          </span>
        )}
      </div>

      {airQualityError && (
        <div className="alert alert--warn" role="alert">
          <strong>Live air quality unavailable:</strong> {airQualityError}
        </div>
      )}

      {airQuality ? (
        <div>
          <div className="aq-metrics">
            <div>
              <span className="aq-metric-value">
                {airQuality.pm25UgM3.toFixed(1)} µg/m³
              </span>{' '}
              <span>PM2.5</span>
            </div>
            <div>
              <strong>{airQuality.usAqi}</strong>{' '}
              <span>{airQuality.units.usAqi}</span>
            </div>
            {airQuality.pm10UgM3 !== null && (
              <div>
                <strong>{airQuality.pm10UgM3.toFixed(1)} µg/m³</strong>{' '}
                <span>PM10</span>
              </div>
            )}
          </div>
          <p className="aq-meta">
            <strong>Location:</strong> {airQuality.resolvedLocation} ·{' '}
            <strong>Source:</strong> {airQuality.source} ·{' '}
            <strong>Timestamp:</strong>{' '}
            {formatReadableTimestamp(airQuality.timestampIso)}
          </p>

          {airQuality.isStale && (
            <div className="alert alert--warn" role="status">
              <strong>[STALE DATA]</strong> {airQuality.staleReason}
            </div>
          )}
        </div>
      ) : (
        <p className="aq-meta">
          No active reading loaded for {city}. Choose a clearly labeled sample
          dataset or enter a local monitor reading below.
        </p>
      )}

      <div className="button-row">
        <button
          type="button"
          className="btn btn--small"
          onClick={onRefreshLive}
          disabled={loading}
        >
          {loading ? 'Checking live AQ...' : `Refresh Live AQ (${city})`}
        </button>

        {samplePresets.map((preset) => (
          <button
            key={preset.key}
            type="button"
            className="btn btn--small"
            onClick={() => onSelectSample(preset.reading)}
          >
            Load {preset.reading.resolvedLocation.replace('Sample: ', '')} (
            {preset.reading.pm25UgM3} µg/m³)
          </button>
        ))}

        <button
          type="button"
          className="btn btn--small"
          aria-expanded={showManualForm}
          onClick={() => setShowManualForm((prev) => !prev)}
        >
          {showManualForm ? 'Close Manual Entry' : 'Enter PM2.5 Manually'}
        </button>
      </div>

      {showManualForm && (
        <form
          onSubmit={handleManualSubmit}
          style={{
            marginTop: '0.85rem',
            paddingTop: '0.75rem',
            borderTop: '1px solid var(--border-color)'
          }}
        >
          <div className="form-row-2" style={{ alignItems: 'end' }}>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label htmlFor="manual-pm25-input">
                Manual Local PM2.5 Reading (µg/m³)
              </label>
              <input
                id="manual-pm25-input"
                type="number"
                step="0.1"
                min="0"
                max="1000"
                value={manualPm25Input}
                onChange={(e) => setManualPm25Input(e.target.value)}
                aria-invalid={Boolean(manualError)}
                aria-describedby={manualError ? 'manual-pm25-error' : undefined}
              />
            </div>
            <div>
              <button type="submit" className="btn btn--primary">
                Apply Manual Reading
              </button>
            </div>
          </div>
          {manualError && (
            <p id="manual-pm25-error" className="field-error" role="alert">
              {manualError}
            </p>
          )}
        </form>
      )}
    </section>
  );
}
