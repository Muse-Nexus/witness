import { useApi } from '../../api/context';
import { useSession } from '../../app/session';
import { RhythmForm } from '../../components/RhythmForm';
import { useResource } from '../../lib/useResource';
import { StepFrame, stepHref } from './StepFrame';

export function RhythmStep() {
  const api = useApi();
  const { me } = useSession();
  const rhythm = useResource(() => api.rhythm());

  return (
    <StepFrame
      id="rhythm"
      title="When should Witness email you?"
      lede={
        <p>
          One email, with one thing you kept in someone's exact words, on the days and time you choose. Nothing else.
          Nothing in Maybe is ever emailed. You can pause or stop it any time.
        </p>
      }
      next={{ label: 'Next: your AI assistant', to: stepHref('assistant') }}
      secondary={{ label: 'Finish', to: '/app' }}
      quietNext
    >
      {rhythm.loading && !rhythm.data && !rhythm.error ? (
        <p className="loading" role="status">
          Loading…
        </p>
      ) : (
        <RhythmForm key={rhythm.data ? 'loaded' : 'default'} initial={rhythm.data} email={me.email} variant="setup" />
      )}
    </StepFrame>
  );
}
