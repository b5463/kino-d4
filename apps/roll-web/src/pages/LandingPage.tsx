import { useState, type FormEvent } from 'react';
import kinoRoll from '../assets/kino-roll-light.png';
import { readLastRoll, type LastRoll } from '../state/lastRoll';

/** A roll code is six characters; the slug alphabet has no 0, O, 1, I or L. */
export const ROLL_CODE_LENGTH = 6;
const ROLL_CODE = /^[23456789A-HJKMNP-Z]{6}$/;

/** Uppercase, no spaces: what a guest types off a card becomes what the URL wants. */
export function normaliseRollCode(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase().slice(0, ROLL_CODE_LENGTH);
}

export function isRollCode(code: string): boolean {
  return ROLL_CODE.test(code);
}

export interface LandingPageProps {
  /** Where the code goes; defaults to a full navigation to `/r/<CODE>`. */
  onOpen?(slug: string): void;
  lastRoll?: LastRoll | null;
}

/** `/` — the app's start page. One field, one button, one line. */
export function LandingPage({ onOpen, lastRoll = readLastRoll() }: LandingPageProps) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const open = onOpen ?? ((slug: string) => window.location.assign(`/r/${encodeURIComponent(slug)}`));

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const slug = normaliseRollCode(code);
    if (!isRollCode(slug)) {
      setError('A roll code is 6 letters and digits.');
      return;
    }
    setError('');
    open(slug);
  };

  return (
    <main className="k-gate k-landing">
      <img className="k-mark" src={kinoRoll} alt="KINO Roll" />
      <h1>Open a roll</h1>
      <form onSubmit={submit}>
        <label htmlFor="roll-code">Roll code</label>
        <input
          id="roll-code"
          name="code"
          type="text"
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          maxLength={ROLL_CODE_LENGTH}
          value={code}
          onChange={(event) => setCode(normaliseRollCode(event.target.value))}
          required
          autoFocus
        />
        <button type="submit" className="k-save">Open roll</button>
      </form>
      {error === '' ? null : <p className="k-gate-error" role="alert">{error}</p>}
      <p>Scan the code on the camera to join.</p>
      {lastRoll === null ? null : (
        <p>
          <a className="k-landing-back" href={`/r/${encodeURIComponent(lastRoll.slug)}`}>
            Back to {lastRoll.title.trim() === '' ? lastRoll.slug : lastRoll.title}
          </a>
        </p>
      )}
    </main>
  );
}
