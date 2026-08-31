import { useId } from 'react';
import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  KeyboardEvent,
  ReactNode,
  Ref,
  TableHTMLAttributes,
} from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'danger' | 'danger-solid' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  busy?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

/** Shared beveled command button. Busy actions retain focus and identity. */
export function Button({
  variant = 'default',
  size = 'md',
  busy,
  className,
  children,
  disabled,
  onClick,
  ...rest
}: ButtonProps) {
  const classes = ['kino-button', 'btn'];
  if (variant !== 'default') classes.push(`kino-button--${variant}`, `btn--${variant}`);
  if (size !== 'md') classes.push(`kino-button--${size}`, `btn--${size}`);
  if (busy) classes.push('is-busy');
  if (className) classes.push(className);
  return (
    <button
      type="button"
      className={classes.join(' ')}
      disabled={disabled}
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
      onClick={(event) => {
        if (busy) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      {...rest}
    >
      {busy ? <span className="kino-button-spinner btn-spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export interface PanelProps {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}

/** Compact group box with a one-pixel title band. */
export function Panel({ title, actions, children, className, bodyClassName }: PanelProps) {
  return (
    <section className={`kino-panel panel${className ? ` ${className}` : ''}`}>
      <header className="kino-panel-head panel-head">
        <h2 className="kino-panel-title panel-title">{title}</h2>
        {actions ? <div className="kino-panel-actions panel-actions">{actions}</div> : null}
      </header>
      <div className={`kino-panel-body panel-body${bodyClassName ? ` ${bodyClassName}` : ''}`}>
        {children}
      </div>
    </section>
  );
}

export type StatusLampState = 'ok' | 'warn' | 'err' | 'busy' | 'off';

const STATUS_SYMBOL: Record<StatusLampState, string> = {
  ok: '●',
  warn: '▲',
  err: '×',
  busy: '●',
  off: '○',
};

/** Symbol and text are both present; state never depends on colour alone. */
export function StatusLamp({
  state,
  label,
  announce = false,
  accessibleLabel,
}: {
  state: StatusLampState;
  label: string;
  /** Announce meaningful state transitions without making every decorative lamp a live region. */
  announce?: boolean;
  /** Keeps a compact visually-silent lamp named for assistive technology. */
  accessibleLabel?: string;
}) {
  return (
    <span
      className={`kino-status-lamp kino-status-lamp--${state} led led--${state}`}
      /**
       * A bare `aria-label` on a `<span>` names nothing: the span has no role,
       * so a screen reader is free to ignore the label and read the visible
       * text instead — which for a compact lamp is the empty string. The lamp
       * needs a role the moment it carries a name of its own. `status` when it
       * announces (a live region), `img` otherwise: the lamp is a glyph
       * standing for a state, and `img` is the role that makes a name
       * mandatory and the contents opaque.
       */
      role={announce ? 'status' : accessibleLabel ? 'img' : undefined}
      aria-live={announce ? 'polite' : undefined}
      aria-atomic={announce || undefined}
      aria-label={accessibleLabel}
    >
      <span className="kino-status-symbol led-dot" aria-hidden="true">
        {STATUS_SYMBOL[state]}
      </span>
      <span className="kino-status-label led-label">{label}</span>
    </span>
  );
}

export function ToolbarFrame({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`kino-toolbar${className ? ` ${className}` : ''}`} role="toolbar" {...props} />;
}

export interface TabItem {
  id: string;
  label: ReactNode;
  disabled?: boolean;
}

/**
 * The two element ids that tie a tab to the panel it controls.
 *
 * A `role="tab"` with no `aria-controls` is a button that announces itself as
 * a tab and cannot say what it shows; the panel is then an unlabelled region
 * the reader has to find on its own. Both ends need the same string, so the
 * strip and the panel derive it from one function rather than each spelling it
 * out.
 *
 * `prefix` exists because tab ids are only unique within a strip — two strips
 * on one page with a `details` tab each would otherwise mint the same DOM id
 * twice, and a duplicate id makes `aria-controls` point at whichever came
 * first.
 */
export function tabIds(tabId: string, prefix = 'kino'): { tab: string; panel: string } {
  return { tab: `${prefix}-tab-${tabId}`, panel: `${prefix}-panel-${tabId}` };
}

export function TabStrip({
  tabs,
  active,
  onChange,
  label,
  idPrefix = 'kino',
}: {
  tabs: readonly TabItem[];
  active: string;
  onChange: (id: string) => void;
  label: string;
  /**
   * Namespace for the generated tab/panel ids. Pass the same value to
   * `tabIds()` where the panel is rendered — the panel is expected to carry
   * `id={tabIds(active, prefix).panel}`, `role="tabpanel"` and
   * `aria-labelledby={tabIds(active, prefix).tab}`.
   */
  idPrefix?: string;
}) {
  const enabled = tabs.filter((tab) => !tab.disabled);
  const focusId = enabled.some((tab) => tab.id === active) ? active : enabled[0]?.id;

  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, direction: -1 | 1 | 'home' | 'end') => {
    if (enabled.length === 0) return;
    const current = enabled.findIndex((tab) => tab.id === event.currentTarget.dataset.tabId);
    const nextIndex =
      direction === 'home' ? 0
      : direction === 'end' ? enabled.length - 1
      : (Math.max(0, current) + direction + enabled.length) % enabled.length;
    const next = enabled[nextIndex];
    if (next === undefined) return;
    event.preventDefault();
    onChange(next.id);
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    Array.from(buttons ?? []).find((button) => button.dataset.tabId === next.id)?.focus();
  };

  return (
    <div className="kino-tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          className="kino-tab"
          id={tabIds(tab.id, idPrefix).tab}
          data-tab-id={tab.id}
          aria-selected={tab.id === active}
          aria-controls={tabIds(tab.id, idPrefix).panel}
          tabIndex={tab.id === focusId ? 0 : -1}
          /**
           * `aria-disabled`, not the `disabled` attribute. A disabled button is
           * dropped from the accessibility tree by some readers, so a tab that
           * exists but is unavailable — the usual reason a KINO tab is off is a
           * capability the camera does not advertise — simply vanishes, and the
           * user cannot tell an absent feature from a broken app. This keeps
           * the tab announced and named, and refuses the activation instead.
           */
          aria-disabled={tab.disabled || undefined}
          onClick={() => {
            if (tab.disabled) return;
            onChange(tab.id);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight') moveFocus(event, 1);
            else if (event.key === 'ArrowLeft') moveFocus(event, -1);
            else if (event.key === 'Home') moveFocus(event, 'home');
            else if (event.key === 'End') moveFocus(event, 'end');
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function CompactTable({ className, ...props }: TableHTMLAttributes<HTMLTableElement>) {
  return <table className={`kino-table table${className ? ` ${className}` : ''}`} {...props} />;
}

export function ClassicProgressBar({
  value,
  max = 100,
  label,
  state = 'normal',
}: {
  value: number;
  max?: number;
  label: string;
  state?: 'normal' | 'ok' | 'warn' | 'err';
}) {
  const bounded = Math.min(max, Math.max(0, value));
  const percent = max > 0 ? (bounded / max) * 100 : 0;
  return (
    <span
      className="kino-progress meter"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={bounded}
    >
      <span
        className={`kino-progress-fill kino-progress-fill--${state} meter-fill${state === 'normal' ? '' : ` meter-fill--${state}`}`}
        style={{ width: `${String(percent)}%` }}
      />
    </span>
  );
}

/**
 * Range input with its own name and a live readout of its value.
 *
 * The readout sits outside the `<label>` on purpose. Nesting it inside made
 * the label's accessible name the label text *plus the current value*, so the
 * control renamed itself on every drag — a screen reader announces "Brightness
 * 7" as the name of the slider, then 8, then 9, and the user never hears a
 * stable name. The `<label>` names it once via `htmlFor`; the `<output>` points
 * at the same input with `for` and reports the value separately.
 */
export function UtilitySlider({
  label,
  valueLabel,
  className,
  id,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; valueLabel: ReactNode }) {
  const generated = useId();
  const inputId = id ?? `${generated}slider`;
  return (
    <div className={`kino-slider${className ? ` ${className}` : ''}`}>
      <label className="kino-slider-label" htmlFor={inputId}>
        {label}
      </label>
      <input id={inputId} type="range" {...props} />
      <output className="kino-slider-value" htmlFor={inputId}>
        {valueLabel}
      </output>
    </div>
  );
}
