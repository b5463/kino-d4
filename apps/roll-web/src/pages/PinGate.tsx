import { useState, type FormEvent } from 'react';
import { apiFailureMessage, rollApi, type RollApi } from '../api/client';
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
      /**
       * Every failure but a wrong PIN used to read "Could not open this roll.
       * Try again." — which on a lockout is the app inviting the one action
       * that extends it. `apiFailureMessage` carries the lockout's own
       * `retry-after` window, the closed roll and the server being down; the
       * fallback stays for a genuine transport failure, where trying again IS
       * the thing to do.
       */
      setError(apiFailureMessage(caught) ?? 'Could not reach the roll. Check the connection.');
    } finally {
      setSubmitting(false);
    }
  };

  // The gate is a guest surface, so it wears the guest chrome rather than a
  // light design-system panel dropped on a near-black page.
  return (
    <main className="k-gate">
      <img className="k-mark" src={kinoRoll} alt="KINO Roll" />
      {/* The code, because a guest arriving from a scanned card has no other
          way to check they are at the right roll before typing a PIN into it. */}
      <p className="k-gate-note">PRIVATE ROLL · <span className="k-code">{slug}</span></p>
      <h1>This roll needs a PIN</h1>
      <p className="k-gate-lede">It is printed on the card with the roll code.</p>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="roll-pin">PIN</label>
        {/* `autoComplete` is deliberately off, NOT `one-time-code`: iOS reads
            that as "an SMS is coming" and offers a code from Messages that
            has nothing to do with this roll. A roll PIN is printed on a card
            and typed by hand. */}
        <input
          id="roll-pin"
          name="pin"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(event) => setPin(event.target.value)}
          required
          autoFocus
        />
        <button type="submit" className="k-save" disabled={submitting}>
          {submitting ? 'Opening…' : 'Open roll'}
        </button>
      </form>
      {error === '' ? null : <p className="roll-alert" role="alert">{error}</p>}
    </main>
  );
}
