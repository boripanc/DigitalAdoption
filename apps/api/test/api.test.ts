import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createDb, type Db } from '../src/db.js';

let app: FastifyInstance;
let db: Db;

const step = (n: number) => ({ selector: `#s${n}`, text: `Step ${n}`, tag: 'button', url: 'https://app.test/', title: `Step ${n}`, body: '' });

async function call(method: string, url: string, token?: string, payload?: unknown) {
  const res = await app.inject({ method: method as 'GET', url, payload: payload as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.statusCode, body: res.body ? res.json() : undefined };
}

async function signup(email: string, workspaceName = 'Acme') {
  const r = await call('POST', '/auth/signup', undefined, { email, password: 'password123', workspaceName });
  expect(r.status).toBe(201);
  return r.body.token as string;
}

beforeAll(async () => {
  // TEST_DATABASE_URL=postgres://... runs the same tests against a real (empty) Postgres database.
  db = await createDb(process.env.TEST_DATABASE_URL ?? 'memory://');
  app = await buildApp({ db, jwtSecret: 'test-secret-test-secret-test-secret-1234' });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe('auth', () => {
  it('signs up, logs in and returns the current user', async () => {
    await signup('Owner@Acme.test');
    const login = await call('POST', '/auth/login', undefined, { email: 'owner@acme.test', password: 'password123' });
    expect(login.status).toBe(200);
    expect(login.body.user).toMatchObject({ email: 'owner@acme.test', role: 'owner' });
    const me = await call('GET', '/me', login.body.token);
    expect(me.body.workspace.name).toBe('Acme');
  });

  it('rejects a wrong password, a duplicate email and a missing token', async () => {
    expect((await call('POST', '/auth/login', undefined, { email: 'owner@acme.test', password: 'nope-nope' })).status).toBe(401);
    expect((await call('POST', '/auth/signup', undefined, { email: 'owner@acme.test', password: 'password123', workspaceName: 'X' })).status).toBe(409);
    expect((await call('GET', '/flows')).status).toBe(401);
    expect((await call('POST', '/auth/signup', undefined, { email: 'bad', password: 'short', workspaceName: '' })).status).toBe(400);
  });
});

describe('flows, roles and analytics', () => {
  let owner: string, viewer: string, viewerId: string, flowId: string;

  beforeAll(async () => {
    owner = await signup('boss@globex.test', 'Globex');
    const m = await call('POST', '/members', owner, { email: 'staff@globex.test', password: 'password123', role: 'viewer' });
    expect(m.status).toBe(201);
    viewerId = m.body.id;
    viewer = (await call('POST', '/auth/login', undefined, { email: 'staff@globex.test', password: 'password123' })).body.token;
  });

  it('lets an owner create a draft flow that viewers cannot see', async () => {
    const r = await call('POST', '/flows', owner, { name: 'Create invoice', host: 'app.test', steps: [step(1), step(2), step(3)] });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('draft');
    flowId = r.body.id;
    expect((await call('GET', '/flows?host=app.test', viewer)).body).toHaveLength(0);
    expect((await call('GET', `/flows/${flowId}`, viewer)).status).toBe(404);
    expect((await call('POST', '/flows', viewer, { name: 'x', host: 'app.test', steps: [step(1)] })).status).toBe(403);
  });

  it('shows published flows to viewers, filtered by host', async () => {
    const r = await call('PATCH', `/flows/${flowId}`, owner, { status: 'published' });
    expect(r.body.status).toBe('published');
    expect((await call('GET', '/flows?host=app.test', viewer)).body).toHaveLength(1);
    expect((await call('GET', '/flows?host=other.test', viewer)).body).toHaveLength(0);
  });

  it('keeps the iframe path and UI5 control info of SAP Fiori steps', async () => {
    const fiori = {
      ...step(1),
      frames: ['#application-PurchaseOrder-manage'],
      ui5: { type: 'sap.m.Input', id: 'detail--note', view: 'po.view.Detail', label: 'Approval note', bindings: { value: 'note' }, context: '/orders/1' },
    };
    const r = await call('POST', '/flows', owner, { name: 'Fiori', host: 'fiori.test', steps: [fiori] });
    expect(r.status).toBe(201);
    expect((await call('GET', `/flows/${r.body.id}`, owner)).body.steps[0]).toMatchObject({ frames: fiori.frames, ui5: fiori.ui5 });
    await call('DELETE', `/flows/${r.body.id}`, owner);
  });

  it('keeps workspaces apart', async () => {
    const other = await signup('someone@initech.test', 'Initech');
    expect((await call('GET', '/flows', other)).body).toHaveLength(0);
    expect((await call('GET', `/flows/${flowId}`, other)).status).toBe(404);
    expect((await call('PATCH', `/flows/${flowId}`, other, { name: 'hacked' })).status).toBe(404);
    const ev = await call('POST', '/events', other, { events: [{ flowId, type: 'start', sessionId: 's' }] });
    expect(ev.body.accepted).toBe(0);
  });

  it('records events and reports starts, completions and drop-off', async () => {
    const events = [
      { flowId, type: 'start', sessionId: 'a' },
      { flowId, type: 'step_view', stepIndex: 0, sessionId: 'a' },
      { flowId, type: 'step_view', stepIndex: 1, sessionId: 'a' },
      { flowId, type: 'step_view', stepIndex: 2, sessionId: 'a' },
      { flowId, type: 'complete', sessionId: 'a' },
      { flowId, type: 'start', sessionId: 'b' },
      { flowId, type: 'step_view', stepIndex: 0, sessionId: 'b' },
      { flowId, type: 'step_view', stepIndex: 1, sessionId: 'b' },
      { flowId, type: 'exit', stepIndex: 1, sessionId: 'b' },
    ];
    expect((await call('POST', '/events', viewer, { events })).body.accepted).toBe(9);
    expect((await call('GET', '/analytics', viewer)).status).toBe(403);
    const stats = (await call('GET', '/analytics', owner)).body;
    expect(stats).toEqual([{ flowId, starts: 2, completes: 1, stepViews: [2, 2, 1], exits: [0, 1, 0] }]);
  });

  it('applies role changes immediately and lets owners remove members', async () => {
    expect((await call('PATCH', `/members/${viewerId}`, owner, { role: 'editor' })).body.role).toBe('editor');
    expect((await call('GET', '/analytics', viewer)).status).toBe(200);
    expect((await call('DELETE', `/members/${viewerId}`, owner)).status).toBe(204);
    expect((await call('GET', '/flows', viewer)).status).toBe(401);
  });

  it('deletes a flow and its events', async () => {
    expect((await call('DELETE', `/flows/${flowId}`, owner)).status).toBe(204);
    expect((await call('GET', '/analytics', owner)).body).toEqual([]);
  });
});
