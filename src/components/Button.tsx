import type { ButtonHTMLAttributes, Ref } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'danger' | 'danger-solid' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  busy?: boolean;
  /** React 19 passes ref straight through to the element. */
  ref?: Ref<HTMLButtonElement>;
}

/**
 * Busy is not disabled. A running action stays visually itself and reports
 * `aria-busy`; it only blocks the click. Rendering busy as `disabled` made
 * a running APPLY look greyed-out and unavailable, and dropped keyboard
 * focus to <body> for the length of the operation.
 */
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
  const classes = ['btn'];
  if (variant !== 'default') classes.push(`btn--${variant}`);
  if (size !== 'md') classes.push(`btn--${size}`);
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
      {busy ? <span className="btn-spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}
