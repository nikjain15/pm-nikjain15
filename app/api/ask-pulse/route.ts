import { NextResponse } from 'next/server';
import { planActions } from '@/lib/agent-plan';
import type { BoardContext } from '@/lib/agent';
import { evictExpired, hitRateLimit, type RateLimitState } from '@/lib/rate-limit';

/**
 * POST /api/ask-pulse — plan a user's request into own-board actions. design-agent.md §5.
 *
 * **Why a route.** ANTHROPIC_API_KEY is server-only and must not ship to a browser
 * (AGENTS.md rule 8), same as narrate/extract. The route ONLY plans: it returns proposed
 * actions as data. Execution happens back in the browser, under the user's own Firebase
 * session, so `firestore.rules` binds the agent exactly as it binds a button — the route
 * never touches Firestore and never holds the Admin SDK.
 *
 * **Why the client sends its own board context.** The plan can only reference the user's own
 * tasks/projects, and re-validating server-side against that context is the injection guard
 * (`validatePlan`). A client that lied about its own board could only propose actions it
 * could already perform by hand under the rules — no new power.
 *
 * On any failure — no key, model down, bad input — it returns an empty plan with a reason,
 * never a 500 and never a fabricated action.
 */

const RATE_LIMIT = 15;
const WINDOW_MS = 60_000;
const rateStore = new Map<string, RateLimitState>();

function clientIp(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for');
  return fwd?.split(',')[0]?.trim() || 'unknown';
}

type AskRequest = { utterance: unknown; context: unknown };

function validContext(c: unknown): c is BoardContext {
  if (typeof c !== 'object' || c === null) return false;
  const ctx = c as Record<string, unknown>;
  return typeof ctx.uid === 'string' && Array.isArray(ctx.tasks) && Array.isArray(ctx.projects);
}

export async function POST(request: Request) {
  let body: AskRequest;
  try {
    body = (await request.json()) as AskRequest;
  } catch {
    return NextResponse.json({ error: 'malformed' }, { status: 400 });
  }

  if (typeof body.utterance !== 'string' || body.utterance.trim().length === 0 || !validContext(body.context)) {
    return NextResponse.json({ error: 'invalid' }, { status: 400 });
  }

  const now = Date.now();
  evictExpired(rateStore, now, WINDOW_MS);
  const gate = hitRateLimit(rateStore, clientIp(request), now, RATE_LIMIT, WINDOW_MS);
  if (gate.limited) {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(gate.retryAfterMs / 1000)) } }
    );
  }

  const result = await planActions(body.utterance, body.context);
  // 200 on every planning path: an empty plan with a reason is an outcome the UI states
  // calmly, not an error.
  return NextResponse.json(result);
}
