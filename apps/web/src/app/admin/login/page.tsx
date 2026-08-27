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
    <main style={{ maxWidth: '24rem', margin: '4rem auto', display: 'flex', flexDirection: 'column', gap: '1rem', padding: '1.5rem' }}>
      <h1 style={{ fontSize: '1.1rem', fontWeight: 600 }}>Admin sign-in</h1>
      {params.error ? <p style={{ color: 'crimson', fontSize: '0.9rem' }}>Wrong secret.</p> : null}
      <form method="POST" action="/api/admin/login" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <input
          type="password"
          name="secret"
          placeholder="Shared secret"
          required
          autoFocus
          style={{ padding: '0.5rem', border: '1px solid #ccc', borderRadius: '4px' }}
        />
        <button
          type="submit"
          style={{ padding: '0.5rem', border: 'none', borderRadius: '4px', background: '#111', color: '#fff', cursor: 'pointer' }}
        >
          Continue
        </button>
      </form>
    </main>
  );
}
