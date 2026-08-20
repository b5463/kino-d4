import { useState, type FormEvent } from 'react';
import { ApiError, rollApi, type RollApi } from '../api/client';

export interface PinGateProps {
  slug: string;
  onUnlocked(): void | Promise<void>;
  api?: RollApi;
}

/** Compact guest gate; PINs stay in component memory only. */
export function PinGate({ slug, onUnlocked, api = rollApi }: PinGateProps) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await api.submitPin(slug, pin);
      setPin('');
      await onUnlocked();
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === 'INVALID_PIN'
          ? 'That PIN did not work.'
          : 'Could not open this Roll. Try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main style={{ maxWidth: 360, margin: '15vh auto', padding: '1rem' }}>
      <div style={{ fontSize: '0.75rem', letterSpacing: '0.14em' }}>KINO ROLL</div>
      <h1>This Roll needs a PIN</h1>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="roll-pin">PIN</label>
        <input
          id="roll-pin"
          name="pin"
          type="password"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={pin}
          onChange={(event) => setPin(event.target.value)}
          required
          autoFocus
        />
        <button type="submit" disabled={submitting}>
          {submitting ? 'Opening…' : 'Open Roll'}
        </button>
      </form>
      {error === '' ? null : <p role="alert">{error}</p>}
    </main>
  );
}
