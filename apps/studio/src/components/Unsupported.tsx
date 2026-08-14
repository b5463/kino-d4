import { Icon } from './Icon';

/**
 * Capability gate placeholder. A feature the connected firmware does not
 * implement is stated plainly — never left to time out.
 */
export function Unsupported({
  feature,
  firmware,
  note,
}: {
  feature: string;
  firmware?: string | null;
  note?: string;
}) {
  return (
    <p className="notice notice--warn">
      <Icon name="warning" />
      <span>
        <strong>{feature}</strong> is not supported by firmware {firmware ?? 'on this camera'}.
        {note ? ` ${note}` : ''}
      </span>
    </p>
  );
}
