/**
 * The latest result beside the body: no border, no radius, no caption word.
 * In Wiggle it is the frame whose cell is ringed; in Quad it is the frame of
 * the selected lens. Under it, one grey line with the time and the camera's
 * own count. Clicking it opens the photo.
 */
export function ResultPhoto({
  url,
  filter,
  caption,
  alt,
  onOpen,
}: {
  url: string | null;
  filter?: string;
  caption: string | null;
  alt: string;
  onOpen?: () => void;
}) {
  if (!url) return <div className="c-result" aria-hidden="true" />;
  const img = <img src={url} alt={alt} style={{ filter: filter ?? 'none' }} />;
  return (
    <figure className="c-result">
      {onOpen ? (
        <button type="button" onClick={onOpen} title="Open this photo">
          {img}
        </button>
      ) : (
        img
      )}
      {caption ? <figcaption className="c-result-caption">{caption}</figcaption> : null}
    </figure>
  );
}
