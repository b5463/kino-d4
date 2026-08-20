import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
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
      onClick={busy ? undefined : onClick}
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
export function StatusLamp({ state, label }: { state: StatusLampState; label: string }) {
  return (
    <span className={`kino-status-lamp kino-status-lamp--${state} led led--${state}`}>
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

export function TabStrip({
  tabs,
  active,
  onChange,
  label,
}: {
  tabs: readonly TabItem[];
  active: string;
  onChange: (id: string) => void;
  label: string;
}) {
  return (
    <div className="kino-tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          className="kino-tab"
          aria-selected={tab.id === active}
          disabled={tab.disabled}
          onClick={() => onChange(tab.id)}
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

export function UtilitySlider({
  label,
  valueLabel,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; valueLabel: ReactNode }) {
  return (
    <label className={`kino-slider${className ? ` ${className}` : ''}`}>
      <span className="kino-slider-label">{label}</span>
      <input type="range" {...props} />
      <output className="kino-slider-value">{valueLabel}</output>
    </label>
  );
}
