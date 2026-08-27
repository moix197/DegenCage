import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';

import { ADMIN_SESSION_COOKIE_NAME, getConfiguredAdminSecret, verifyAdminSessionCookie } from '@/server/admin/access';
import { buildMetricsSnapshot, type MetricsSnapshot } from '@/server/metrics/queries';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Internal-only: real per-user data (violation rates, the private baseline counterfactual,
 * verbatim feedback quotes), so this page is gated exactly like `GET /api/admin/metrics` —
 * same secret, different transport. A page navigation can't attach a custom header the way a
 * `fetch`/`curl` call to the API route can, so instead of the header this checks the signed,
 * httpOnly cookie `api/admin/login/route.ts` sets after verifying the secret
 * (`server/admin/access.ts`'s `verifyAdminSessionCookie` — the same cryptographic primitives
 * the route uses, not a second implementation). No cookie, an expired one, or a tampered one
 * all `notFound()` — the data fetch below never runs. See
 * `.ai/decisions/admin-metrics-secret-gate.md`.
 */
async function requireAdminSession(): Promise<void> {
  const expected = getConfiguredAdminSecret();
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(ADMIN_SESSION_COOKIE_NAME)?.value;

  if (!expected || !cookieValue || !verifyAdminSessionCookie(cookieValue, expected)) {
    notFound();
  }
}

