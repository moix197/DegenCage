import { Pool } from '@neondatabase/serverless';
import { drizzle, type NeonDatabase } from 'drizzle-orm/neon-serverless';

import * as schema from './schema';

/**
 * The single Postgres handle (`.ai/decisions/single-source-of-truth-database.md`).
 *
 * Two deliberate choices:
 * - **Pooled connection.** Serverless opens a connection per invocation and
 *   exhausts Postgres fast, so runtime always uses `DATABASE_URL_POOLED`. The
 *   direct `DATABASE_URL` belongs to drizzle-kit alone.
 * - **The WebSocket pool, not the HTTP driver.** Idempotency is enforced by the
 *   database — transactions, row locks (`SELECT ... FOR UPDATE`), unique
 *   constraints — which the one-shot HTTP driver cannot express.
 *
 * Configuration is plain env vars only: no `@vercel/postgres`, no platform-specific
 * config reads (`.ai/decisions/hosting-and-growth-path.md`).
 */

export type Database = NeonDatabase<typeof schema>;

// Survives Next.js dev HMR, which would otherwise leak a pool per reload.
const globalForDb = globalThis as unknown as { degencageDb?: Database };

function requireConnectionString(): string {
  const url = process.env.DATABASE_URL_POOLED;

  if (!url) {
    throw new Error(
      'DATABASE_URL_POOLED is not set. Runtime must use the pooled Neon connection; see .env.example.',
    );
  }

  return url;
}

export function getDb(): Database {
  globalForDb.degencageDb ??= drizzle(new Pool({ connectionString: requireConnectionString() }), {
    schema,
  });

  return globalForDb.degencageDb;
}
