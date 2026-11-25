import { useEffect, useState } from 'react';
import type { Flow, FlowStats, Step } from '@guidepost/shared';
import { api } from '../api';
import { go, type Me } from '../App';
import { pct } from './FlowsPage';

export function FlowPage({ id, me }: { id: string; me: Me }) {
  const [flow, setFlow] = useState<Flow | null>(null);
  const [stats, setStats] = useState<FlowStats | null>(null);
  const [name, setName] = useState('');
  const [steps, setSteps] = useState<Step[]>([]);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const editor = me.user.role !== 'viewer';

  useEffect(() => {
    api.flow(id).then((f) => { setFlow(f); setName(f.name); setSteps(f.steps); }, (e) => setError(e.message));
    if (editor) api.analytics().then((all) => setStats(all.find((s) => s.flowId === id) ?? null), () => {});
  }, [id, editor]);

  if (error) return <div className="error">{error} <a href="#/">Back to guides</a></div>;
  if (!flow) return <div className="muted">Loading…</div>;

  const dirty = name !== flow.name || JSON.stringify(steps) !== JSON.stringify(flow.steps);

  async function save(patch: Parameters<typeof api.updateFlow>[1], msg: string) {
    setError('');
    try {
      const f = await api.updateFlow(id, patch);
      setFlow(f); setName(f.name); setSteps(f.steps);
      setSaved(msg);
      setTimeout(() => setSaved(''), 2500);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove() {
    if (!confirm(`Delete "${flow!.name}"? Its analytics are deleted too.`)) return;
    try { await api.deleteFlow(id); go('/'); } catch (e) { setError((e as Error).message); }
  }

  const edit = (i: number, p: Partial<Step>) => setSteps(steps.map((s, j) => (j === i ? { ...s, ...p } : s)));
  const move = (i: number, d: number) => {
    const next = [...steps];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setSteps(next);
  };

  const maxViews = Math.max(1, stats?.starts ?? 0, ...(stats?.stepViews ?? [0]));
  const worst = stats ? stats.exits.reduce((w, n, i) => (n > (stats.exits[w] ?? 0) ? i : w), 0) : 0;

  return (
    <>
      <a href="#/" className="back">← All guides</a>
      <div className="page-head">
        {editor ? <input className="title-input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Guide name" /> : <h1>{flow.name}</h1>}
        <span className={`badge ${flow.status}`}>{flow.status === 'published' ? 'Published' : 'Draft'}</span>
        <span className="muted">on {flow.host}</span>
        {editor && (
          <div className="actions">
            {saved && <span className="saved">{saved}</span>}
            <button onClick={() => save({ status: flow.status === 'published' ? 'draft' : 'published' }, flow.status === 'published' ? 'Unpublished' : 'Published')}>
              {flow.status === 'published' ? 'Unpublish' : 'Publish'}
            </button>
            <button className="danger" onClick={remove}>Delete</button>
          </div>
        )}
      </div>

      {editor && stats && (
        <section className="panel">
          <h2>How people move through this guide</h2>
          <p className="muted">
            {stats.starts} starts, {stats.completes} completed ({pct(stats.completes, stats.starts)}).
            {stats.exits.some((n) => n > 0) && <> Most people who quit did so at step {worst + 1}.</>}
          </p>
          <div className="funnel">
            {flow.steps.map((s, i) => (
              <div className="funnel-row" key={i}>
                <span className="funnel-label">{i + 1}. {s.title}</span>
                <span className="funnel-track"><span className="funnel-bar" style={{ width: `${(100 * (stats.stepViews[i] ?? 0)) / maxViews}%` }} /></span>
                <span className="funnel-num">{stats.stepViews[i] ?? 0} {(stats.stepViews[i] ?? 0) === 1 ? "view" : "views"}</span>
                <span className={`funnel-num ${stats.exits[i] ? 'warn' : 'muted'}`}>{stats.exits[i] ?? 0} quit</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="panel">
        <div className="section-head">
          <h2>Steps</h2>
          {editor && <button className="primary" disabled={!dirty || !steps.length} onClick={() => save({ name, steps }, 'Saved')}>Save changes</button>}
        </div>
        {error && <div className="error">{error}</div>}
        <ol className="steps">
          {steps.map((s, i) => (
            <li key={i} className="step">
              <div className="step-num">{i + 1}</div>
              <div className="step-body">
                {editor ? (
                  <>
                    <input value={s.title} onChange={(e) => edit(i, { title: e.target.value })} aria-label={`Step ${i + 1} title`} />
                    <textarea value={s.body} placeholder="Explanation shown in the tooltip" onChange={(e) => edit(i, { body: e.target.value })} aria-label={`Step ${i + 1} explanation`} />
                  </>
                ) : (
                  <><b>{s.title}</b><p>{s.body}</p></>
                )}
                <code title="Element this step points at">{s.selector}</code>
              </div>
              {editor && (
                <div className="step-tools">
                  <button className="small" disabled={i === 0} onClick={() => move(i, -1)} title="Move up">↑</button>
                  <button className="small" disabled={i === steps.length - 1} onClick={() => move(i, 1)} title="Move down">↓</button>
                  <button className="small" disabled={steps.length === 1} onClick={() => setSteps(steps.filter((_, j) => j !== i))} title="Remove step">✕</button>
                </div>
              )}
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
