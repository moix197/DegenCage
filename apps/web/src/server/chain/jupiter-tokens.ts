import { captureError } from '../../observability/error-tracking';
import { isFeatureEnabled } from '../flags/feature-flags';

/**
 * Thin client for Jupiter Tokens v2's `search` endpoint — the market-cap data source behind
 * `classify-token.ts`'s tier bucketing, and (Phase 1 of the trading terminal) the mint
 * `decimals` source `priceTrade` needs to turn a quote's base-unit amounts into USD.
 * `GET /tokens/v2/search?query=<mint1>,<mint2>,...` returns a JSON array, comma-batching many
 * mints into one request.
 *
 * Hosted on `api.jup.ag`, not the retired `lite-api.jup.ag`, and authenticated with the same
 * `JUPITER_API_KEY` the swap client (`server/swap/jupiter-client.ts`) uses — the Free tier's
 * 1 RPS budget is shared org-wide across both endpoints, which is why every caller here goes
 * through the TTL cache below rather than re-fetching per trade.
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

const JUPITER_BASE_URL = 'https://api.jup.ag';
const REQUEST_TIMEOUT_MS = 8_000;
/** Mcap moves continuously; this only bounds how often one reconcile run re-fetches the same mint. */
const CACHE_TTL_MS = 5 * 60 * 1_000;
/**
 * The process outlives any one reconcile run, and the long tail of mints is effectively
 * unbounded — without a ceiling this map is a slow leak in a long-lived server.
 */
const CACHE_MAX_ENTRIES = 5_000;

interface TokenFacts {
  mcap: number | null;
  /** Never changes for a mint; cached alongside `mcap` only because one request returns both. */
  decimals: number | null;
}

interface CacheEntry extends TokenFacts {
  expiresAt: number;
}

const tokenCache = new Map<string, CacheEntry>();

/**
 * One shared fetch per mint currently in flight, so two concurrent callers for the same mint —
 * `quote-service.ts`'s `lookupTokenDecimals` and `classifyToken`'s `lookupTokenMcaps` run via
 * `Promise.all` for the same output mint, chief among them — coalesce into a single Jupiter
 * round trip instead of both racing the Free tier's 1 RPS org-wide bucket. Cleared as soon as
 * the fetch it points at settles, so it never outlives the request it represents.
 */
const inFlightRefreshes = new Map<string, Promise<void>>();

interface JupiterTokenSearchItem {
  id: string;
  mcap?: number | null;
  decimals?: number | null;
}

function isFresh(entry: CacheEntry | undefined, now: number): entry is CacheEntry {
  return entry !== undefined && entry.expiresAt > now;
}

/**
 * Drops expired entries first; if that alone doesn't get under the ceiling, drops oldest-
 * inserted until it does (`Map` iterates in insertion order). Losing a live entry only costs
 * a refetch — the cache is an optimisation, never a source of truth.
 */
function evictIfOversized(now: number): void {
  if (tokenCache.size <= CACHE_MAX_ENTRIES) return;

  for (const [mint, entry] of tokenCache) {
    if (!isFresh(entry, now)) tokenCache.delete(mint);
  }

  for (const mint of tokenCache.keys()) {
    if (tokenCache.size <= CACHE_MAX_ENTRIES) break;
    tokenCache.delete(mint);
  }
}

async function fetchTokenFacts(mints: string[]): Promise<Map<string, TokenFacts>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const url = `${JUPITER_BASE_URL}/tokens/v2/search?query=${mints.join(',')}`;
    const apiKey = process.env.JUPITER_API_KEY;
    const response = await fetch(url, {
      signal: controller.signal,
      headers: apiKey ? { 'x-api-key': apiKey } : {},
    });

    if (!response.ok) {
      throw new Error(`Jupiter Tokens v2 search responded ${response.status}`);
    }

    const items = (await response.json()) as JupiterTokenSearchItem[];
    const result = new Map<string, TokenFacts>();

    for (const item of items) {
      result.set(item.id, {
        mcap: typeof item.mcap === 'number' ? item.mcap : null,
        decimals: typeof item.decimals === 'number' ? item.decimals : null,
      });
    }

    return result;
  } finally {
    clearTimeout(timeout);
  }
}

