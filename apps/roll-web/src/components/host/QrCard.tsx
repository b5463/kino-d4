import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Button, ToolbarFrame } from '@kino/design-system';

/**
 * The guest QR as something a host can actually put on a table.
 *
 * It used to be a 220 px PNG with no print styles and no way to save it: the
 * only route to a printed code was a screenshot of a browser window. The card
 * below is the printed artefact — code, address, QR — and `host.css` hides the
 * rest of the dashboard when the page is printed. The PNG is encoded at 512 px
 * so the downloaded file survives being put on paper.
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
    void QRCode.toDataURL(guestUrl, { width: QR_PIXELS, margin: 1 }).then((value) => {
      if (active) setSource(value);
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
        <a
          className="kino-button kino-button--sm"
          href={source === '' ? undefined : source}
          download={`kino-roll-${slug}.png`}
          aria-disabled={source === ''}
        >
          Download QR
        </a>
        <Button size="sm" onClick={() => window.print()}>
          Print card
        </Button>
      </ToolbarFrame>
    </>
  );
}
