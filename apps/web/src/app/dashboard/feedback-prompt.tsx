'use client';

import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * The qualitative Phase 0 signal's only UI surface: "I know I can bypass this, but I don't
 * want to" isn't computable from telemetry (`server/metrics/queries.ts`'s own doc comment),
 * so this is the one place that actually asks. Rendered by `dashboard/page.tsx` only when
 * `feedback.capture` is on (server-checked — this component assumes it's already allowed to
 * be here) and the caller has at least one violation, i.e. exactly the "after a violation is
 * shown" moment the plan calls out; a dashboard visit is inherently post-activation too.
 *
 * `context` is a closed, short label (`server/feedback/feedback.ts`'s `FEEDBACK_CONTEXT_PATTERN`),
 * not part of what the user writes.
 */

const FEEDBACK_CONTEXT = 'dashboard_violation_shown';

type SubmitState = 'idle' | 'submitting' | 'submitted' | 'error';

export function FeedbackPrompt() {
  const [text, setText] = useState('');
  const [state, setState] = useState<SubmitState>('idle');
  const promptShownSent = useRef(false);

  useEffect(() => {
    if (promptShownSent.current) return;
    promptShownSent.current = true;

    // Fire-and-forget impression: never blocks or affects what the user sees, and a failure
    // here (network, flag flipped off mid-session) has no visible consequence — the submit
    // path below is the one that must never fail silently.
    fetch('/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'prompt_shown', context: FEEDBACK_CONTEXT }),
    }).catch(() => {});
  }, []);

  async function handleSubmit(formEvent: React.FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    setState('submitting');

    try {
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event: 'submitted', text, context: FEEDBACK_CONTEXT }),
      });

      setState(response.ok ? 'submitted' : 'error');
    } catch {
      setState('error');
    }
  }

  if (state === 'submitted') {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-muted-foreground">Thanks — that&apos;s recorded.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">You could bypass this. Why didn&apos;t you?</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-2">
          <textarea
            value={text}
            onChange={(changeEvent) => setText(changeEvent.target.value)}
            placeholder="Optional — anything you want to tell us."
            maxLength={2000}
            rows={3}
            className="w-full rounded-md border border-input bg-background p-2 text-sm"
          />
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={state === 'submitting' || text.trim().length === 0}>
              Send
            </Button>
            {state === 'error' ? <span className="text-xs text-destructive">Couldn&apos;t send that — try again.</span> : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
