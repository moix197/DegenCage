import { captureError } from '../../observability/error-tracking';
import { isFeatureEnabled } from '../flags/feature-flags';

/**
 * Thin client for Jupiter Tokens v2's `search` endpoint — the market-cap data source behind
 * `classify-token.ts`'s tier bucketing. Live-verified against the public `lite-api.jup.ag`
 * host: `GET /tokens/v2/search?query=<mint1>,<mint2>,...` returns a JSON array, comma-batching
 * many mints into one request; no API key.
 *
 * Behind its own kill switch (`CLASSIFICATION_JUPITER_MCAP_FLAG`) and fails closed: disabled,
 * a timeout, a non-200, or a thrown request all resolve to an empty result for every
 * requested mint — never a guessed mcap. `classify-token.ts` reads "no entry" as "unlisted /
 * unpriceable" and buckets it `MICRO_CAP` (CLAUDE.md → fail closed).
 *
 * A short in-memory TTL cache avoids re-fetching a mint's mcap on every trade within one
 * reconcile run (and across nearby ones) — mcap is a live figure anyway
 * (`.ai/decisions/` doesn't need a durable cache the way the SOL/USD minute price does).
 */

export const CLASSIFICATION_JUPITER_MCAP_FLAG = 'classification.jupiter_mcap';

const JUPITER_BASE_URL = 'https://lite-api.jup.ag';
const REQUEST_TIMEOUT_MS = 8_000;
/** Mcap moves continuously; this only bounds how often one reconcile run re-fetches the same mint. */
const CACHE_TTL_MS = 5 * 60 * 1_000;

interface CacheEntry {
  mcap: number | null;
  expiresAt: number;
}

const mcapCache = new Map<string, CacheEntry>();

interface JupiterTokenSearchItem {
  id: string;
  mcap?: number | null;
}

function isFresh(entry: CacheEntry | undefined, now: number): entry is CacheEntry {
  return entry !== undefined && entry.expiresAt > now;
}

async function fetchMcaps(mints: string[]): Promise<Map<string, number>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const url = `${JUPITER_BASE_URL}/tokens/v2/search?query=${mints.join(',')}`;
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      throw new Error(`Jupiter Tokens v2 search responded ${response.status}`);
    }

    const items = (await response.json()) as JupiterTokenSearchItem[];
    const result = new Map<string, number>();

    for (const item of items) {
      if (typeof item.mcap === 'number') {
        result.set(item.id, item.mcap);
      }
    }

    return result;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Resolves `mints`' market caps, batched into one comma-joined request for whatever is not
 * already cached and fresh. Returns a map with an entry only for mints Jupiter actually
 * listed with a numeric `mcap`; a missing key (never a thrown error) is the caller's signal
 * to fail closed.
 */
export async function lookupTokenMcaps(mints: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();

  if (mints.length === 0) {
    return result;
  }

  if (!(await isFeatureEnabled(CLASSIFICATION_JUPITER_MCAP_FLAG))) {
    return result;
  }

  const now = Date.now();
  const uncached = [...new Set(mints)].filter((mint) => !isFresh(mcapCache.get(mint), now));

  if (uncached.length > 0) {
    try {
      const fetched = await fetchMcaps(uncached);

      for (const mint of uncached) {
        mcapCache.set(mint, { mcap: fetched.get(mint) ?? null, expiresAt: now + CACHE_TTL_MS });
      }
    } catch (error) {
      captureError(error, { operation: 'lookupTokenMcaps', mintCount: uncached.length, failedClosed: true });
      // Leave the uncached mints out of `mcapCache` — the loop below reads them as "no
      // entry" and the caller fails closed, exactly as an unlisted mint would.
    }
  }

  for (const mint of mints) {
    const entry = mcapCache.get(mint);

    if (isFresh(entry, now) && entry.mcap !== null) {
      result.set(mint, entry.mcap);
    }
  }

  return result;
}
