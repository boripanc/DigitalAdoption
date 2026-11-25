import { buildApp } from './app.js';
import { createDb } from './db.js';

// Load apps/api/.env when present (Node 21.7+); real environment variables win.
try {
  process.loadEnvFile();
} catch {
  /* no .env file */
}

const port = Number(process.env.PORT ?? 4000);
const jwtSecret = process.env.JWT_SECRET ?? '';
if (jwtSecret.length < 32) {
  if (process.env.NODE_ENV === 'production') throw new Error('Set JWT_SECRET to a random string of at least 32 characters');
  console.warn('JWT_SECRET is not set; using an insecure development secret.');
}

const db = await createDb(process.env.DATABASE_URL ?? './.pglite');
const app = await buildApp({
  db,
  jwtSecret: jwtSecret.length >= 32 ? jwtSecret : 'dev-only-secret-change-me-dev-only-secret',
  corsOrigins: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : true,
  logger: true,
});
await app.listen({ port, host: '0.0.0.0' });
