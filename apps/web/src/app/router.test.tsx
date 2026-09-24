import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Link, Routes, matchPath, navigate, useLocation, type Route } from './router';

describe('matchPath', () => {
  it('matches static paths, ignoring a trailing slash', () => {
    expect(matchPath('/app/settings', '/app/settings')).toEqual({});
    expect(matchPath('/app/settings', '/app/settings/')).toEqual({});
    expect(matchPath('/', '/')).toEqual({});
  });

  it('extracts and decodes params', () => {
    expect(matchPath('/items/:id', '/items/a%20b')).toEqual({ id: 'a b' });
  });

  it('rejects different lengths and segments', () => {
    expect(matchPath('/app', '/app/setup')).toBeNull();
    expect(matchPath('/app/setup', '/app/settings')).toBeNull();
    expect(matchPath('/items/:id', '/items/')).toBeNull();
  });
});

function Where() {
  const { pathname, search } = useLocation();
  return <p data-testid="where">{pathname + search}</p>;
}

const routes: Route[] = [
  {
    path: '/',
    render: () => (
      <main id="main" tabIndex={-1}>
        <h1>Start</h1>
        <Link to="/about?x=1">About</Link>
      </main>
    ),
  },
  { path: '/about', render: () => <h1>About page</h1> },
  { path: '/items/:id', render: (p) => <h1>Item {p.id}</h1> },
];

function renderRoutes(path: string) {
  window.history.replaceState(null, '', path);
  return render(
    <>
      <Routes routes={routes} fallback={<h1>Not found</h1>} />
      <Where />
    </>,
  );
}

describe('Routes and Link', () => {
  it('renders the matching route, or the fallback', () => {
    renderRoutes('/items/42');
    expect(screen.getByRole('heading', { name: 'Item 42' })).toBeInTheDocument();
  });

  it('renders the fallback for unknown paths', () => {
    renderRoutes('/nowhere');
    expect(screen.getByRole('heading', { name: 'Not found' })).toBeInTheDocument();
  });

  it('navigates client-side on a plain click, keeping the query string', () => {
    renderRoutes('/');
    const before = window.history.length;
    fireEvent.click(screen.getByRole('link', { name: 'About' }));
    expect(screen.getByRole('heading', { name: 'About page' })).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/about?x=1');
    expect(window.history.length).toBe(before + 1);
  });

  it('leaves modified clicks to the browser', () => {
    renderRoutes('/');
    const link = screen.getByRole('link', { name: 'About' });
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(screen.getByRole('heading', { name: 'Start' })).toBeInTheDocument();
  });

  it('responds to navigate() and to back/forward', () => {
    renderRoutes('/');
    act(() => navigate('/items/7', { replace: true, state: { from: 'test' } }));
    expect(screen.getByRole('heading', { name: 'Item 7' })).toBeInTheDocument();
    expect(window.history.state).toEqual({ from: 'test' });

    act(() => {
      window.history.pushState(null, '', '/about');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(screen.getByRole('heading', { name: 'About page' })).toBeInTheDocument();
  });

  it('treats a change of query string alone as a page change: back to the top, focus on main', () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    window.history.replaceState(null, '', '/?step=email');
    render(
      <Routes
        routes={[{ path: '/', render: () => <main id="main" tabIndex={-1}><Link to="/?step=texts">Next</Link></main> }]}
        fallback={<h1>Not found</h1>}
      />,
    );
    fireEvent.click(screen.getByRole('link', { name: 'Next' }));
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    expect(document.activeElement?.id).toBe('main');
    scrollTo.mockRestore();
  });
});
