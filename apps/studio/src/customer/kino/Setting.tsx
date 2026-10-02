import type { RowMark } from '../shoot/useSaved';

/** The word at the end of a setting: Saved, KINO adjusted this, or a retry. */
export function SettingMark({ mark, onRetry }: { mark: RowMark; onRetry: () => void }) {
  if (!mark) return null;
  return (
    <span className="c-setting-action c-mark" role="status">
      {mark}
      {mark === "KINO didn't save this." ? (
        <button type="button" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </span>
  );
}

/** One line of the quiet list: a label, a sentence, one action word. */
export function SettingRow({
  label,
  children,
  action,
  onAction,
  warning = false,
  disabled = false,
}: {
  label: string;
  children: React.ReactNode;
  action?: string;
  onAction?: () => void;
  warning?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="c-setting is-wide">
      <span className="c-setting-label">{label}</span>
      <span className="c-setting-body">{children}</span>
      {action && onAction ? (
        <span className="c-setting-action">
          <button type="button" className={warning ? 'is-warning' : undefined} disabled={disabled} onClick={onAction}>
            {action}
          </button>
        </span>
      ) : null}
    </div>
  );
}
