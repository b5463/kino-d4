import type { ReactNode } from 'react';

export function Panel({
  title,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`panel${className ? ` ${className}` : ''}`}>
      <header className="panel-head">
        <h2 className="panel-title">{title}</h2>
        {/* .panel-actions wraps; .control does not, so long action clusters
            used to push the head wider than the panel. */}
        {actions ? <div className="panel-actions">{actions}</div> : null}
      </header>
      <div className={`panel-body${bodyClassName ? ` ${bodyClassName}` : ''}`}>{children}</div>
    </section>
  );
}
