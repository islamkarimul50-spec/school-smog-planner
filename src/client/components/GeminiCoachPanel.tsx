import { useState, type FormEvent } from 'react';
import type {
  AirQualityReading,
  ChatMessage,
  HouseholdInput,
  MorningPlan,
  PlanDiff
} from '../../shared/types.js';
import { askCoachFollowUp } from '../api/client.js';

interface GeminiCoachPanelProps {
  householdInput: HouseholdInput;
  airQuality: AirQualityReading;
  plan: MorningPlan;
  planDiff: PlanDiff | null;
}

interface ChatTurnDisplay extends ChatMessage {
  source?: string;
}

export function GeminiCoachPanel({
  householdInput,
  airQuality,
  plan,
  planDiff
}: GeminiCoachPanelProps) {
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<ChatTurnDisplay[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const quickQuestions = [
    'Why did my travel plan change?',
    'Does the school bus reduce what my child breathes?',
    'Which constraint should I adjust if options are tight?'
  ];

  async function submitQuestion(textToAsk: string) {
    const trimmed = textToAsk.trim();
    if (trimmed.length < 2) {
      setError('Enter a question of at least 2 characters.');
      return;
    }

    setError(null);
    setLoading(true);

    const historyForApi: ChatMessage[] = turns.map((t) => ({
      role: t.role,
      content: t.content
    }));

    try {
      const response = await askCoachFollowUp({
        question: trimmed,
        householdInput,
        airQuality,
        plan,
        planDiff,
        history: historyForApi
      });

      setTurns((prev) => [
        ...prev,
        { role: 'user', content: trimmed },
        {
          role: 'assistant',
          content: response.answer,
          source: response.model
            ? `${response.source} (${response.model})`
            : response.source
        }
      ]);
      setQuestion('');
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Unable to reach coach endpoint.'
      );
    } finally {
      setLoading(false);
    }
  }

  function handleFormSubmit(event: FormEvent) {
    event.preventDefault();
    void submitQuestion(question);
  }

  return (
    <section className="card" aria-labelledby="coach-qa-heading">
      <h2 id="coach-qa-heading">Ask the Clean-Air Coach (Follow-Up Q&amp;A)</h2>
      <p className="aq-meta">
        Answers use your latest household inputs ({householdInput.city},{' '}
        {householdInput.schoolStartTime} start, School Bus ={' '}
        {householdInput.travelOptions.schoolBus ? 'Yes' : 'No'}, PM2.5{' '}
        {airQuality.pm25UgM3.toFixed(1)} µg/m³) and latest plan diff.
      </p>

      <div
        className="button-row"
        role="group"
        aria-label="Suggested coach questions"
        style={{ marginBottom: '0.75rem' }}
      >
        {quickQuestions.map((presetQ) => (
          <button
            key={presetQ}
            type="button"
            className="btn btn--small"
            disabled={loading}
            onClick={() => void submitQuestion(presetQ)}
          >
            {presetQ}
          </button>
        ))}
      </div>

      {turns.length > 0 && (
        <div className="chat-log" aria-live="polite">
          {turns.map((turn, index) => (
            <div key={`${turn.role}-${index}`} className="chat-turn">
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: '0.5rem',
                  flexWrap: 'wrap',
                  marginBottom: '0.2rem'
                }}
              >
                <strong>{turn.role === 'user' ? 'Parent' : 'Coach'}</strong>
                {turn.source && (
                  <span className="badge">Source: {turn.source}</span>
                )}
              </div>
              <p style={{ margin: 0 }}>{turn.content}</p>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div id="coach-question-error" className="alert alert--danger" role="alert">
          {error}
        </div>
      )}

      <form onSubmit={handleFormSubmit}>
        <div className="form-field">
          <label htmlFor="coach-question-input">
            Ask a follow-up question about today&apos;s plan
          </label>
          <input
            id="coach-question-input"
            type="text"
            maxLength={500}
            value={question}
            placeholder="e.g., Why did my travel plan change?"
            onChange={(e) => setQuestion(e.target.value)}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'coach-question-error' : undefined}
          />
        </div>
        <button
          type="submit"
          className="btn btn--secondary"
          disabled={loading}
        >
          {loading ? 'Thinking...' : 'Ask Coach'}
        </button>
      </form>
    </section>
  );
}
