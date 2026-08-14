import { useId, useState } from 'react';
import type { ReactNode } from 'react';

// Small form-field kit. Every control renders inside a `.field` row with a
// technical uppercase label; keyboard and screen-reader semantics come from
// native elements or explicit ARIA where a native element doesn't fit.
//
// `hint` is where a field explains itself: what it depends on, why it is
// disabled, what a rejected entry was clamped to. A disabled control with no
// stated reason is a dead end.

function Hint({ text, warn, id }: { text?: string; warn?: boolean; id?: string }) {
  if (!text) return null;
  return (
    <p className={warn ? 'field-hint field-hint--warn' : 'field-hint'} id={id}>
      {text}
    </p>
  );
}

export function FieldRow({
  label,
  children,
  htmlFor,
  hint,
  hintWarn,
  hintId,
}: {
  label: string;
  children: ReactNode;
  htmlFor?: string;
  hint?: string;
  hintWarn?: boolean;
  hintId?: string;
}) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="control">{children}</div>
      <Hint text={hint} warn={hintWarn} id={hintId} />
    </div>
  );
}

export function SelectField({
  label,
  value,
  options,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
  hint?: string;
}) {
  const id = useId();
  return (
    <FieldRow label={label} htmlFor={id} hint={hint}>
      <select id={id} className="input" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldRow>
  );
}

export function SegField({
  label,
  value,
  options,
  onChange,
  disabled,
  hint,
  hintWarn,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
  hint?: string;
  hintWarn?: boolean;
}) {
  const hintId = useId();
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="control" role="group" aria-label={label} aria-describedby={hint ? hintId : undefined}>
        <span className="seg">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              className="seg-opt"
              aria-pressed={o.value === value}
              disabled={disabled}
              onClick={() => onChange(o.value)}
            >
              {o.label}
            </button>
          ))}
        </span>
      </div>
      <Hint text={hint} warn={hintWarn} id={hintId} />
    </div>
  );
}

export function ToggleField({
  label,
  checked,
  onChange,
  onLabel = 'ON',
  offLabel = 'OFF',
  disabled,
  hint,
  hintWarn,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  onLabel?: string;
  offLabel?: string;
  disabled?: boolean;
  hint?: string;
  hintWarn?: boolean;
}) {
  const hintId = useId();
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="control">
        <button
          type="button"
          className="toggle"
          role="switch"
          aria-checked={checked}
          aria-label={label}
          aria-describedby={hint ? hintId : undefined}
          disabled={disabled}
          onClick={() => onChange(!checked)}
        >
          <span className="toggle-track">
            <span className="toggle-thumb" />
          </span>
          <span className="toggle-state">{checked ? onLabel : offLabel}</span>
        </button>
      </div>
      <Hint text={hint} warn={hintWarn} id={hintId} />
    </div>
  );
}

export function SliderField({
  label,
  value,
  min,
  max,
  step = 1,
  format,
  onChange,
  disabled,
  hint,
  hintWarn,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  onChange: (value: number) => void;
  disabled?: boolean;
  hint?: string;
  hintWarn?: boolean;
}) {
  const id = useId();
  return (
    <FieldRow label={label} htmlFor={id} hint={hint} hintWarn={hintWarn}>
      <span className="sliderwrap">
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <span className="slider-val">{format ? format(value) : value}</span>
      </span>
    </FieldRow>
  );
}

/**
 * Typed numeric entry. A typed value is validated on Enter or blur, not per
 * keystroke: the old version silently dropped anything unparseable, so
 * clearing the box and typing `-` looked like the field had eaten the value.
 * Out-of-range entries are clamped and the field says so.
 */
export function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  /** Shown after the box, e.g. `mm`. Never uppercased. */
  unit?: string;
  onChange: (value: number) => void;
  disabled?: boolean;
  hint?: string;
}) {
  const id = useId();
  const hintId = useId();
  const [typed, setTyped] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // An external change (slider, preset, device refresh) wins over stale text.
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setTyped(null);
    setProblem(null);
  }

  const range =
    min !== undefined && max !== undefined ? `${min} to ${max}${unit ? ` ${unit}` : ''}` : null;

  const commit = (raw: string) => {
    setTyped(null);
    const v = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(v)) {
      setProblem(`Not a number. Kept ${value}${unit ? ` ${unit}` : ''}.`);
      return;
    }
    let out = v;
    if (min !== undefined && out < min) out = min;
    if (max !== undefined && out > max) out = max;
    setProblem(out === v ? null : `Out of range. Clamped to ${out}${unit ? ` ${unit}` : ''}.`);
    if (out !== value) onChange(out);
  };

  return (
    <FieldRow
      label={label}
      htmlFor={id}
      hintId={hintId}
      hint={problem ?? hint ?? (range ? `Range ${range}` : undefined)}
      hintWarn={problem !== null}
    >
      <input
        id={id}
        type="number"
        className="input"
        value={typed ?? String(value)}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-describedby={hintId}
        aria-invalid={problem !== null || undefined}
        onChange={(e) => setTyped(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
        }}
      />
      {unit ? <span className="unit">{unit}</span> : null}
    </FieldRow>
  );
}

export function TextField({
  label,
  value,
  onChange,
  maxLength,
  placeholder,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
  placeholder?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <FieldRow label={label} htmlFor={id}>
      <input
        id={id}
        type="text"
        className="input"
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </FieldRow>
  );
}
