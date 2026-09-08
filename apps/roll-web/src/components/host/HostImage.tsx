import { useEffect, useState } from 'react';

/**
 * A host-dashboard picture, fetched with the host token.
 *
 * The dashboard cannot use a plain `<img src>`. `GET /api/assets/:id/content`
 * sits behind `requireHost`, which reads `Authorization: Bearer hrt_…` and
 * nothing else, and a browser following an `src` sends no such header — so the
 * moderation grid's hidden and trashed tiles answered 404, and on a PIN roll
 * every tile answered 401. Those are precisely the tiles a host opens the page
 * to look at: the picture is how they decide whether to unhide it.
 *
 * So the bytes are fetched, wrapped in an object URL, and the object URL is
 * revoked when this tile scrolls out of the virtualised grid or its asset
 * changes. Not revoking is a leak measured in whole photographs — a party
 * roll is two thousand tiles and the grid mounts and unmounts them all
 * evening.
 *
 * There is no retry and no spinner. A tile that cannot be fetched draws the
 * same neutral block the grid already uses for a capture with no preview yet;
 * one host, one page, and a re-render asks again.
 */
export function HostImage({
  assetId,
  assetBlob,
  className,
  alt = '',
}: {
  assetId: string;
  assetBlob: (assetId: string, signal?: AbortSignal) => Promise<Blob>;
  className?: string;
  alt?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let url: string | null = null;
    setSrc(null);
    setFailed(false);

    void assetBlob(assetId, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });

    return () => {
      controller.abort();
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [assetBlob, assetId]);

  if (failed) return <div className="host-capture-placeholder">Preview unavailable</div>;
  // The empty block holds the tile's shape while the bytes are on the wire, so
  // the grid does not reflow row by row as they land.
  if (src === null) return <div className={className} data-loading="" />;
  return <img className={className} src={src} alt={alt} decoding="async" />;
}
