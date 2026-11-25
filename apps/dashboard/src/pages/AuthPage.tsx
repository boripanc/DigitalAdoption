import { useState, type FormEvent } from 'react';
import { api, setToken } from '../api';
import type { Me } from '../App';

export function AuthPage({ mode, onAuthed }: { mode: 'login' | 'signup'; onAuthed: (m: Me) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = mode === 'signup' ? await api.signup({ email, password, workspaceName }) : await api.login({ email, password });
      setToken(r.token);
      onAuthed({ user: r.user, workspace: r.workspace });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <form className="panel" onSubmit={submit}>
        <div className="brand big"><img src="/favicon.png" alt="" />Guidepost</div>
        <h1>{mode === 'signup' ? 'Create your workspace' : 'Sign in'}</h1>
        {mode === 'signup' && (
          <label>Workspace name<input required value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} placeholder="Acme Inc." /></label>
        )}
        <label>Email<input required type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>Password<input required type="password" minLength={mode === 'signup' ? 8 : undefined} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {error && <div className="error">{error}</div>}
        <button className="primary" disabled={busy}>{busy ? 'Please wait…' : mode === 'signup' ? 'Create workspace' : 'Sign in'}</button>
        <p className="muted">
          {mode === 'signup' ? <>Already have an account? <a href="#/login">Sign in</a></> : <>New here? <a href="#/signup">Create a workspace</a></>}
        </p>
      </form>
    </div>
  );
}
