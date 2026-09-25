import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { mediaUrlFor } from '../api/client';
import type { Category, Item, ItemPatch } from '../api/types';
import { CATEGORIES, CATEGORY_LABELS, canBlockSender } from '../lib/categories';
import { formatDate, fromDateInputValue, toDateInputValue } from '../lib/format';
import { QuoteMark } from './Brand';
import { Menu, type MenuAction } from './Menu';

export type QuoteCardItem = Pick<
  Item,
  | 'id'
  | 'quote'
  | 'fromName'
  | 'occurredAt'
  | 'sourceLabel'
  | 'sourceType'
  | 'category'
  | 'categoryKnown'
  | 'mediaType'
  | 'mediaUrl'
  | 'edited'
  | 'canBlockSender'
>;

/**
 * The first few words of the quote, so screen-reader users can tell cards apart
 * ("Options for “Proud of you, kid. Always…” from Dad"). Never a paraphrase: exact words, cut short.
 */
function about(item: QuoteCardItem): string {
  if (!item.quote) return 'the image';
  const words = item.quote.trim().split(/\s+/);
  const first = words.slice(0, 5).join(' ');
  return `“${first}${words.length > 5 ? '…' : ''}”`;
}

function who(item: QuoteCardItem): string {
  return item.fromName?.trim() || 'Someone';
}

function imageAlt(item: QuoteCardItem): string {
  // Witness does not look inside images, so the description is only what it knows.
  const date = item.occurredAt != null ? `, ${formatDate(item.occurredAt)}` : '';
  return `Image from ${who(item)}${date}, via ${item.sourceLabel}`;
}

/** The evidence itself: exact words (or the original image), who, when, where from. */
export function QuoteBody({ item, label }: { item: QuoteCardItem; label?: ReactNode }) {
  const media = mediaUrlFor(item);
  // Some photos (HEIC from an iPhone) cannot be drawn by every browser. Say so plainly,
  // with a way to open the original, rather than showing a broken image.
  const [broken, setBroken] = useState(false);
  return (
    <>
      <div className="quote-card__head">
        {/* No guessed label on the card itself (SAFETY §2: never manufacture meaning); it lives in Edit details. */}
        {label ?? null}
      </div>
      {media &&
        (broken ? (
          <p className="quote-card__media-note">
            This browser cannot show this photo{item.mediaType === 'image/heic' ? ' (it is a HEIC file)' : ''}.{' '}
            <a href={media} download>
              Download the original
            </a>
          </p>
        ) : (
          <figure className="quote-card__media">
            <img src={media} alt={imageAlt(item)} loading="lazy" decoding="async" onError={() => setBroken(true)} />
          </figure>
        ))}
      {item.quote && (
        <blockquote className="quote-card__quote">
          <QuoteMark />
          <p>{item.quote}</p>
        </blockquote>
      )}
      <p className="quote-card__meta">
        <span className="quote-card__who">— {who(item)}</span>
        <span aria-hidden="true"> · </span>
        <span>{formatDate(item.occurredAt)}</span>
        <span aria-hidden="true"> · </span>
        <span>{item.sourceLabel}</span>
        {item.edited && (
          <>
            <span aria-hidden="true"> · </span>
            <span>edited</span>
          </>
        )}
      </p>
    </>
  );
}

