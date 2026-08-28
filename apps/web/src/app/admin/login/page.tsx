export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Public — this page itself carries no data, only a form that posts the shared secret to
 * `api/admin/login`, which is what actually verifies it and sets the session cookie
 * `admin/metrics/page.tsx` checks. Plain HTML form, no client JS required.
 */
export default async function AdminLoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const params = await searchParams;

  return (
    <main className="mx-auto my-16 flex max-w-sm flex-col gap-4">
      <h1 className="text-[1.1rem] font-semibold">Admin sign-in</h1>
      {params.error ? <p className="text-[0.9rem] text-destructive">Wrong secret.</p> : null}
      <form method="POST" action="/api/admin/login" className="flex flex-col gap-3">
        <input
          type="password"
          name="secret"
          placeholder="Shared secret"
          required
          autoFocus
          className="rounded border border-input bg-background p-2 text-foreground"
        />
        <button type="submit" className="cursor-pointer rounded bg-primary p-2 text-primary-foreground">
          Continue
        </button>
      </form>
    </main>
  );
}
