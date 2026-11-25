import { SignJWT, jwtVerify } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '@guidepost/shared';
import type { Db } from './db.js';

export interface AuthUser {
  id: string;
  workspaceId: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthUser;
  }
}

export function makeAuth(secret: string, db: Db) {
  const key = new TextEncoder().encode(secret);

  const sign = (u: AuthUser) =>
    new SignJWT({ wid: u.workspaceId, role: u.role })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(u.id)
      .setIssuedAt()
      .setExpirationTime('30d')
      .sign(key);

  async function authenticate(req: FastifyRequest, reply: FastifyReply) {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    try {
      const { payload } = await jwtVerify(token, key);
      // Read the role fresh from the database, so role changes and removed members apply at once.
      const [row] = await db.query<{ id: string; workspace_id: string; role: Role }>(
        'SELECT id, workspace_id, role FROM users WHERE id = $1',
        [payload.sub],
      );
      if (!row) throw new Error('user gone');
      req.auth = { id: row.id, workspaceId: row.workspace_id, role: row.role };
    } catch {
      return reply.code(401).send({ error: 'Sign in required' });
    }
  }

  const requireRole = (...roles: Role[]) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!roles.includes(req.auth.role)) return reply.code(403).send({ error: 'You do not have permission to do this' });
  };

  return { sign, authenticate, requireRole };
}
