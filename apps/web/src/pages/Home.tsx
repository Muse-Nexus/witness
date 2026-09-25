import { useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useApi } from '../api/context';
import type { Item, ItemPage, ItemPatch } from '../api/types';
import { Link } from '../app/router';
import { useSession } from '../app/session';
import { AddSomething } from '../components/AddSomething';
import { Eyebrow } from '../components/Brand';
import { AppPage } from '../components/Layout';
import { QuoteCard, type QuoteCardHandlers } from '../components/QuoteCard';
import { SOURCE_LABELS } from '../lib/categories';
import { formatWeekdayDate, relativeAgo, statusSentence } from '../lib/format';
import { useResource } from '../lib/useResource';
import { useTitle } from '../lib/useTitle';

const PAGE_SIZE = 30;

/**
 * Core reads a bounded number of things per search request (2,000), so a page can come back
 * empty with more still to read. A search keeps reading up to this many requests before it
 * says what it has, and offers to look further back.
 */
const SEARCH_REQUESTS = 10;

/** Newest first, the way core sorts (by when it happened, or when it was kept). */
const sortKey = (item: Item) => item.occurredAt ?? item.createdAt;

/** Adds a page to what is shown, never showing the same item twice. */
export function appendPage(page: ItemPage | undefined, next: ItemPage): ItemPage {
  const seen = new Set((page?.items ?? []).map((i) => i.id));
  return { items: [...(page?.items ?? []), ...next.items.filter((i) => !seen.has(i.id))], nextCursor: next.nextCursor };
}

/**
 * Puts a new item where it belongs. One older than the last item loaded is left for
 * "Show more" to bring, so it never appears twice.
 */
export function insertSorted(page: ItemPage | undefined, item: Item): ItemPage {
  const items = (page?.items ?? []).filter((i) => i.id !== item.id);
  const last = items.at(-1);
  if (page?.nextCursor && last && sortKey(item) < sortKey(last)) return { items, nextCursor: page.nextCursor };
  const at = items.findIndex((i) => sortKey(i) < sortKey(item));
  return { items: at < 0 ? [...items, item] : [...items.slice(0, at), item, ...items.slice(at)], nextCursor: page?.nextCursor ?? null };
}

/** "3 days ago" should never break between the 3 and "days" in a large headline. */
function keepNumbersWithUnits(text: string): string {
  return text.replace(/(\d) (?=\S)/g, '$1\u00a0');
}

/** Shared by Home and Maybe: the card actions, applied to a page of items held locally. */
export function useItemHandlers(
  set: (update: (current: ItemPage | undefined) => ItemPage) => void,
  announce: (message: string) => void,
  afterChange: () => void,
): QuoteCardHandlers {
  const api = useApi();
  const without = (id: string) => (page: ItemPage | undefined): ItemPage => ({
    items: (page?.items ?? []).filter((i) => i.id !== id),
    nextCursor: page?.nextCursor ?? null,
  });

  return {
    async onRemove(item) {
      try {
        await api.deleteItem(item.id);
        set(without(item.id));
        // Removal is one tap and permanent (SAFETY §6), so say so where it can be seen.
        announce('Removed for good.');
        afterChange();
      } catch {
        announce('That was not removed. Try again in a moment.');
      }
    },
    async onBlockSender(item, removeExisting) {
      try {
        const result = await api.blockSender(item.id, { removeExisting });
        if (removeExisting) {
          // Core removes everything already kept from that sender, not just this card.
          const gone = new Set([item.id, ...(result.removedIds ?? [])]);
          set((page) => ({ items: (page?.items ?? []).filter((i) => !gone.has(i.id)), nextCursor: page?.nextCursor ?? null }));
          const n = result.removed ?? gone.size;
          announce(`Removed ${n === 1 ? 'it' : `${n} things`}. Witness will not save anything new from this sender.`);
        } else {
          announce('Witness will not save anything new from this sender. What is here stays.');
        }
        afterChange();
      } catch {
        announce('That did not go through. Try again in a moment.');
      }
    },
    async countFromSender(item) {
      try {
        return (await api.senderCount(item.id)).count;
      } catch {
        return null;
      }
    },
    async onEdit(item, patch: ItemPatch) {
      try {
        const updated = await api.updateItem(item.id, patch);
        set((page) => ({
          items: (page?.items ?? []).map((i) => (i.id === item.id ? { ...i, ...updated } : i)),
          nextCursor: page?.nextCursor ?? null,
        }));
        announce('Saved.');
      } catch (error) {
        announce('That did not save. Try again in a moment.');
        throw error;
      }
    },
    async onKeep(item) {
      try {
        await api.updateItem(item.id, { status: 'saved' });
        set(without(item.id));
        announce('Kept.');
        afterChange();
      } catch {
        announce('That did not go through. Try again in a moment.');
      }
    },
  };
}

