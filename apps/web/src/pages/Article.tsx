import type { ReactNode } from 'react';
import { Eyebrow } from '../components/Brand';
import { PublicPage } from '../components/Layout';

/** Short, plain reading pages (Safety, Privacy). */
export function Article({ eyebrow, title, lede, children }: { eyebrow: string; title: string; lede: string; children: ReactNode }) {
  return (
    <PublicPage className="container prose-page">
      <Eyebrow>{eyebrow}</Eyebrow>
      <h1 className="display-sm">{title}</h1>
      <p className="lede">{lede}</p>
      <div className="prose">{children}</div>
    </PublicPage>
  );
}
