import { useEffect, useState } from 'react';
import { Button, ToolbarFrame } from '@kino/design-system';

/**
 * The guest QR as something a host can actually put on a table.
 *
 * It used to be a 220 px PNG with no print styles and no way to save it: the
 * only route to a printed code was a screenshot of a browser window. The card
 * below is the printed artefact — code, address, QR — and `host.css` hides the
 * rest of the dashboard when the page is printed. The PNG is encoded at 512 px
 * so the downloaded file survives being put on paper.
 *
 * `qrcode` is imported on demand, the way `components/ScanQr.tsx` already did
 * it. It was a static import here and a dynamic one there, which Vite reports
 * as a chunking conflict and resolves by giving up on the split: the encoder
 * ended up in the main chunk, so every guest scrolling a feed downloaded a QR
 * generator neither guest surface can reach.
 */

const QR_PIXELS = 512;

/** `kino.acronym.sk/r/NXVJHK` — the address as a person would read it out. */
export function spokenUrl(guestUrl: string): string {
  try {
    const url = new URL(guestUrl);
    return `${url.host}${url.pathname}`.replace(/\/$/, '');
  } catch {
    return guestUrl;
  }
}

export function QrCard({ guestUrl, slug }: { guestUrl: string; slug: string }) {
  const [source, setSource] = useState('');

  useEffect(() => {
    let active = true;
    void import('qrcode')
      .then(({ default: QRCode }) => QRCode.toDataURL(guestUrl, { width: QR_PIXELS, margin: 1 }))
      .then((value) => {
        if (active) setSource(value);
      })
      .catch(() => {
        // No QR. The code and the address are printed beside it and are what a
        // host reads out anyway; the card is still a card.
      });
    return () => {
      active = false;
    };
  }, [guestUrl]);

  return (
    <>
      <div className="host-qr-card">
        {source === '' ? (
          <div className="host-qr host-qr--empty" />
        ) : (
          <img
            className="host-qr"
            src={source}
            width={220}
            height={220}
            alt={`QR code for roll ${slug} at ${spokenUrl(guestUrl)}`}
          />
        )}
        <div className="host-qr-code">{slug}</div>
        <div className="host-qr-url">{spokenUrl(guestUrl)}</div>
      </div>
      <ToolbarFrame aria-label="Guest QR" className="host-qr-actions">
        {/* Rendered only once there is a PNG to hand over. An `<a>` with no
            `href` is not a link: it drops out of the tab order and out of the
            accessibility tree, so `aria-disabled` on it was decorating
            something a keyboard could not reach in either state. */}
        {source === '' ? (
          <Button size="sm" disabled>
            Download QR
          </Button>
        ) : (
          <a className="kino-button kino-button--sm" href={source} download={`kino-roll-${slug}.png`}>
            Download QR
          </a>
        )}
        <Button size="sm" onClick={() => window.print()}>
          Print card
        </Button>
      </ToolbarFrame>
    </>
  );
}
