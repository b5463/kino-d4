/**
 * The tags a pasted link is previewed from.
 *
 * A guest shares a photograph by sending the URL to somebody, and a messenger
 * that finds no `og:*` on it shows a blank card with a bare host name. This
 * writes the three tags every one of them reads — title, description, image —
 * plus the `twitter:card` that makes the image large rather than a 60 px
 * square.
 *
 * ## What this can and cannot do
 *
 * These are set from the client, after the roll and the capture have loaded.
 * A crawler that does not run JavaScript sees only the static defaults in
 * `index.html`. That is the honest limit of a static-hosted SPA: making a
 * pasted link preview the actual photograph for every scraper needs the API
 * to render the tags server-side for `/r/*`, which is a different task and a
 * different repo layer. The defaults are written so the blank card is at
 * least a KINO card, and every scraper that does run JS (and the browser tab,
 * and the share sheet's own title) gets the real thing.
 *
 * `noindex` is NOT touched here. Rolls are unlisted (03§9); an og:image is
 * how a link looks when someone deliberately sends it, not an invitation to
 * index it, and the two are independent tags.
 */

export interface RouteMeta {
  /** `<title>`, and `og:title`. */
  title: string;
  description: string;
  /** Absolute URL of the picture to preview, when there is one. */
  image?: string;
  /** Canonical URL of the thing being shared. */
  url?: string;
}

function upsert(selector: string, make: () => HTMLMetaElement, content: string): void {
  const head = document.head;
  let tag = head.querySelector<HTMLMetaElement>(selector);
  if (tag === null) {
    tag = make();
    head.append(tag);
  }
  tag.content = content;
}

function property(name: string, content: string): void {
  upsert(`meta[property="${name}"]`, () => {
    const tag = document.createElement('meta');
    tag.setAttribute('property', name);
    return tag;
  }, content);
}

function named(name: string, content: string): void {
  upsert(`meta[name="${name}"]`, () => {
    const tag = document.createElement('meta');
    tag.name = name;
    return tag;
  }, content);
}

/** Same-origin relative paths become absolute: a scraper cannot resolve `/api/...`. */
export function absoluteUrl(path: string): string {
  if (typeof window === 'undefined') return path;
  return new URL(path, window.location.href).toString();
}

/** Writes the preview tags for whatever the page is currently showing. */
export function setRouteMeta(meta: RouteMeta): void {
  if (typeof document === 'undefined') return;
  document.title = meta.title;
  property('og:type', 'website');
  property('og:site_name', 'KINO Roll');
  property('og:title', meta.title);
  property('og:description', meta.description);
  property('og:url', meta.url ?? absoluteUrl(window.location.pathname));
  named('description', meta.description);
  named('twitter:card', meta.image === undefined ? 'summary' : 'summary_large_image');
  named('twitter:title', meta.title);
  named('twitter:description', meta.description);
  if (meta.image !== undefined) {
    property('og:image', meta.image);
    named('twitter:image', meta.image);
  }
}
