import { useEffect, useRef, useState } from 'react';

/**
 * Corner QR for display mode: scan the screen to join the roll on your phone.
 *
 * `qrcode` is imported on demand, the way the Studio's `GuestQr` does it — the
 * encoder only loads on a display that actually shows the overlay, never for a
 * guest scrolling the feed. The slug is printed beneath because a QR nobody can
 * read out loud is useless over a phone.
 */
export function ScanQr({ slug }: { slug: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  const url = `${window.location.origin}/r/${encodeURIComponent(slug)}`;

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (canvas === null) return;
    void import('qrcode')
      .then(({ default: QRCode }) => {
        if (cancelled) return;
        return QRCode.toCanvas(canvas, url, { width: 160, margin: 1 });
      })
      .then(() => {
        if (!cancelled) setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <div className="display-qr">
      {failed ? null : (
        <canvas ref={canvasRef} width={160} height={160} role="img" aria-label={`QR code for ${url}`} />
      )}
      <code className="display-qr-slug">{slug}</code>
    </div>
  );
}
