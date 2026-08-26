import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { identityDecision } from './index';

const SRC_DIR = fileURLToPath(new URL('.', import.meta.url));

/** Anything here would break the package's no-I/O invariant (monorepo-package-shape). */
const FORBIDDEN_SOURCE_PATTERNS = [
  /from\s+['"]next\//,
  /from\s+['"]drizzle-orm/,
  /from\s+['"]@neondatabase\//,
  /from\s+['"]node:(fs|http|https|net)['"]/,
  /\bfetch\s*\(/,
];

function readPackageSources(): { file: string; source: string }[] {
  return readdirSync(SRC_DIR)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => ({ file, source: readFileSync(join(SRC_DIR, file), 'utf8') }));
}

describe('identityDecision', () => {
  it('returns its input unchanged, by reference', () => {
    const decision = { verdict: 'allow', reason: 'placeholder' };

    expect(identityDecision(decision)).toBe(decision);
  });

  it('performs no I/O — same input, same output, repeatedly', () => {
    expect(identityDecision('x')).toBe('x');
    expect(identityDecision('x')).toBe('x');
  });
});

describe('package purity', () => {
  it('has source files to check', () => {
    expect(readPackageSources().length).toBeGreaterThan(0);
  });

  it.each(FORBIDDEN_SOURCE_PATTERNS.map((pattern) => [pattern.source, pattern] as const))(
    'imports nothing matching %s (no DB, no fetch, no next/*)',
    (_label, pattern) => {
      for (const { file, source } of readPackageSources()) {
        expect(pattern.test(source), `${file} violates the no-I/O invariant`).toBe(false);
      }
    },
  );
});