function EditDetails({
  item,
  onSave,
  onCancel,
}: {
  item: QuoteCardItem;
  onSave: (patch: ItemPatch) => Promise<void>;
  onCancel: () => void;
}) {
  const id = useId();
  const [fromName, setFromName] = useState(item.fromName ?? '');
  const initialDate = toDateInputValue(item.occurredAt);
  const [date, setDate] = useState(initialDate);
  // An unsorted item has no label yet, so the choice starts blank; core cannot clear a label, so
  // "Not sorted" is offered only while it is unsorted, and choosing it sends nothing.
  const unsorted = item.categoryKnown === false;
  const [category, setCategory] = useState<Category | ''>(unsorted ? '' : item.category);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    // Only what changed is sent: an untouched date keeps its exact moment, not "midday".
    const patch: ItemPatch = {};
    const name = fromName.trim() || null;
    if (name !== (item.fromName?.trim() || null)) patch.fromName = name;
    if (date !== initialDate) patch.occurredAt = date ? (fromDateInputValue(date) ?? null) : null;
    if (category && (unsorted || category !== item.category)) patch.category = category;
    if (Object.keys(patch).length === 0) {
      onCancel();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave(patch);
    } catch {
      // The form stays open with what was typed, so nothing is lost.
      setError('That did not save. Your changes are still here; try again in a moment.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="quote-card__edit" onSubmit={submit} aria-label="Edit details">
      <p className="quote-card__edit-note">The words stay exactly as they were. You can change who said it, when, and the label.</p>
      <div className="field">
        <label htmlFor={`${id}-who`}>Who said it</label>
        <input id={`${id}-who`} value={fromName} onChange={(e) => setFromName(e.target.value)} autoComplete="off" />
      </div>
      <div className="field">
        <label htmlFor={`${id}-when`}>When</label>
        <input id={`${id}-when`} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-kind`}>Label (Witness's guess)</label>
        <select id={`${id}-kind`} value={category} onChange={(e) => setCategory(e.target.value as Category | '')}>
          {unsorted && <option value="">Not sorted</option>}
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="button-row">
        <button type="submit" className="btn btn--primary btn--small" disabled={busy}>
          Save
        </button>
        <button type="button" className="btn btn--quiet btn--small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * "Never save from this sender" asks once, because it can take away a lot: it names the
 * sender, says how many things are kept from them, and keeps them unless asked not to.
 */
function BlockConfirm({
  item,
  countFromSender,
  onBlock,
  onCancel,
}: {
  item: QuoteCardItem;
  countFromSender?: ((item: QuoteCardItem) => Promise<number | null>) | undefined;
  onBlock: (removeExisting: boolean) => Promise<void>;
  onCancel: () => void;
}) {
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void countFromSender?.(item).then((n) => {
      if (live) setCount(n);
    });
    return () => {
      live = false;
    };
  }, [item, countFromSender]);

  const name = item.fromName?.trim() || 'this sender';
  const kept =
    count === null ? 'What is already kept from them can stay.' : count === 1 ? 'This is the one thing kept from them.' : `${count} things are kept from them.`;
  async function block(removeExisting: boolean) {
    setBusy(true);
    try {
      await onBlock(removeExisting);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="quote-card__confirm" role="group" aria-label={`Never save from ${name}`}>
      <p className="quote-card__confirm-title">Never save from {name}?</p>
      <p>Witness will not keep anything new from them. {kept}</p>
      <div className="button-row">
        <button type="button" className="btn btn--ghost btn--small" disabled={busy} onClick={() => void block(false)}>
          Stop saving, keep what is here
        </button>
        <button type="button" className="btn btn--danger btn--small" disabled={busy} onClick={() => void block(true)}>
          {count !== null && count > 1 ? `Stop saving and remove all ${count}` : 'Stop saving and remove it'}
        </button>
        <button type="button" className="btn btn--quiet btn--small" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="quote-card__confirm-note">Removed things are deleted for good. Allowing them again later does not bring them back.</p>
    </div>
  );
}

export interface QuoteCardHandlers {
  onRemove: (item: QuoteCardItem) => Promise<void>;
  /** `removeExisting`: also delete everything already kept from them. */
  onBlockSender: (item: QuoteCardItem, removeExisting: boolean) => Promise<void>;
  /** How many things are kept from this item's sender, or null when unknown. */
  countFromSender?: (item: QuoteCardItem) => Promise<number | null>;
  /** Rejects when the change did not save, so the form can stay open. */
  onEdit: (item: QuoteCardItem, patch: ItemPatch) => Promise<void>;
  onKeep?: (item: QuoteCardItem) => Promise<void>;
}

/** A saved (or maybe) item in the gallery, with its quiet menu. */
export function QuoteCard({ item, handlers, mode = 'saved' }: { item: QuoteCardItem; handlers: QuoteCardHandlers; mode?: 'saved' | 'maybe' }) {
  const [editing, setEditing] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  const actions: MenuAction[] = [];
  if (mode === 'saved') actions.push({ label: 'Remove', onSelect: () => void run(() => handlers.onRemove(item)) });
  // Core says whether it knows the sender; older responses fall back to the source type.
  if (item.canBlockSender ?? canBlockSender(item.sourceType)) {
    actions.push({ label: 'Never save from this sender', tone: 'danger', onSelect: () => setBlocking(true) });
  }
  actions.push({ label: 'Edit details', onSelect: () => setEditing(true) });

  const keep = handlers.onKeep;
  const className = ['quote-card', menuOpen && 'is-raised', busy && 'is-busy'].filter(Boolean).join(' ');

  return (
    <article className={className} aria-busy={busy || undefined}>
      <div className="quote-card__menu">
        <Menu label={`Options for ${about(item)} from ${who(item)}`} actions={actions} onOpenChange={setMenuOpen} />
      </div>
      <QuoteBody item={item} />
      {blocking && (
        <BlockConfirm
          item={item}
          countFromSender={handlers.countFromSender}
          onCancel={() => setBlocking(false)}
          onBlock={async (removeExisting) => {
            await run(() => handlers.onBlockSender(item, removeExisting));
            setBlocking(false);
          }}
        />
      )}
      {editing && (
        <EditDetails
          item={item}
          onCancel={() => setEditing(false)}
          onSave={async (patch) => {
            await handlers.onEdit(item, patch);
            setEditing(false);
          }}
        />
      )}
      {mode === 'maybe' && keep && !editing && (
        <div className="button-row quote-card__decide">
          <button
            type="button"
            className="btn btn--ghost btn--small"
            aria-label={`Keep it: ${about(item)}`}
            disabled={busy}
            onClick={() => void run(() => keep(item))}
          >
            Keep it
          </button>
          <button
            type="button"
            className="btn btn--quiet btn--small"
            aria-label={`Remove: ${about(item)}`}
            disabled={busy}
            onClick={() => void run(() => handlers.onRemove(item))}
          >
            Remove
          </button>
        </div>
      )}
    </article>
  );
}

/** The landing page sample. Clearly labelled so nobody mistakes it for real evidence. */
export function ExampleCard({ item }: { item: QuoteCardItem }) {
  return (
    <article className="quote-card quote-card--example" aria-label="Example of a saved message">
      <QuoteBody
        item={item}
        label={
          <p className="quote-card__example-label">
            <span className="tag">Example</span>
          </p>
        }
      />
    </article>
  );
}
