import { useEffect, useState, type FormEvent } from 'react';
import type { Role, User } from '@guidepost/shared';
import { api } from '../api';
import type { Me } from '../App';

const ROLE_HELP: Record<Role, string> = {
  owner: 'Manages the team and everything else',
  editor: 'Records, edits and publishes guides, sees analytics',
  viewer: 'Plays published guides (your end users)',
};

export function MembersPage({ me }: { me: Me }) {
  const [members, setMembers] = useState<User[]>([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [error, setError] = useState('');
  const owner = me.user.role === 'owner';

  const load = () => api.members().then(setMembers, (e) => setError(e.message));
  useEffect(() => { void load(); }, []);

  async function add(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api.addMember({ email, password, role });
      setEmail(''); setPassword('');
      void load();
    } catch (err) { setError((err as Error).message); }
  }

  async function act(fn: () => Promise<unknown>) {
    setError('');
    try { await fn(); void load(); } catch (err) { setError((err as Error).message); }
  }

  return (
    <>
      <div className="page-head"><h1>Team</h1><span className="muted">People in {me.workspace.name}</span></div>
      {error && <div className="error">{error}</div>}
      <table className="grid">
        <thead><tr><th>Email</th><th>Role</th><th /></tr></thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id}>
              <td>{m.email}{m.id === me.user.id && <span className="muted"> (you)</span>}</td>
              <td>
                {owner && m.id !== me.user.id ? (
                  <select value={m.role} onChange={(e) => act(() => api.setRole(m.id, e.target.value as Role))} aria-label={`Role for ${m.email}`}>
                    <option value="owner">Owner</option><option value="editor">Editor</option><option value="viewer">Viewer</option>
                  </select>
                ) : <span className="cap">{m.role}</span>}
              </td>
              <td className="num">{owner && m.id !== me.user.id && <button className="small danger" onClick={() => confirm(`Remove ${m.email}?`) && act(() => api.removeMember(m.id))}>Remove</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {owner && (
        <form className="panel add-member" onSubmit={add}>
          <h2>Add a person</h2>
          <p className="muted">Share the email and password with them; they sign in to the extension with it.</p>
          <div className="form-row">
            <label>Email<input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <label>Temporary password<input required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
            <label>Role<select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="viewer">Viewer</option><option value="editor">Editor</option><option value="owner">Owner</option>
            </select></label>
            <button className="primary">Add</button>
          </div>
          <p className="muted small">{ROLE_HELP[role]}.</p>
        </form>
      )}
    </>
  );
}
