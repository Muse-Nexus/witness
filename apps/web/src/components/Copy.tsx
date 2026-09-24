import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react';

/** Lets long addresses wrap after "@" and before dots instead of mid-word. */
function breakable(value: string): ReactNode {
  const parts = value.split(/(?<=@)|(?=\.)/);
  return parts.map((part, i) => (
    <Fragment key={i}>
      {i > 0 && <wbr />}
      {part}
    </Fragment>
  ));
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function useCopy(text: string) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    const ok = await copyText(text);
    setState(ok ? 'copied' : 'failed');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 2400);
  }
  return { state, copy };
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const { state, copy } = useCopy(text);
  return (
    <>
      <button type="button" className="btn btn--ghost btn--small copy__button" aria-label={`Copy ${label}`} onClick={copy}>
        {state === 'copied' ? 'Copied' : 'Copy'}
      </button>
      <span className="visually-hidden" role="status">
        {state === 'copied' ? `${label} copied.` : state === 'failed' ? 'Copy did not work. Select the text and copy it yourself.' : ''}
      </span>
    </>
  );
}

/** A single value (an address, a key) with a Copy button. */
export function CopyField({ value, label, hideLabel = false }: { value: string; label: string; hideLabel?: boolean }) {
  const id = useId();
  return (
    <div className="copy">
      <span id={id} className={hideLabel ? 'visually-hidden' : 'copy__label'}>
        {label}
      </span>
      <div className="copy__row">
        <output className="copy__value" aria-labelledby={id}>
          {breakable(value)}
        </output>
        <CopyButton text={value} label={label} />
      </div>
    </div>
  );
}

/** A multi-line snippet (a command, a config file) with a Copy button. */
export function CopyBlock({ value, label }: { value: string; label: string }) {
  return (
    <div className="copy copy--block">
      <pre className="copy__code" tabIndex={0} aria-label={label}>
        <code>{value}</code>
      </pre>
      <div className="copy__actions">
        <CopyButton text={value} label={label} />
      </div>
    </div>
  );
}
