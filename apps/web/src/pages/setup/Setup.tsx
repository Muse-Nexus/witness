import { Link, useSearchParam } from '../../app/router';
import { AppPage } from '../../components/Layout';
import { useTitle } from '../../lib/useTitle';
import { AssistantStep } from './AssistantStep';
import { EmailStep } from './EmailStep';
import { RhythmStep } from './RhythmStep';
import { STEPS, isStep, stepHref, type StepId } from './StepFrame';
import { TextsStep } from './TextsStep';

export function Setup() {
  const param = useSearchParam('step');
  const current: StepId = isStep(param) ? param : 'email';
  const label = STEPS.find((s) => s.id === current)?.label;
  useTitle(`Set up · ${label}`);

  return (
    <AppPage className="container setup">
      <div className="setup__grid">
        <nav className="steps" aria-label="Setup steps">
          <p className="steps__intro">
            Set it up once, on a good day. Every step can be skipped and done later.
          </p>
          <ol className="steps__list">
            {STEPS.map((step, i) => (
              <li key={step.id} className={step.optional ? 'steps__item steps__item--optional' : 'steps__item'}>
                <Link
                  to={stepHref(step.id)}
                  replace
                  className="steps__link"
                  aria-current={step.id === current ? 'step' : undefined}
                >
                  <span className="steps__num" aria-hidden="true">
                    {step.optional ? '+' : String(i + 1).padStart(2, '0')}
                  </span>
                  <span className="steps__label">
                    {step.label}
                    {step.optional && <span className="steps__optional"> (optional)</span>}
                  </span>
                  <span className="steps__short" aria-hidden="true">
                    {step.short}
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </nav>
        <div className="setup__panel">
          {current === 'email' && <EmailStep />}
          {current === 'texts' && <TextsStep />}
          {current === 'rhythm' && <RhythmStep />}
          {current === 'assistant' && <AssistantStep />}
        </div>
      </div>
    </AppPage>
  );
}
