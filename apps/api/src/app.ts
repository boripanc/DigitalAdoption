import Fastify from 'fastify';
import cors from '@fastify/cors';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import type { Flow, FlowStats, Role, User } from '@guidepost/shared';
import type { Db } from './db.js';
import { makeAuth } from './auth.js';

export interface AppOptions {
  db: Db;
  jwtSecret: string;
  /** Origins allowed to call the API from a browser (the dashboard). Extensions call from their background worker. */
  corsOrigins?: string[] | true;
  logger?: boolean;
}

// ---------- request schemas ----------
const email = z.email().transform((e) => e.toLowerCase());
const password = z.string().min(8, 'Password must be at least 8 characters');
const role = z.enum(['owner', 'editor', 'viewer']);
const stepSchema = z.object({
  selector: z.string().min(1).max(2000),
  text: z.string().max(200).default(''),
  tag: z.string().max(40).default(''),
  url: z.string().max(2000).default(''),
  title: z.string().min(1).max(200),
  body: z.string().max(5000).default(''),
  frames: z.array(z.string().max(2000)).max(10).optional(),
  frameOrigin: z.string().max(300).regex(/^https?:\/\/[^/]+$/).optional(),
  ui5: z
    .object({
      type: z.string().max(200),
      id: z.string().max(500).optional(),
      view: z.string().max(500).optional(),
      text: z.string().max(200).optional(),
      icon: z.string().max(500).optional(),
      tooltip: z.string().max(200).optional(),
      label: z.string().max(200).optional(),
      bindings: z.record(z.string().max(50), z.string().max(500)).optional(),
      context: z.string().max(500).optional(),
    })
    .optional(),
});
const flowCreate = z.object({
  name: z.string().min(1).max(200),
  host: z.string().min(1).max(255),
  status: z.enum(['draft', 'published']).default('draft'),
  steps: z.array(stepSchema).min(1).max(100),
});
const flowPatch = flowCreate.partial();
const eventsBody = z.object({
  events: z
    .array(
      z.object({
        flowId: z.uuid(),
        type: z.enum(['start', 'step_view', 'complete', 'exit']),
        stepIndex: z.number().int().min(0).max(1000).optional(),
        sessionId: z.string().min(1).max(100),
      }),
    )
    .min(1)
    .max(200),
});

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}

interface FlowRow {
  id: string;
  workspace_id: string;
  name: string;
  host: string;
  status: Flow['status'];
  steps: Flow['steps'];
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}
const toFlow = (r: FlowRow): Flow => ({
  id: r.id,
  workspaceId: r.workspace_id,
  name: r.name,
  host: r.host,
  status: r.status,
  steps: r.steps,
  createdBy: r.created_by,
  createdAt: new Date(r.created_at).toISOString(),
  updatedAt: new Date(r.updated_at).toISOString(),
});

