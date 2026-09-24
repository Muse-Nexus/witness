import { Fragment, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';

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

/** Selects an element's text, so it can be copied by hand when the clipboard is not allowed. */
function selectContents(element: HTMLElement | null) {
  const selection = typeof window.getSelection === 'function' ? window.getSelection() : null;
  if (!element || !selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

type CopyState = 'idle' | 'copied' | 'failed';

function useCopy(text: string, target: RefObject<HTMLElement | null>) {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    const ok = await copyText(text);
    window.clearTimeout(timer.current);
    if (ok) {
      setState('copied');
      timer.current = window.setTimeout(() => setState('idle'), 2400);
    } else {
      // Say so where it can be seen, and select the text, so the person can copy it themselves.
      setState('failed');
      selectContents(target.current);
    }
  }
  return { state, copy };
}

function CopyButton({ label, state, copy }: { label: string; state: CopyState; copy: () => Promise<void> }) {
  return (
    <>
      <button type="button" className="btn btn--ghost btn--small copy__button" aria-label={`Copy ${label}`} onClick={() => void copy()}>
        {state === 'copied' ? 'Copied' : 'Copy'}
      </button>
      <span className="visually-hidden" role="status">
        {state === 'copied' ? `${label} copied.` : ''}
      </span>
    </>
  );
}

function CopyFailed({ state }: { state: CopyState }) {
  if (state !== 'failed') return null;
  return (
    <p className="form-error" role="alert">
      Copy did not work. The text is selected, so you can copy it yourself.
    </p>
  );
}

/** A single value (an address, a key) with a Copy button. */
export function CopyField({ value, label, hideLabel = false }: { value: string; label: string; hideLabel?: boolean }) {
  const id = useId();
  const valueRef = useRef<HTMLOutputElement>(null);
  const { state, copy } = useCopy(value, valueRef);
  return (
    <div className="copy">
      <span id={id} className={hideLabel ? 'visually-hidden' : 'copy__label'}>
        {label}
      </span>
      <div className="copy__row">
        <output ref={valueRef} className="copy__value" aria-labelledby={id}>
          {breakable(value)}
        </output>
        <CopyButton label={label} state={state} copy={copy} />
      </div>
      <CopyFailed state={state} />
    </div>
  );
}

/** A multi-line snippet (a command, a config file) with a Copy button. */
export function CopyBlock({ value, label }: { value: string; label: string }) {
  const codeRef = useRef<HTMLElement>(null);
  const { state, copy } = useCopy(value, codeRef);
  return (
    <div className="copy copy--block">
      <pre className="copy__code" tabIndex={0} aria-label={label}>
        <code ref={codeRef}>{value}</code>
      </pre>
      <div className="copy__actions">
        <CopyButton label={label} state={state} copy={copy} />
      </div>
      <CopyFailed state={state} />
    </div>
  );
}
