import { useEffect, useState } from 'react';
import type { Flow, FlowStats } from '@guidepost/shared';
import { api } from '../api';
import { go, type Me } from '../App';

export const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '–');

export function FlowsPage({ me }: { me: Me }) {
  const [flows, setFlows] = useState<Flow[] | null>(null);
  const [stats, setStats] = useState<Record<string, FlowStats>>({});
  const [error, setError] = useState('');
  const editor = me.user.role !== 'viewer';

  useEffect(() => {
    api.flows().then(setFlows, (e) => setError(e.message));
    if (editor) api.analytics().then((s) => setStats(Object.fromEntries(s.map((x) => [x.flowId, x]))), () => {});
  }, [editor]);

  if (error) return <div className="error">{error}</div>;
  if (!flows) return <div className="muted">Loading…</div>;

  const totals = Object.values(stats).reduce((t, s) => ({ starts: t.starts + s.starts, completes: t.completes + s.completes }), { starts: 0, completes: 0 });

  return (
    <>
      <div className="page-head">
        <h1>Guides</h1>
        <span className="muted">Record new guides with the Guidepost browser extension.</span>
      </div>
      {editor && flows.length > 0 && (
        <div className="tiles">
          <div className="tile"><b>{flows.length}</b><span>guides</span></div>
          <div className="tile"><b>{flows.filter((f) => f.status === 'published').length}</b><span>published</span></div>
          <div className="tile"><b>{totals.starts}</b><span>guide starts</span></div>
          <div className="tile"><b>{pct(totals.completes, totals.starts)}</b><span>completion rate</span></div>
        </div>
      )}
      {flows.length === 0 ? (
        <div className="panel empty">
          <h2>No guides yet</h2>
          <ol>
            <li>Install the Guidepost extension in Chrome and sign in with this account.</li>
            <li>Open the web app you want to guide, click the Guidepost icon, name a guide and press <b>Record</b>.</li>
            <li>Click through the steps, then press <b>Finish</b>. The guide shows up here as a draft.</li>
            <li>Publish it, and everyone in <b>{me.workspace.name}</b> can play it on that site.</li>
          </ol>
        </div>
      ) : (
        <table className="grid">
          <thead>
            <tr><th>Guide</th><th>Site</th><th>Status</th><th className="num">Steps</th>{editor && <><th className="num">Starts</th><th className="num">Completed</th></>}<th>Updated</th></tr>
          </thead>
          <tbody>
            {flows.map((f) => {
              const s = stats[f.id];
              return (
                <tr key={f.id} onClick={() => go(`/flows/${f.id}`)} className="clickable">
                  <td><a href={`#/flows/${f.id}`}>{f.name}</a></td>
                  <td className="muted">{f.host}</td>
                  <td><span className={`badge ${f.status}`}>{f.status === 'published' ? 'Published' : 'Draft'}</span></td>
                  <td className="num">{f.steps.length}</td>
                  {editor && <><td className="num">{s?.starts ?? 0}</td><td className="num">{pct(s?.completes ?? 0, s?.starts ?? 0)}</td></>}
                  <td className="muted">{new Date(f.updatedAt).toLocaleDateString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
