import { buildMetricsSnapshot, type MetricsSnapshot } from '@/server/metrics/queries';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Internal-only, unlinked page (decision 11 — no RBAC in Phase 0). Renders the same
 * `buildMetricsSnapshot()` the header-gated `GET /api/admin/metrics` answers with, called
 * directly server-side rather than over HTTP — a page navigation cannot attach the
 * shared-secret header a browser fetch could, so the API route (not this page) is what
 * enforces that gate for any programmatic caller. See `.ai/decisions/admin-metrics-secret-gate.md`.
 */
export default async function AdminMetricsPage() {
  const snapshot = await buildMetricsSnapshot(new Date());

  return (
    <main style={{ maxWidth: '60rem', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '2rem', padding: '1.5rem' }}>
      <div>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Phase 0 success signals</h1>
        <p>Computed live from the event log — {snapshot.generatedAt}</p>
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

  return (
    <Section title="Onboarding completion">
      <Stat label="Sessions" value={formatNumber(onboarding.sessionUserCount)} />
      <Stat label="Activated" value={formatNumber(onboarding.activatedUserCount)} />
      <Stat label="Completion rate" value={formatPercent(onboarding.rate)} />
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
      <Stat label="Conversion rate" value={formatPercent(activation.conversionRate)} />
      <Stat label="Early activation attempts" value={formatNumber(activation.earlyActivationAttemptCount)} />
      <Stat label="Early attempt rate" value={formatPercent(activation.earlyActivationAttemptRate)} />
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
      <Stat label="Week-2 return rate" value={formatPercent(returnVisits.week2ReturnRate)} />
    </Section>
  );
}

function RulesKeptSection({ snapshot }: { snapshot: MetricsSnapshot }) {
  const { rulesKept } = snapshot;

  return (
    <Section title="Rules kept %">
      <Stat label="Evaluations" value={formatNumber(rulesKept.totalEvaluations)} />
      <Stat label="Allowed" value={formatNumber(rulesKept.allowedCount)} />
      <Stat label="Rules kept rate" value={formatPercent(rulesKept.rulesKeptRate)} />
    </Section>
  );
}

function ExternalViolationsSection({ snapshot }: { snapshot: MetricsSnapshot }) {
  return (
    <Section
      title="External violation frequency: live vs. baseline counterfactual"
      note="Baseline figures are an internal-only comparison — the 90-day pre-activation record is never shown to the user it belongs to."
    >
      {snapshot.externalViolations.length === 0 ? (
        <p>No active constitutions yet.</p>
      ) : (
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', paddingRight: '1rem' }}>User</th>
              <th style={{ textAlign: 'left', paddingRight: '1rem' }}>Live violations/week</th>
              <th style={{ textAlign: 'left' }}>Baseline counterfactual/week</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.externalViolations.map((row) => (
              <tr key={row.userId}>
                <td style={{ paddingRight: '1rem' }}>{row.userId}</td>
                <td style={{ paddingRight: '1rem' }}>{formatNumber(row.liveViolationsPerWeek)}</td>
                <td>{formatNumber(row.baselineViolationsPerWeek)}</td>
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