/** The actual fetch-and-cache work, factored out so `refreshTokenFacts` can share one call of it across concurrent callers via `inFlightRefreshes`. */
async function fetchAndCacheTokenFacts(mints: string[], now: number): Promise<void> {
  try {
    const fetched = await fetchTokenFacts(mints);

    for (const mint of mints) {
      const facts = fetched.get(mint);
      tokenCache.set(mint, { mcap: facts?.mcap ?? null, decimals: facts?.decimals ?? null, expiresAt: now + CACHE_TTL_MS });
    }

    evictIfOversized(now);
  } catch (error) {
    captureError(error, { operation: 'refreshTokenFacts', mintCount: mints.length, failedClosed: true });
  }
}

/**
 * Populates `tokenCache` for whatever in `mints` is not already cached and fresh, in one
 * comma-joined request. Never throws: a failure leaves those mints absent from the cache, so
 * every caller below reads them as "no entry" and fails closed exactly as an unlisted mint
 * would.
 *
 * Coalesces with any refresh already in flight for the same mint (`inFlightRefreshes`) rather
 * than issuing a second request: `lookupTokenDecimals` and `lookupTokenMcaps` are called
 * concurrently for the same output mint on every quote (`quote-service.ts`'s `evaluateQuote`),
 * and without this each would fetch that mint independently against the Free tier's shared
 * 1 RPS budget.
 */
async function refreshTokenFacts(mints: string[], now: number): Promise<void> {
  const uncached = [...new Set(mints)].filter((mint) => !isFresh(tokenCache.get(mint), now));

  if (uncached.length === 0) {
    return;
  }

  const toFetch = uncached.filter((mint) => !inFlightRefreshes.has(mint));

  if (toFetch.length > 0) {
    const fetchPromise = fetchAndCacheTokenFacts(toFetch, now).finally(() => {
      for (const mint of toFetch) {
        if (inFlightRefreshes.get(mint) === fetchPromise) inFlightRefreshes.delete(mint);
      }
    });

    for (const mint of toFetch) {
      inFlightRefreshes.set(mint, fetchPromise);
    }
  }

  await Promise.all(uncached.map((mint) => inFlightRefreshes.get(mint)).filter((pending): pending is Promise<void> => pending !== undefined));
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
  await refreshTokenFacts(mints, now);

  for (const mint of mints) {
    const entry = tokenCache.get(mint);

    if (isFresh(entry, now) && entry.mcap !== null) {
      result.set(mint, entry.mcap);
    }
  }

  return result;
}

/**
 * Resolves `mints`' decimals, sharing the same batched request and cache as
 * `lookupTokenMcaps` above — one Jupiter round trip serves both, which matters against the
 * Free tier's 1 RPS org-wide budget.
 *
 * Deliberately **not** behind `CLASSIFICATION_JUPITER_MCAP_FLAG`: that switch exists to turn
 * *tier classification* off (whose fail-closed answer is `MICRO_CAP`), and flipping it must
 * not silently disable pricing too. The call sites that need decimals
 * (`server/swap/quote-service.ts`) are already gated by `jupiter.swap_build`. Same
 * fail-closed contract as the mcap lookup: a mint Jupiter did not list with a numeric
 * `decimals` is simply absent from the result, and the caller blocks rather than guessing a
 * decimal scale — a wrong scale would misprice the trade by orders of magnitude.
 */
export async function lookupTokenDecimals(mints: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();

  if (mints.length === 0) {
    return result;
  }

  const now = Date.now();
  await refreshTokenFacts(mints, now);

  for (const mint of mints) {
    const entry = tokenCache.get(mint);

    if (isFresh(entry, now) && entry.decimals !== null) {
      result.set(mint, entry.decimals);
    }
  }

  return result;
}
