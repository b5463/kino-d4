import { useOnline } from '../hooks/useOnline';

/** A slim line at the top while the phone has no network. Nothing else changes. */
export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div className="k-offline" role="status" aria-live="polite">
      Offline — showing what was loaded
    </div>
  );
}
