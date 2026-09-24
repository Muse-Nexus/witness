import type { ReactNode } from 'react';
import { Link, useLocation } from '../app/router';
import { useOptionalSession } from '../app/sessionContext';
import { LINKS } from '../lib/links';
import { Wordmark } from './Brand';

function NavLink({ to, children }: { to: string; children: ReactNode }) {
  const { pathname } = useLocation();
  const current = pathname === to || (to !== '/app' && pathname.startsWith(`${to}/`));
  return (
    <Link to={to} className="nav__link" aria-current={current ? 'page' : undefined}>
      {children}
    </Link>
  );
}

function SkipLink() {
  return (
    <a className="skip-link" href="#main">
      Skip to content
    </a>
  );
}

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="container site-header__inner">
        <Wordmark />
        <nav className="nav nav--public" aria-label="Main">
          <Link to="/#how" className="nav__link nav__link--wide">
            How it works
          </Link>
          <NavLink to="/safety">Safety</NavLink>
          <NavLink to="/privacy">Privacy</NavLink>
          <a className="nav__link nav__link--wide" href={LINKS.repo} rel="noopener noreferrer">
            GitHub
          </a>
        </nav>
        <div className="site-header__actions">
          <Link to="/signin" className="nav__link">
            Sign in
          </Link>
          <Link to="/signin" className="btn btn--primary btn--small">
            Start
          </Link>
        </div>
      </div>
    </header>
  );
}

export function AppHeader() {
  // Whose Witness this is, always in view: a sign-in link from someone else can never
  // quietly put you in their account.
  const session = useOptionalSession();
  return (
    <header className="site-header site-header--app">
      <div className="container site-header__inner">
        <Wordmark to="/app" />
        <nav className="nav nav--app" aria-label="Witness">
          <NavLink to="/app">Home</NavLink>
          <NavLink to="/app/setup">Set up</NavLink>
          <NavLink to="/app/settings">Settings</NavLink>
        </nav>
        {session && (
          <p className="site-header__account">
            <span className="visually-hidden">Signed in as </span>
            {session.me.email}
          </p>
        )}
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="container">
        <div className="site-footer__top">
          <Wordmark />
          <nav className="site-footer__links" aria-label="Footer">
            <Link to="/safety">Safety</Link>
            <Link to="/privacy">Privacy</Link>
            <a href={LINKS.selfHost} rel="noopener noreferrer">
              Self-host
            </a>
            <a href={LINKS.repo} rel="noopener noreferrer">
              GitHub
            </a>
          </nav>
        </div>
        <p className="site-footer__line">
          Made by{' '}
          <a href={LINKS.studio} rel="noopener noreferrer">
            Muse Nexus
          </a>{' '}
          in Hawaiʻi · <a href={LINKS.license} rel="noopener noreferrer">Open source (MIT)</a> ·{' '}
          <span className="site-footer__crisis">
            If you're in crisis, call or text <a href="tel:988">988</a> (US) ·{' '}
            <a href={LINKS.crisisWorld} rel="noopener noreferrer">
              findahelpline.com
            </a>
          </span>
        </p>
      </div>
    </footer>
  );
}

function Main({ children, className }: { children: ReactNode; className?: string | undefined }) {
  return (
    <main id="main" tabIndex={-1} className={className}>
      {children}
    </main>
  );
}

export function PublicPage({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="page page--public">
      <SkipLink />
      <SiteHeader />
      <Main className={className}>{children}</Main>
      <Footer />
    </div>
  );
}

export function AppPage({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="page page--app">
      <SkipLink />
      <AppHeader />
      <Main className={className}>{children}</Main>
      <Footer />
    </div>
  );
}
