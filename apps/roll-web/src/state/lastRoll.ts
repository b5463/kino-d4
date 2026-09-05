/**
 * The roll last opened on this phone, so the landing page can offer a way
 * back. localStorage may be absent or throw (private mode, blocked storage);
 * every access is guarded and a failure means "nothing remembered".
 */
const KEY = 'kino-roll:last';

export interface LastRoll {
  slug: string;
  title: string;
}

export function rememberRoll(slug: string, title: string): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ slug, title }));
  } catch {
    // Storage unavailable; the landing page simply has no way back to offer.
  }
}

export function readLastRoll(): LastRoll | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { slug, title } = parsed as { slug?: unknown; title?: unknown };
    if (typeof slug !== 'string' || slug === '') return null;
    return { slug, title: typeof title === 'string' ? title : '' };
  } catch {
    return null;
  }
}
