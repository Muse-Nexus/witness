import { Link } from '../app/router';
import { Eyebrow } from '../components/Brand';
import { PublicPage } from '../components/Layout';
import { useTitle } from '../lib/useTitle';

export function NotFound() {
  useTitle('Not found');
  return (
    <PublicPage className="container narrow page-message">
      <Eyebrow>Not found</Eyebrow>
      <h1 className="display-sm">This page is not here.</h1>
      <p className="lede">The link may be old, or mistyped.</p>
      <div className="button-row">
        <Link to="/" className="btn btn--ghost">
          Go to the start
        </Link>
        <Link to="/app" className="btn btn--quiet">
          Open Witness
        </Link>
      </div>
    </PublicPage>
  );
}
