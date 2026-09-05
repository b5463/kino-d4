import { useEffect, useState, type ImgHTMLAttributes } from 'react';

export interface SafeImageProps extends ImgHTMLAttributes<HTMLImageElement> {
  src: string;
  /** Offer one Retry that re-sets the src; the capture page wants it, tiles do not. */
  retry?: boolean;
}

/**
 * An `<img>` that fails to a neutral block instead of the browser's broken
 * icon. No external asset: the block is CSS and two words.
 */
export function SafeImage({ src, retry = false, className, ...rest }: SafeImageProps) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // A new src is a new picture; forget the old failure.
  useEffect(() => {
    setFailed(false);
    setAttempt(0);
  }, [src]);

  if (failed) {
    return (
      <span className={`k-img-missing${className === undefined ? '' : ` ${className}`}`} role="img" aria-label="Image unavailable">
        <span>Image unavailable</span>
        {retry && attempt === 0 ? (
          <button
            type="button"
            onClick={() => {
              setAttempt(1);
              setFailed(false);
            }}
          >
            Retry
          </button>
        ) : null}
      </span>
    );
  }

  // The key remounts the element, which is what makes the browser ask again.
  return <img key={attempt} {...rest} src={src} className={className} onError={() => setFailed(true)} />;
}
