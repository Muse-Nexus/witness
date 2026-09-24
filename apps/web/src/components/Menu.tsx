import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

export interface MenuAction {
  label: string;
  onSelect: () => void;
  tone?: 'danger';
}

/** A small "more" menu: button plus a list of actions. Escape and outside clicks close it. */
export function Menu({ label, actions, onOpenChange }: { label: string; actions: MenuAction[]; onOpenChange?: (open: boolean) => void }) {
  const [open, setOpenState] = useState(false);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  function setOpen(next: boolean) {
    setOpenState(next);
    onOpenChangeRef.current?.(next);
  }

  useEffect(() => {
    if (!open) return;
    items.current[0]?.focus();
    function onPointer(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  function close(focusButton = true) {
    setOpen(false);
    if (focusButton) button.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const list = items.current.filter((el): el is HTMLButtonElement => el !== null);
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      list[(index + 1) % list.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      list[(index - 1 + list.length) % list.length]?.focus();
    } else if (event.key === 'Tab') {
      close(false);
    }
  }

  return (
    <div className="menu" ref={root}>
      <button
        ref={button}
        type="button"
        className="menu__button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        onClick={() => setOpen(!open)}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
          <circle cx="5" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="19" cy="12" r="1.6" />
        </svg>
      </button>
      {open && (
        <div className="menu__list" role="menu" id={menuId} aria-label={label} onKeyDown={onKeyDown}>
          {actions.map((action, i) => (
            <button
              key={action.label}
              ref={(el) => {
                items.current[i] = el;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={action.tone ? `menu__item menu__item--${action.tone}` : 'menu__item'}
              onClick={() => {
                close();
                action.onSelect();
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
