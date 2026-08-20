import { useState, type FormEvent } from 'react';
import { ApiError, rollApi, type RollApi } from '../api/client';
import { Button, Panel } from '@kino/design-system';

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
    <main className="roll-shell roll-shell--narrow">
      <div className="roll-brand">KINO ROLL</div>
      <Panel title="Private Roll">
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
          <Button variant="primary" type="submit" busy={submitting}>
            {submitting ? 'Opening…' : 'Open Roll'}
          </Button>
        </form>
        {error === '' ? null : <p className="roll-alert" role="alert">{error}</p>}
      </Panel>
    </main>
  );
}