interface UserRow { id: string; email: string; role: Role; workspace_id: string; password_hash?: string }
const toUser = (r: UserRow): User => ({ id: r.id, email: r.email, role: r.role, workspaceId: r.workspace_id });

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export async function buildApp(opts: AppOptions) {
  const { db } = opts;
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(cors, { origin: opts.corsOrigins ?? true, methods: ['GET', 'POST', 'PATCH', 'DELETE'] });
  const { sign, authenticate, requireRole } = makeAuth(opts.jwtSecret, db);
  const editors = requireRole('owner', 'editor');
  const owners = requireRole('owner');

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    const code = (err as { statusCode?: number }).statusCode;
    if (code && code < 500) return reply.code(code).send({ error: (err as Error).message });
    app.log.error(err);
    return reply.code(500).send({ error: 'Something went wrong' });
  });

  async function loadFlow(id: string, workspaceId: string) {
    if (!isUuid(id)) throw new HttpError(404, 'Flow not found');
    const [row] = await db.query<FlowRow>('SELECT * FROM flows WHERE id = $1 AND workspace_id = $2', [id, workspaceId]);
    if (!row) throw new HttpError(404, 'Flow not found');
    return row;
  }

  async function workspaceOf(id: string) {
    const [w] = await db.query<{ id: string; name: string }>('SELECT id, name FROM workspaces WHERE id = $1', [id]);
    return w;
  }

  app.get('/health', async () => ({ ok: true }));

  // ---------- auth ----------
  app.post('/auth/signup', async (req, reply) => {
    const body = parse(z.object({ email, password, workspaceName: z.string().min(1).max(100) }), req.body);
    const [exists] = await db.query('SELECT 1 FROM users WHERE email = $1', [body.email]);
    if (exists) throw new HttpError(409, 'An account with this email already exists');
    const [ws] = await db.query<{ id: string; name: string }>('INSERT INTO workspaces (name) VALUES ($1) RETURNING id, name', [body.workspaceName]);
    const hash = await bcrypt.hash(body.password, 10);
    const [u] = await db.query<UserRow>(
      "INSERT INTO users (workspace_id, email, password_hash, role) VALUES ($1, $2, $3, 'owner') RETURNING id, email, role, workspace_id",
      [ws.id, body.email, hash],
    );
    const user = toUser(u);
    return reply.code(201).send({ token: await sign(user), user, workspace: ws });
  });

  app.post('/auth/login', async (req) => {
    const body = parse(z.object({ email, password: z.string() }), req.body);
    const [u] = await db.query<UserRow>('SELECT id, email, role, workspace_id, password_hash FROM users WHERE email = $1', [body.email]);
    if (!u || !(await bcrypt.compare(body.password, u.password_hash!))) throw new HttpError(401, 'Wrong email or password');
    const user = toUser(u);
    return { token: await sign(user), user, workspace: await workspaceOf(user.workspaceId) };
  });

  // Everything below needs a signed-in user.
  app.register(async (priv) => {
    priv.addHook('preHandler', authenticate);

    priv.get('/me', async (req) => {
      const [u] = await db.query<UserRow>('SELECT id, email, role, workspace_id FROM users WHERE id = $1', [req.auth.id]);
      return { user: toUser(u), workspace: await workspaceOf(req.auth.workspaceId) };
    });

    // ---------- members ----------
    priv.get('/members', { preHandler: editors }, async (req) => {
      const rows = await db.query<UserRow>('SELECT id, email, role, workspace_id FROM users WHERE workspace_id = $1 ORDER BY created_at', [req.auth.workspaceId]);
      return rows.map(toUser);
    });

    priv.post('/members', { preHandler: owners }, async (req, reply) => {
      const body = parse(z.object({ email, password, role }), req.body);
      const [exists] = await db.query('SELECT 1 FROM users WHERE email = $1', [body.email]);
      if (exists) throw new HttpError(409, 'An account with this email already exists');
      const [u] = await db.query<UserRow>(
        'INSERT INTO users (workspace_id, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, email, role, workspace_id',
        [req.auth.workspaceId, body.email, await bcrypt.hash(body.password, 10), body.role],
      );
      return reply.code(201).send(toUser(u));
    });

    priv.patch<{ Params: { id: string } }>('/members/:id', { preHandler: owners }, async (req) => {
      const body = parse(z.object({ role }), req.body);
      if (req.params.id === req.auth.id) throw new HttpError(400, 'You cannot change your own role');
      if (!isUuid(req.params.id)) throw new HttpError(404, 'Member not found');
      const [u] = await db.query<UserRow>(
        'UPDATE users SET role = $1 WHERE id = $2 AND workspace_id = $3 RETURNING id, email, role, workspace_id',
        [body.role, req.params.id, req.auth.workspaceId],
      );
      if (!u) throw new HttpError(404, 'Member not found');
      return toUser(u);
    });

    priv.delete<{ Params: { id: string } }>('/members/:id', { preHandler: owners }, async (req, reply) => {
      if (req.params.id === req.auth.id) throw new HttpError(400, 'You cannot remove yourself');
      if (!isUuid(req.params.id)) throw new HttpError(404, 'Member not found');
      const rows = await db.query('DELETE FROM users WHERE id = $1 AND workspace_id = $2 RETURNING id', [req.params.id, req.auth.workspaceId]);
      if (!rows.length) throw new HttpError(404, 'Member not found');
      return reply.code(204).send();
    });

    // ---------- flows ----------
    priv.get<{ Querystring: { host?: string } }>('/flows', async (req) => {
      const params: unknown[] = [req.auth.workspaceId];
      let sql = 'SELECT * FROM flows WHERE workspace_id = $1';
      if (req.query.host) { params.push(req.query.host); sql += ` AND host = $${params.length}`; }
      // Viewers (end users) only ever see published flows.
      if (req.auth.role === 'viewer') sql += " AND status = 'published'";
      sql += ' ORDER BY updated_at DESC';
      return (await db.query<FlowRow>(sql, params)).map(toFlow);
    });

    priv.get<{ Params: { id: string } }>('/flows/:id', async (req) => {
      const row = await loadFlow(req.params.id, req.auth.workspaceId);
      if (req.auth.role === 'viewer' && row.status !== 'published') throw new HttpError(404, 'Flow not found');
      return toFlow(row);
    });

    priv.post('/flows', { preHandler: editors }, async (req, reply) => {
      const body = parse(flowCreate, req.body);
      const [row] = await db.query<FlowRow>(
        'INSERT INTO flows (workspace_id, name, host, status, steps, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        [req.auth.workspaceId, body.name, body.host, body.status, JSON.stringify(body.steps), req.auth.id],
      );
      return reply.code(201).send(toFlow(row));
    });

    priv.patch<{ Params: { id: string } }>('/flows/:id', { preHandler: editors }, async (req) => {
      const body = parse(flowPatch, req.body);
      const cur = await loadFlow(req.params.id, req.auth.workspaceId);
      const [row] = await db.query<FlowRow>(
        'UPDATE flows SET name = $1, host = $2, status = $3, steps = $4, updated_at = now() WHERE id = $5 RETURNING *',
        [body.name ?? cur.name, body.host ?? cur.host, body.status ?? cur.status, JSON.stringify(body.steps ?? cur.steps), cur.id],
      );
      return toFlow(row);
    });

    priv.delete<{ Params: { id: string } }>('/flows/:id', { preHandler: editors }, async (req, reply) => {
      const cur = await loadFlow(req.params.id, req.auth.workspaceId);
      await db.query('DELETE FROM flows WHERE id = $1', [cur.id]);
      return reply.code(204).send();
    });

    // ---------- analytics ----------
    priv.post('/events', async (req, reply) => {
      const { events } = parse(eventsBody, req.body);
      const ids = [...new Set(events.map((e) => e.flowId))];
      const owned = await db.query<{ id: string }>('SELECT id FROM flows WHERE workspace_id = $1 AND id = ANY($2::uuid[])', [req.auth.workspaceId, ids]);
      const ok = new Set(owned.map((r) => r.id));
      const keep = events.filter((e) => ok.has(e.flowId));
      for (const e of keep) {
        await db.query(
          'INSERT INTO events (workspace_id, flow_id, user_id, type, step_index, session_id) VALUES ($1, $2, $3, $4, $5, $6)',
          [req.auth.workspaceId, e.flowId, req.auth.id, e.type, e.stepIndex ?? null, e.sessionId],
        );
      }
      return reply.code(202).send({ accepted: keep.length });
    });

    priv.get('/analytics', { preHandler: editors }, async (req) => {
      const flows = await db.query<{ id: string; steps: unknown[] }>('SELECT id, steps FROM flows WHERE workspace_id = $1', [req.auth.workspaceId]);
      const counts = await db.query<{ flow_id: string; type: string; step_index: number | null; n: string | number }>(
        `SELECT flow_id, type, step_index, count(*) AS n FROM events WHERE workspace_id = $1 GROUP BY flow_id, type, step_index`,
        [req.auth.workspaceId],
      );
      const stats = new Map<string, FlowStats>(
        flows.map((f) => [f.id, { flowId: f.id, starts: 0, completes: 0, stepViews: f.steps.map(() => 0), exits: f.steps.map(() => 0) }]),
      );
      for (const c of counts) {
        const s = stats.get(c.flow_id);
        if (!s) continue;
        const n = Number(c.n);
        if (c.type === 'start') s.starts += n;
        else if (c.type === 'complete') s.completes += n;
        else if (c.step_index !== null && c.step_index < s.stepViews.length) {
          if (c.type === 'step_view') s.stepViews[c.step_index] += n;
          if (c.type === 'exit') s.exits[c.step_index] += n;
        }
      }
      return [...stats.values()];
    });
  });

  return app;
}
