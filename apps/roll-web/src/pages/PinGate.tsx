import { useState, type FormEvent } from 'react';
import { ApiError, rollApi, type RollApi } from '../api/client';
import kinoRoll from '../assets/kino-roll-light.png';

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

  // The gate is a guest surface, so it wears the guest chrome rather than a
  // light design-system panel dropped on a near-black page.
  return (
    <main className="k-gate">
      <img className="k-mark" src={kinoRoll} alt="KINO Roll" />
      <p className="k-gate-note">PRIVATE ROLL</p>
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
        <button type="submit" className="k-save" disabled={submitting}>
          {submitting ? 'OPENING…' : 'OPEN ROLL'}
        </button>
      </form>
      {error === '' ? null : <p className="roll-alert" role="alert">{error}</p>}
    </main>
  );
}
