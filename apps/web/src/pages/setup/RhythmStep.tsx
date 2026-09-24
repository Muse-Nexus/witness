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
      title="When should a witness reach you?"
      lede={
        <p>
          One email, with someone's exact words, at the time you choose. Nothing else. You can pause or stop it any
          time.
        </p>
      }
      next={{ label: 'Next: your AI assistant', to: stepHref('assistant') }}
      secondary={{ label: 'Finish', to: '/app' }}
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