export default async function AdminMetricsPage() {
  await requireAdminSession();

  const snapshot = await buildMetricsSnapshot(new Date());

  return (
    <main style={{ maxWidth: '60rem', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '2rem', padding: '1.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Phase 0 success signals</h1>
          <p>Computed live from the event log — {snapshot.generatedAt}</p>
        </div>
        <form method="POST" action="/api/admin/logout">
          <button
            type="submit"
            style={{ padding: '0.4rem 0.75rem', border: '1px solid #ccc', borderRadius: '4px', background: 'transparent', cursor: 'pointer', fontSize: '0.85rem' }}
          >
            Log out
          </button>
        </form>
      </div>

      <OnboardingSection snapshot={snapshot} />
      <LimitsSetSection snapshot={snapshot} />
      <ActivationSection snapshot={snapshot} />
      <ReturnVisitsSection snapshot={snapshot} />
      <RulesKeptSection snapshot={snapshot} />
      <ExternalViolationsSection snapshot={snapshot} />
      <StricterRuleRequestsSection snapshot={snapshot} />
      <RepeatedLooseningAttemptsSection snapshot={snapshot} />
      <FeedbackSection snapshot={snapshot} />
    </main>
  );
}

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/** A `0`-sample rate reads as "perfect non-compliance" if rendered as "0.0%" — render "no data" instead so an empty cohort is never mistaken for a clean one. */
function formatPercentOrNoData(rate: number, sampleSize: number): string {
  return sampleSize === 0 ? 'no data' : formatPercent(rate);
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <h2 style={{ fontSize: '1rem', fontWeight: 600 }}>{title}</h2>
      {note ? <p style={{ fontSize: '0.85rem', opacity: 0.75 }}>{note}</p> : null}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1.5rem' }}>{children}</div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: '0.75rem', opacity: 0.7 }}>{label}</div>
      <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>{value}</div>
    </div>
  );
}

function OnboardingSection({ snapshot }: { snapshot: MetricsSnapshot }) {
  const { onboarding } = snapshot;
  const cohortDays = Object.keys(onboarding.byDayCohort).sort();

  return (
    <Section title="Onboarding completion" note="Grouped by the UTC day of each user's first session.">
      <Stat label="Sessions" value={formatNumber(onboarding.sessionUserCount)} />
      <Stat label="Activated" value={formatNumber(onboarding.activatedUserCount)} />
      <Stat label="Completion rate" value={formatPercentOrNoData(onboarding.rate, onboarding.sessionUserCount)} />
      {cohortDays.length > 0 ? (
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', paddingRight: '1rem' }}>Cohort day</th>
              <th style={{ textAlign: 'left', paddingRight: '1rem' }}>Sessions</th>
              <th style={{ textAlign: 'left', paddingRight: '1rem' }}>Activated</th>
              <th style={{ textAlign: 'left' }}>Rate</th>
            </tr>
          </thead>
          <tbody>
            {cohortDays.map((day) => {
              const cohort = onboarding.byDayCohort[day]!;
              return (
                <tr key={day}>
                  <td style={{ paddingRight: '1rem' }}>{day}</td>
                  <td style={{ paddingRight: '1rem' }}>{formatNumber(cohort.sessionUserCount)}</td>
                  <td style={{ paddingRight: '1rem' }}>{formatNumber(cohort.activatedUserCount)}</td>
                  <td>{formatPercentOrNoData(cohort.rate, cohort.sessionUserCount)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </Section>
  );
}

function LimitsSetSection({ snapshot }: { snapshot: MetricsSnapshot }) {
  const { limitsSet } = snapshot;

  return (
    <Section title="Limits set">
      <Stat label="Active constitutions" value={formatNumber(limitsSet.activatedConstitutionCount)} />
      <Stat label="Avg limits per constitution" value={formatNumber(limitsSet.avgLimitsPerConstitution)} />
      <Stat label="Limit types" value={Object.entries(limitsSet.limitTypeCounts).map(([type, count]) => `${type}: ${count}`).join(', ') || '—'} />
    </Section>
  );
}

function ActivationSection({ snapshot }: { snapshot: MetricsSnapshot }) {
  const { activation } = snapshot;

  return (
    <Section title="Activation (commitment follow-through)">
      <Stat label="Commitments started" value={formatNumber(activation.commitmentStartedCount)} />
      <Stat label="Activated" value={formatNumber(activation.activatedCount)} />
      <Stat label="Conversion rate" value={formatPercentOrNoData(activation.conversionRate, activation.commitmentStartedCount)} />
      <Stat label="Early activation attempts" value={formatNumber(activation.earlyActivationAttemptCount)} />
      <Stat label="Early attempt rate" value={formatPercentOrNoData(activation.earlyActivationAttemptRate, activation.commitmentStartedCount)} />
    </Section>
  );
}

function ReturnVisitsSection({ snapshot }: { snapshot: MetricsSnapshot }) {
  const { returnVisits } = snapshot;

  return (
    <Section title="Return visits / week-2 floor">
      <Stat label="Avg distinct view-days per user" value={formatNumber(returnVisits.avgDistinctViewDaysPerUser)} />
      <Stat label="Week-2 eligible users" value={formatNumber(returnVisits.week2EligibleUserCount)} />
      <Stat label="Week-2 returning users" value={formatNumber(returnVisits.week2ReturningUserCount)} />
      <Stat label="Week-2 return rate" value={formatPercentOrNoData(returnVisits.week2ReturnRate, returnVisits.week2EligibleUserCount)} />
    </Section>
  );
}

function RulesKeptSection({ snapshot }: { snapshot: MetricsSnapshot }) {
  const { rulesKept } = snapshot;
  const userIds = Object.keys(rulesKept.byUser).sort();

  return (
    <Section title="Rules kept %" note="Denominator excludes `unevaluable` evaluations — those are undecided, not kept or broken. A user/row with zero decided evaluations reads &ldquo;no data&rdquo;, never 0%.">
      <Stat label="Decided evaluations" value={formatNumber(rulesKept.totalDecidedEvaluations)} />
      <Stat label="Allowed" value={formatNumber(rulesKept.allowedCount)} />
      <Stat label="Unevaluable (excluded)" value={formatNumber(rulesKept.unevaluableCount)} />
      <Stat label="Rules kept rate" value={formatPercentOrNoData(rulesKept.rulesKeptRate, rulesKept.totalDecidedEvaluations)} />
      {userIds.length > 0 ? (
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', paddingRight: '1rem' }}>User</th>
              <th style={{ textAlign: 'left', paddingRight: '1rem' }}>Decided evaluations</th>
              <th style={{ textAlign: 'left', paddingRight: '1rem' }}>Allowed</th>
              <th style={{ textAlign: 'left' }}>Rate</th>
            </tr>
          </thead>
          <tbody>
            {userIds.map((userId) => {
              const user = rulesKept.byUser[userId]!;
              return (
                <tr key={userId}>
                  <td style={{ paddingRight: '1rem' }}>{userId}</td>
                  <td style={{ paddingRight: '1rem' }}>{formatNumber(user.totalDecidedEvaluations)}</td>
                  <td style={{ paddingRight: '1rem' }}>{formatNumber(user.allowedCount)}</td>
                  <td>{formatPercentOrNoData(user.rulesKeptRate, user.totalDecidedEvaluations)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </Section>
  );
}

function ExternalViolationsSection({ snapshot }: { snapshot: MetricsSnapshot }) {
  return (
    <Section
      title="External violation frequency: live vs. baseline counterfactual"
      note="Baseline figures are an internal-only comparison — the 90-day pre-activation record is never shown to the user it belongs to. rolling_loss_usd is excluded from both sides (a baseline trade can never be loss-limit-eligible, so counting it would flatter the product). Known methodological seam: the baseline side is evaluated against the constitution's CURRENT limits, applied retroactively; the live side reflects whatever limits were actually active on each trade at the time (which can differ if limits were edited after activation) — the two are not evaluated against identically-versioned rules. Baseline span/unevaluable columns below qualify how much weight each row's counterfactual should carry."
    >
      {snapshot.externalViolations.length === 0 ? (
        <p>No active constitutions yet.</p>
      ) : (
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', paddingRight: '1rem' }}>User</th>
              <th style={{ textAlign: 'left', paddingRight: '1rem' }}>Live violations/week</th>
              <th style={{ textAlign: 'left', paddingRight: '1rem' }}>Baseline counterfactual/week</th>
              <th style={{ textAlign: 'left', paddingRight: '1rem' }}>Baseline unevaluable</th>
              <th style={{ textAlign: 'left' }}>Baseline span (days of 90)</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.externalViolations.map((row) => (
              <tr key={row.userId}>
                <td style={{ paddingRight: '1rem' }}>{row.userId}</td>
                <td style={{ paddingRight: '1rem' }}>{formatNumber(row.liveViolationsPerWeek)}</td>
                <td style={{ paddingRight: '1rem' }}>{formatNumber(row.baselineViolationsPerWeek)}</td>
                <td style={{ paddingRight: '1rem' }}>{formatNumber(row.baselineUnevaluableCount)}</td>
                <td>{formatNumber(row.baselineActualSpanDays)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function StricterRuleRequestsSection({ snapshot }: { snapshot: MetricsSnapshot }) {
  const { stricterRuleRequests } = snapshot;

  return (
    <Section title="Requests for stricter rules" note="Voluntary limit decreases — a proxy signal only.">
      <Stat label="Total decreases" value={formatNumber(stricterRuleRequests.totalDecreaseCount)} />
      <Stat label="Users who decreased a limit" value={formatNumber(Object.keys(stricterRuleRequests.decreaseCountByUser).length)} />
    </Section>
  );
}

function RepeatedLooseningAttemptsSection({ snapshot }: { snapshot: MetricsSnapshot }) {
  const { repeatedLooseningAttempts } = snapshot;

  return (
    <Section
      title="Repeated loosening attempts"
      note="Not in the plan's original mapping table — added because Phase 8 shipped these events after the plan was written. The mirror image of &ldquo;requests for stricter rules&rdquo; above."
    >
      <Stat label="Increase attempts" value={formatNumber(repeatedLooseningAttempts.totalAttemptCount)} />
      <Stat label="Voided (stale) increases" value={formatNumber(repeatedLooseningAttempts.totalVoidedCount)} />
      <Stat label="Rate-limited attempts" value={formatNumber(repeatedLooseningAttempts.totalRateLimitedCount)} />
      <Stat label="Users who tried repeatedly" value={formatNumber(repeatedLooseningAttempts.repeatedAttemptUserCount)} />
    </Section>
  );
}

function FeedbackSection({ snapshot }: { snapshot: MetricsSnapshot }) {
  return (
    <Section
      title="The killer signal"
      note="Not computable from telemetry — free-text feedback, reviewed manually. Shown verbatim, never scored or summarized."
    >
      {snapshot.recentFeedback.length === 0 ? (
        <p>No feedback submitted yet.</p>
      ) : (
        <ul style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', width: '100%' }}>
          {snapshot.recentFeedback.map((submission, index) => (
            <li key={index}>
              <span style={{ fontSize: '0.75rem', opacity: 0.7 }}>
                {submission.occurredAt.toISOString()}
                {submission.context ? ` — ${submission.context}` : ''}
              </span>
              <p>{submission.text}</p>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
