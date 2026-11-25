import { useCallback, useEffect, useState } from 'react';
import type { User, Workspace } from '@guidepost/shared';
import { api, getToken, setToken } from './api';
import { AuthPage } from './pages/AuthPage';
import { FlowsPage } from './pages/FlowsPage';
import { FlowPage } from './pages/FlowPage';
import { MembersPage } from './pages/MembersPage';

export interface Me { user: User; workspace: Workspace }

function useHashRoute() {
  const [hash, setHash] = useState(() => location.hash.slice(1) || '/');
  useEffect(() => {
    const on = () => setHash(location.hash.slice(1) || '/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

export const go = (path: string) => { location.hash = path; };

export function App() {
  const route = useHashRoute();
  const [me, setMe] = useState<Me | null | undefined>(getToken() ? undefined : null);

  const signOut = useCallback(() => { setToken(null); setMe(null); go('/login'); }, []);

  useEffect(() => {
    if (getToken()) api.me().then(setMe, () => setMe(null));
    const out = () => setMe(null);
    window.addEventListener('guidepost:signedout', out);
    return () => window.removeEventListener('guidepost:signedout', out);
  }, []);

  if (me === undefined) return <div className="center muted">Loading…</div>;
  if (!me) return <AuthPage mode={route === '/signup' ? 'signup' : 'login'} onAuthed={(m) => { setMe(m); go('/'); }} />;

  const flowMatch = route.match(/^\/flows\/([\w-]+)$/);
  const page = flowMatch ? <FlowPage id={flowMatch[1]} me={me} /> : route === '/members' ? <MembersPage me={me} /> : <FlowsPage me={me} />;

  return (
    <div className="shell">
      <header className="top">
        <a className="brand" href="#/"><img src="/favicon.png" alt="" />Guidepost</a>
        <nav>
          <a href="#/" className={!route.startsWith('/members') ? 'active' : ''}>Guides</a>
          {me.user.role !== 'viewer' && <a href="#/members" className={route.startsWith('/members') ? 'active' : ''}>Team</a>}
        </nav>
        <div className="who">
          <span>{me.workspace.name}</span>
          <span className="muted">{me.user.email}</span>
          <button className="link" onClick={signOut}>Sign out</button>
        </div>
      </header>
      <main>{page}</main>
    </div>
  );
}
