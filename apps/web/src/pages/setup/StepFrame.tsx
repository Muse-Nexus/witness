import type { ReactNode } from 'react';
import { Link } from '../../app/router';
import { Eyebrow } from '../../components/Brand';

export type StepId = 'email' | 'texts' | 'rhythm' | 'assistant';

export const STEPS: { id: StepId; label: string; short: string; optional?: boolean }[] = [
  { id: 'email', label: 'Forward email', short: 'Email' },
  { id: 'texts', label: 'Texts & photos', short: 'Texts' },
  { id: 'rhythm', label: 'When to email you', short: 'Schedule' },
  { id: 'assistant', label: 'Your AI assistant', short: 'Assistant', optional: true },
];

const REQUIRED = STEPS.filter((s) => !s.optional).length;

export function isStep(value: string | null): value is StepId {
  return STEPS.some((s) => s.id === value);
}

export function stepHref(id: StepId): string {
  return `/app/setup?step=${id}`;
}

/** Heading and footer shared by every step, so each one stays short and alike. */
export function StepFrame({
  id,
  title,
  lede,
  children,
  next,
  secondary,
}: {
  id: StepId;
  title: string;
  lede: ReactNode;
  children: ReactNode;
  next: { label: string; to: string };
  /** Defaults to "Skip for now", which moves on without saving anything. */
  secondary?: { label: string; to: string } | null;
}) {
  const index = STEPS.findIndex((s) => s.id === id);
  const step = STEPS[index]!;
  const counter = step.optional ? 'Optional' : `Step ${index + 1} of ${REQUIRED}`;
  const other = secondary === undefined ? { label: 'Skip for now', to: next.to } : secondary;
  return (
    <section className="step" aria-labelledby={`step-${id}-title`}>
      <Eyebrow>
        {counter} · {step.label}
      </Eyebrow>
      <h1 id={`step-${id}-title`} className="display-sm">
        {title}
      </h1>
      <div className="lede">{lede}</div>
      <div className="step__body">{children}</div>
      <div className="step__footer">
        <Link to={next.to} className="btn btn--primary">
          {next.label} <span aria-hidden="true">→</span>
        </Link>
        {other && (
          <Link to={other.to} className="btn btn--quiet">
            {other.label}
          </Link>
        )}
      </div>
    </section>
  );
}
