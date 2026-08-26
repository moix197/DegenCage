/**
 * Browser-side counterpart to `instrumentation.ts`. Next.js runs this once before the app
 * hydrates.
 *
 * The browser SDK costs ~80 kB of first-load JS, so it is imported lazily and only when a
 * DSN is actually configured — with none there is nothing for the browser to report to,
 * and `instrumentation.ts` already logs that error tracking is off. `NEXT_PUBLIC_*` is
 * inlined at build time, so turning this on takes a rebuild.
 */
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  void import('./server/observability/error-tracking').then(({ initErrorTracking }) => {
    initErrorTracking('browser');
  });
}
