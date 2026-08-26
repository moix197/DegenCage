import { defineConfig } from 'drizzle-kit';

const directUrl = process.env.DATABASE_URL;

if (!directUrl) {
  throw new Error(
    'DATABASE_URL is required for drizzle-kit. Run migrations through the root scripts (`pnpm db:generate`, `pnpm db:migrate`) so the root .env is loaded.',
  );
}

// drizzle-kit uses the *direct* connection; the pooled one is runtime-only.
export default defineConfig({
  schema: './src/server/db/schema.ts',
  out: './src/server/db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: directUrl },
  strict: true,
  verbose: true,
});
