import { useState } from 'react';
import { useApi } from '../api/context';
import { Link } from '../app/router';
import { Eyebrow } from '../components/Brand';
import { AppPage } from '../components/Layout';
import { useResource } from '../lib/useResource';
import { useTitle } from '../lib/useTitle';
import { Gallery, appendPage, useItemHandlers } from './Home';

const PAGE_SIZE = 60;

export function Maybe() {
  useTitle('Maybe');
  const api = useApi();
  const items = useResource(() => api.listItems({ status: 'maybe', limit: PAGE_SIZE }));
  const [announcement, setAnnouncement] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const handlers = useItemHandlers(items.set, setAnnouncement, () => undefined);

  async function loadMore() {
    const cursor = items.data?.nextCursor;
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const next = await api.listItems({ status: 'maybe', limit: PAGE_SIZE, cursor });
      items.set((page) => appendPage(page, next));
    } catch {
      setAnnouncement('More did not load. Try again in a moment.');
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <AppPage className="container maybe">
      <Link to="/app" className="back-link">
        <span aria-hidden="true">←</span> Home
      </Link>
      <Eyebrow>Maybe</Eyebrow>
      <h1 className="display-sm">Things Witness was not sure about.</h1>
      <p className="lede">
        You never need to look here, and nothing here is emailed to you. If you want something in your Witness emails,
        keep it. If not, remove it, or leave it be.
      </p>
      <p className="form-status" role="status">
        {announcement}
      </p>
      {items.data && items.data.items.length > 0 && <Gallery items={items.data.items} handlers={handlers} mode="maybe" />}
      {items.data && items.data.items.length === 0 && !items.data.nextCursor && (
        <div className="empty">
          <p className="empty__title">Nothing here right now.</p>
        </div>
      )}
      {items.data?.nextCursor && (
        <div className="gallery-more">
          <button type="button" className="btn btn--ghost" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Show more'}
          </button>
        </div>
      )}
      {items.error != null && !items.data && (
        <div className="empty">
          <p className="empty__title">These did not load.</p>
          <button type="button" className="btn btn--ghost btn--small" onClick={() => void items.reload()}>
            Try again
          </button>
        </div>
      )}
    </AppPage>
  );
}
