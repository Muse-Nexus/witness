import { AssistantKey } from '../../components/AssistantKey';
import { StepFrame } from './StepFrame';

export const ASK_FIRST = [
  'Your assistant asks first, in its own words. At that point it has seen nothing.',
  'Only if you say yes does it receive one thing to show you, exactly as it was said, with who and when.',
  'If you say no, or seem unsure, it lets it go for the rest of the conversation. It can ask at most once a day, and not at all while Witness is paused.',
  'It is told to put crisis resources first, and never to use what you kept to argue with how you feel.',
  'Search is off unless you turn it on below. With it on, the assistant sees what it finds when you ask it to look for something.',
];

export function AskFirst() {
  return (
    <div className="ask-first">
      <h2 className="ask-first__title">How ask-first works</h2>
      <ol className="ask-first__list">
        {ASK_FIRST.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ol>
    </div>
  );
}

export function AssistantStep() {
  return (
    <StepFrame
      id="assistant"
      title="Let your assistant offer one."
      lede={
        <p>
          If you use Claude, Codex, or another assistant that speaks MCP, it can offer you a witness at a calm moment.
          It can also add kind things you share with it.
        </p>
      }
      next={{ label: 'Done', to: '/app' }}
      secondary={null}
    >
      <AskFirst />
      <AssistantKey />
    </StepFrame>
  );
}