export function Gallery({ items, handlers, mode }: { items: Item[]; handlers: QuoteCardHandlers; mode: 'saved' | 'maybe' }) {
  return (
    <ul className="gallery" aria-label={mode === 'saved' ? 'Kept' : 'Maybe'}>
      {items.map((item) => (
        <li key={item.id} className="gallery__item">
          <QuoteCard item={item} handlers={handlers} mode={mode} />
        </li>
      ))}
    </ul>
  );
}

export function Home() {
  useTitle('Home');
  const api = useApi();
  const { me } = useSession();
  const status = useResource(() => api.status());
  const items = useResource(() => api.listItems({ status: 'saved', limit: PAGE_SIZE }));
  const [announcement, setAnnouncement] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const now = useMemo(() => Date.now(), []);

  const handlers = useItemHandlers(items.set, setAnnouncement, () => void status.reload());

  // Finding one thing again, by a few words or a name. No counts, and a miss is about
  // the search, never about the person.
  const findId = useId();
  const findInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ q: string; page: ItemPage } | null>(null);
  const [finding, setFinding] = useState(false);
  // What a search showed, for screen readers only: the results and the empty note are on screen already.
  const [searchNote, setSearchNote] = useState('');
  // Only the newest search may show what it found: a later search or "Show everything" wins.
  const searchRun = useRef(0);
  const foundHandlers = useItemHandlers(
    (update) => {
      setFound((current) => (current ? { ...current, page: update(current.page) } : current));
      // The same card may be in the full list too, so a change shows there as well.
      if (items.data) items.set(update);
    },
    setAnnouncement,
    () => void status.reload(),
  );

  /** One page of matches, reading on past pages that had none (see SEARCH_REQUESTS). */
  async function search(q: string, cursor?: string): Promise<ItemPage> {
    let page = await api.listItems({ status: 'saved', q, limit: PAGE_SIZE, cursor });
    for (let i = 1; i < SEARCH_REQUESTS && page.items.length === 0 && page.nextCursor; i += 1) {
      page = await api.listItems({ status: 'saved', q, limit: PAGE_SIZE, cursor: page.nextCursor });
    }
    return page;
  }

  async function find(event: FormEvent) {
    event.preventDefault();
    const q = query.trim();
    const run = ++searchRun.current;
    if (!q) {
      setFound(null);
      setFinding(false);
      return;
    }
    setFinding(true);
    try {
      const page = await search(q);
      if (run !== searchRun.current) return;
      setFound({ q, page });
      setSearchNote(
        page.items.length > 0
          ? `Showing what matches “${q}”.`
          : page.nextCursor
            ? `No match yet for “${q}”. There is more to look through.`
            : `No match for “${q}”. Try a name, or other words.`,
      );
    } catch {
      if (run === searchRun.current) setAnnouncement('That search did not finish. Try again in a moment.');
    } finally {
      if (run === searchRun.current) setFinding(false);
    }
  }

  async function findMore() {
    const cursor = found?.page.nextCursor;
    if (!found || !cursor) return;
    const { q } = found;
    const run = searchRun.current;
    setLoadingMore(true);
    try {
      const next = await search(q, cursor);
      if (run === searchRun.current) {
        setFound((current) => (current?.q === q ? { q, page: appendPage(current.page, next) } : current));
        // Say what the longer look found, so the announcement never stays on a stale "no match".
        const anyMatch = found.page.items.length > 0 || next.items.length > 0;
        setSearchNote(
          anyMatch
            ? `Showing what matches “${q}”.`
            : next.nextCursor
              ? `No match yet for “${q}”. There is more to look through.`
              : `No match for “${q}”. Try a name, or other words.`,
        );
      }
    } catch {
      if (run === searchRun.current) setAnnouncement('More did not load. Try again in a moment.');
    } finally {
      setLoadingMore(false);
    }
  }

  function showEverything() {
    searchRun.current += 1;
    setFound(null);
    setFinding(false);
    setQuery('');
    setSearchNote('Showing everything you kept.');
    // The button goes away with the results, so keep focus in the search box.
    findInput.current?.focus();
  }
  const sentence = status.data ? statusSentence(status.data, now) : null;
  const sources = (status.data?.sources ?? []).filter((s) => s.lastAt != null);
  const maybeCount = status.data?.maybe ?? 0;

  async function loadMore() {
    const cursor = items.data?.nextCursor;
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const next = await api.listItems({ status: 'saved', limit: PAGE_SIZE, cursor });
      items.set((page) => appendPage(page, next));
    } catch {
      setAnnouncement('More did not load. Try again in a moment.');
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <AppPage className="home">
      <section className="container home__status" aria-labelledby="home-title">
        <h1 id="home-title" className="visually-hidden">
          Home
        </h1>
        <Eyebrow>{formatWeekdayDate(now)}</Eyebrow>
        {sentence ? (
          <p className="status-line">
            <span className="status-line__lead">{sentence.lead}</span> {keepNumbersWithUnits(sentence.rest.join(' '))}
          </p>
        ) : (
          <p className="status-line status-line--loading" aria-hidden="true">
            {' '}
          </p>
        )}
        <ul className="source-list" aria-label="Sources">
          {sources.map((s) => (
            <li key={s.type} className="source-list__item">
              <span className="source-list__dot" aria-hidden="true" />
              {SOURCE_LABELS[s.type]}
              <span className="source-list__when">{relativeAgo(s.lastAt as number, now)}</span>
            </li>
          ))}
          <li className="source-list__item source-list__item--link">
            <Link to="/app/setup">{sources.length ? 'Connect another' : 'Connect email or texts'}</Link>
          </li>
          {status.data && !status.data.rhythm.enabled && (
            <li className="source-list__item source-list__item--link">
              <Link to="/app/setup?step=rhythm">Choose when Witness emails you</Link>
            </li>
          )}
        </ul>
      </section>

      <section className="container home__add">
        <AddSomething
          onAdded={(item) => {
            items.set((page) => insertSorted(page, item));
            void status.reload();
          }}
        />
      </section>

      <section className="container home__gallery" aria-labelledby="kept-title">
        <div className="gallery-head">
          <h2 id="kept-title" className="eyebrow">
            Kept
          </h2>
          {/* A quiet link with no number (SAFETY §6): Maybe is never a to-do list. */}
          {maybeCount > 0 && (
            <Link to="/app/maybe" className="quiet-link">
              Maybe: things Witness was not sure about
            </Link>
          )}
        </div>
        <p className="form-status" role="status">
          {announcement}
        </p>
        <p className="visually-hidden" role="status">
          {searchNote}
        </p>

        {((items.data?.items.length ?? 0) > 0 || found) && (
          <form className="inline-form inline-form--row home__find" role="search" onSubmit={(e) => void find(e)}>
            <div className="field">
              <label htmlFor={`${findId}-q`}>Find something you kept</label>
              <input
                ref={findInput}
                id={`${findId}-q`}
                type="search"
                value={query}
                maxLength={200}
                placeholder="A name, or a few words"
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <button type="submit" className="btn btn--ghost" disabled={finding}>
              {finding ? 'Finding…' : 'Find'}
            </button>
            {found && (
              <button type="button" className="btn btn--quiet" onClick={showEverything}>
                Show everything
              </button>
            )}
          </form>
        )}

        {found &&
          (found.page.items.length > 0 ? (
            <Gallery items={found.page.items} handlers={foundHandlers} mode="saved" />
          ) : found.page.nextCursor ? (
            <div className="empty">
              <p className="empty__title">No match yet for “{found.q}”.</p>
              <p>There is more to look through.</p>
            </div>
          ) : (
            <div className="empty">
              <p className="empty__title">No match for “{found.q}”.</p>
              <p>Try a name, or other words.</p>
            </div>
          ))}

        {found?.page.nextCursor && (
          <div className="gallery-more">
            <button type="button" className="btn btn--ghost" onClick={() => void findMore()} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : found.page.items.length > 0 ? 'Show more' : 'Look further back'}
            </button>
          </div>
        )}

        {!found && items.data && items.data.items.length > 0 && <Gallery items={items.data.items} handlers={handlers} mode="saved" />}

        {!found && items.data && items.data.items.length === 0 && (
          <div className="empty">
            <p className="empty__title">When something kind arrives, it will be kept here.</p>
            <p>
              You can add something above, or <Link to="/app/setup">connect email and texts</Link> so it happens on its
              own. Kind emails you forward to {me.inboundAddress} are kept here too.
            </p>
          </div>
        )}

        {items.error != null && !items.data && (
          <div className="empty">
            <p className="empty__title">Your things did not load.</p>
            <p>They are safe. Try again in a moment.</p>
            <button type="button" className="btn btn--ghost btn--small" onClick={() => void items.reload()}>
              Try again
            </button>
          </div>
        )}

        {!found && items.data?.nextCursor && (
          <div className="gallery-more">
            <button type="button" className="btn btn--ghost" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : 'Show more'}
            </button>
          </div>
        )}
      </section>
    </AppPage>
  );
}
