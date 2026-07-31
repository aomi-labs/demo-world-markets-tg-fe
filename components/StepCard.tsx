import type { ReactNode } from 'react';

export type StepStatus = 'idle' | 'active' | 'done' | 'error';

export function StepCard({
  index,
  title,
  subtitle,
  status,
  children,
}: {
  index: number;
  title: string;
  subtitle?: string;
  status: StepStatus;
  children?: ReactNode;
}) {
  return (
    <section className={`step step--${status}`}>
      <header className="step__head">
        <span className="step__index" aria-hidden>
          {status === 'done' ? '✓' : index}
        </span>
        <div>
          <h2 className="step__title">{title}</h2>
          {subtitle ? <p className="step__subtitle">{subtitle}</p> : null}
        </div>
      </header>
      {children ? <div className="step__body">{children}</div> : null}
    </section>
  );
}
