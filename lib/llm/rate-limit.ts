/**
 * In-process LLM traffic governor.
 *
 * WHY THIS EXISTS
 * ---------------
 * A single `429 Too Many Requests` from one free-tier provider used to take the
 * whole terminal down: 10 specialists + vision + debate + judge each retried on
 * their own schedule, so a run fired ~24 requests into a rate-limited key, burned
 * the remaining quota, and still finished with "All LLM providers failed".
 *
 * This module centralises the three things that must be *shared* across every
 * caller in a run:
 *   1. pacing (one global minimum gap + a concurrency gate, not per-agent sleeps)
 *   2. cooldowns derived from the provider's own `Retry-After` / reset hints
 *   3. an outage circuit breaker, so once the providers are proven dead we stop
 *      hammering them and report OFFLINE honestly instead of pretending NO_TRADE
 *
 * No imports on purpose — it is used by the LLM client, the runner, the pipeline
 * and `/api/health`, and stays trivially unit-testable.
 */

import type { LlmErrorClass, LlmProvider } from './models';

export type { LlmErrorClass };

export interface ProviderRateState {
  provider: string;
  /** epoch ms until which no request may leave the process for this provider. */
  cooldownUntil: number;
  /** consecutive rate-limit / transient failures for this provider. */
  strikes: number;
  requests: number;
  rateLimits: number;
  lastRetryAfterMs: number;
  lastErrorAt: number;
  lastErrorClass: LlmErrorClass | '';
}

export interface ProviderRateSnapshot extends ProviderRateState {
  cooldownRemainingMs: number;
}

export interface OutageInfo {
  open: boolean;
  reason: string;
  since: number;
}

interface Governor {
  states: Map<string, ProviderRateState>;
  inFlight: number;
  lastDispatchAt: number;
  consecutiveFailures: number;
  outage: OutageInfo;
  runEndsAt: number;
  runStartedAt: number;
}

const governor: Governor = {
  states: new Map(),
  inFlight: 0,
  lastDispatchAt: 0,
  consecutiveFailures: 0,
  outage: { open: false, reason: '', since: 0 },
  runEndsAt: 0,
  runStartedAt: 0
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Minimum gap between two outbound LLM requests, process-wide. */
export function minIntervalMs(): number {
  return envInt('LLM_MIN_INTERVAL_MS', 900);
}

/** How many LLM requests may be in flight at once (default: strictly serial). */
export function maxConcurrency(): number {
  return Math.max(1, envInt('LLM_MAX_CONCURRENCY', 1));
}

/** Longest a single call will sit in the queue/cooldown before giving up. */
export function maxWaitMs(): number {
  return envInt('LLM_MAX_WAIT_MS', 90_000);
}

/** Ceiling for any single provider cooldown, whatever the provider asked for. */
export function maxCooldownMs(): number {
  return envInt('LLM_MAX_COOLDOWN_MS', 120_000);
}

/** Consecutive rate-limit/transient failures before the breaker opens. */
export function outageThreshold(): number {
  return Math.max(1, envInt('LLM_OUTAGE_THRESHOLD', 3));
}

/** Wall-clock budget for the LLM-heavy part of a run (0 = unlimited). */
export function runBudgetMs(): number {
  return envInt('LLM_RUN_BUDGET_MS', 240_000);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.floor(ms))));
}

export function stateFor(provider: string): ProviderRateState {
  let st = governor.states.get(provider);
  if (!st) {
    st = {
      provider,
      cooldownUntil: 0,
      strikes: 0,
      requests: 0,
      rateLimits: 0,
      lastRetryAfterMs: 0,
      lastErrorAt: 0,
      lastErrorClass: ''
    };
    governor.states.set(provider, st);
  }
  return st;
}

/**
 * Start a run: resets pacing/budget. Called at the top of every analysis so an
 * operator who just fixed a key always gets a clean, unthrottled first probe.
 */
export function beginRun(budgetMs = runBudgetMs()): void {
  governor.runStartedAt = Date.now();
  governor.runEndsAt = budgetMs > 0 ? Date.now() + budgetMs : 0;
  governor.inFlight = 0;
  governor.lastDispatchAt = 0;
  governor.consecutiveFailures = 0;
  governor.outage = { open: false, reason: '', since: 0 };
  // Strikes are per-run on purpose: a provider that was dead ten minutes ago
  // deserves a fresh probe now (the free-tier window may have reset). Active
  // cooldowns are kept, so a run started 3s after an outage still paces itself.
  for (const st of governor.states.values()) st.strikes = 0;
}

/** Clear provider cooldowns/strikes without touching the run budget. */
export function resetRateLimits(): void {
  governor.states.clear();
  governor.consecutiveFailures = 0;
  governor.outage = { open: false, reason: '', since: 0 };
}

export function outageInfo(): OutageInfo {
  return { ...governor.outage };
}

export function isOutageOpen(): boolean {
  return governor.outage.open;
}

export function tripOutage(reason: string): void {
  if (!governor.outage.open) {
    governor.outage = { open: true, reason, since: Date.now() };
  } else if (governor.outage.reason && !governor.outage.reason.includes(reason)) {
    governor.outage.reason = `${governor.outage.reason}; ${reason}`.slice(0, 400);
  }
}

export function consecutiveFailures(): number {
  return governor.consecutiveFailures;
}

export function budgetRemainingMs(): number {
  if (!governor.runEndsAt) return Number.POSITIVE_INFINITY;
  return Math.max(0, governor.runEndsAt - Date.now());
}

export function isRunBudgetExhausted(): boolean {
  return governor.runEndsAt > 0 && governor.runEndsAt - Date.now() <= 0;
}

export function snapshot(): {
  providers: ProviderRateSnapshot[];
  outage: OutageInfo;
  inFlight: number;
  consecutiveFailures: number;
  runElapsedMs: number;
  budgetRemainingMs: number;
} {
  const now = Date.now();
  return {
    providers: [...governor.states.values()].map((s) => ({
      ...s,
      cooldownRemainingMs: Math.max(0, s.cooldownUntil - now)
    })),
    outage: outageInfo(),
    inFlight: governor.inFlight,
    consecutiveFailures: governor.consecutiveFailures,
    runElapsedMs: governor.runStartedAt ? now - governor.runStartedAt : 0,
    budgetRemainingMs: Number.isFinite(budgetRemainingMs()) ? budgetRemainingMs() : -1
  };
}

/**
 * Parse a provider's own "come back in N seconds" hint.
 * Understands the `Retry-After` header (delta-seconds or HTTP-date) plus the
 * JSON/error-text variants OpenRouter, NVIDIA NIM and Gemini emit.
 */
export function parseRetryAfterMs(input: {
  header?: string | number | null;
  body?: string | null;
  now?: number;
}): number | null {
  const now = input.now ?? Date.now();
  const candidates: number[] = [];
  const secondsLike = (v: unknown): number | null => {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
    const date = Date.parse(s);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
    return null;
  };

  const fromHeader = secondsLike(input.header);
  if (fromHeader != null) candidates.push(fromHeader);

  const body = input.body || '';
  if (body) {
    const patterns: RegExp[] = [
      /"retry_after"\s*:\s*"?(\d+(?:\.\d+)?)"?/i,
      /retry[-_ ]after["'\s:=]+(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds)?/i,
      /try again (?:in|after)\s+(\d+(?:\.\d+)?)\s*(?:ms|milliseconds|s|sec|secs|seconds)/i,
      /(?:quota|limit) reset(?:s)? (?:in|at)\s+(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds)/i,
      /reset_in["'\s:=]+(\d+(?:\.\d+)?)/i,
      /"x-ratelimit-reset(?:-requests|-tokens)?"\s*:\s*"?(\d+(?:\.\d+)?)"?/i
    ];
    for (const re of patterns) {
      const m = body.match(re);
      if (!m) continue;
      const raw = m[1];
      // Sub-second values from OpenRouter-style headers are already seconds.
      const secs = Number(raw);
      if (Number.isFinite(secs) && secs > 0) candidates.push(Math.round(secs * 1000));
    }
    // "Please retry in 1.23ms"
    const ms = body.match(/(\d+(?:\.\d+)?)\s*ms\b/i);
    if (ms) {
      const v = Number(ms[1]);
      if (Number.isFinite(v) && v > 0) candidates.push(Math.round(v));
    }
  }

  if (!candidates.length) return null;
  return Math.max(0, Math.min(...candidates));
}

/** Backoff to apply for `strike`-th consecutive rate limit when the API said nothing. */
export function fallbackBackoffMs(strikes: number): number {
  const k = Math.max(1, strikes);
  return Math.min(maxCooldownMs(), 4_000 * 2 ** (k - 1));
}

function applyRateLimit(provider: string, retryAfterMs: number | null): number {
  const st = stateFor(provider);
  st.strikes += 1;
  st.rateLimits += 1;
  st.lastErrorAt = Date.now();
  st.lastErrorClass = 'RATE_LIMIT';
  const requested = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : fallbackBackoffMs(st.strikes);
  const cooldown = Math.min(Math.max(1_000, requested), maxCooldownMs());
  st.lastRetryAfterMs = retryAfterMs ?? 0;
  st.cooldownUntil = Math.max(st.cooldownUntil, Date.now() + cooldown);
  governor.consecutiveFailures += 1;
  if (governor.consecutiveFailures >= outageThreshold()) {
    tripOutage(`${provider} rate limited ${governor.consecutiveFailures}x in a row`);
  }
  return cooldown;
}

/**
 * Record a rate-limited response. Returns the cooldown that was applied so the
 * caller can surface "provider backing off for 27s" in the UI instead of a
 * mystery "All LLM providers failed".
 */
export function noteRateLimit(provider: string, retryAfterMs: number | null, _message = ''): number {
  stateFor(provider).requests += 1;
  return applyRateLimit(provider, retryAfterMs);
}

export function noteFailure(provider: string, errorClass: LlmErrorClass, message = ''): void {
  const st = stateFor(provider);
  st.requests += 1;
  st.lastErrorAt = Date.now();
  st.lastErrorClass = errorClass;
  if (errorClass === 'RATE_LIMIT') {
    applyRateLimit(provider, null);
    return;
  }
  if (errorClass === 'AUTH' || errorClass === 'MISSING_KEY' || errorClass === 'CREDITS' || errorClass === 'MODEL_NOT_FOUND') {
    // Not a traffic problem: never retry this provider inside the same run.
    st.cooldownUntil = Date.now() + maxCooldownMs();
    st.strikes += 1;
    governor.consecutiveFailures += 1;
    if (governor.consecutiveFailures >= outageThreshold()) {
      tripOutage(`${provider}: ${errorClass}${message ? ` (${message.slice(0, 120)})` : ''}`);
    }
    return;
  }
  if (errorClass === 'TIMEOUT' || errorClass === 'NETWORK' || errorClass === 'UPSTREAM') {
    governor.consecutiveFailures += 1;
    if (governor.consecutiveFailures >= outageThreshold()) {
      tripOutage(`${provider}: ${errorClass}`);
    }
  }
}

/**
 * A dead model id is a per-model problem, not a per-key problem: park the
 * provider for it and the next live model in the catalogue would be skipped too.
 */
export function noteModelFailure(provider: string): void {
  const st = stateFor(provider);
  st.requests += 1;
  st.lastErrorAt = Date.now();
  st.lastErrorClass = 'MODEL_NOT_FOUND';
}

export function noteSuccess(provider: string): void {
  const st = stateFor(provider);
  st.strikes = 0;
  st.cooldownUntil = 0;
  st.lastErrorClass = '';
  governor.consecutiveFailures = 0;
  if (governor.outage.open) {
    governor.outage = { open: false, reason: `recovered via ${provider}`, since: Date.now() };
  }
}

export function cooldownRemainingMs(provider: string): number {
  return Math.max(0, stateFor(provider).cooldownUntil - Date.now());
}

/**
 * True when this provider is known-bad and not worth a network call right now:
 * breaker open, run budget gone, or a hard cooldown still running past the wait
 * budget. Callers use this to skip fast and stay honest.
 */
export function providerStrikes(provider: string): number {
  return stateFor(provider).strikes;
}

/**
 * Skip-without-a-network-call decision for one provider. Per provider on
 * purpose: a rate-limited NVIDIA key must not block a healthy OpenRouter or
 * Gemini key (that is the whole point of having failover).
 */
export function shouldSkipProvider(provider: string): { skip: boolean; reason: string } {
  if (isRunBudgetExhausted()) return { skip: true, reason: 'LLM_RUN_BUDGET_EXHAUSTED' };
  const st = stateFor(provider);
  const remaining = Math.max(0, st.cooldownUntil - Date.now());
  if (remaining > Math.max(maxWaitMs(), 1_000)) {
    return { skip: true, reason: `COOLDOWN_${Math.ceil(remaining / 1000)}s` };
  }
  if (st.strikes >= outageThreshold() + 2) {
    return { skip: true, reason: `PROVIDER_BREAKER_OPEN (${st.strikes} consecutive failures)` };
  }
  return { skip: false, reason: '' };
}

export interface SlotLease {
  waitedMs: number;
  /** queue/cooldown could not clear inside the wait budget — do not send. */
  expired: boolean;
  release: () => void;
}

/**
 * Wait for pacing + cooldown, then reserve a slot. The returned `release()` MUST
 * be called in a `finally`. `expired: true` means "we would exceed the wait
 * budget" and the caller should fail fast rather than hammer the provider.
 *
 * `waitCeilingMs` lets a caller ask for a shorter patience window (health probes,
 * debate) or a longer one (the canary agent, which is worth waiting out a
 * per-minute free-tier reset for).
 */
export async function acquireSlot(provider: string, waitCeilingMs?: number): Promise<SlotLease> {
  const startedAt = Date.now();
  const ceiling = Math.max(0, waitCeilingMs ?? maxWaitMs());
  const budget = Math.min(ceiling, budgetRemainingMs());
  const deadline = startedAt + (Number.isFinite(budget) ? budget : ceiling);
  const st = stateFor(provider);
  let waited = 0;

  const sleepTo = async (target: number) => {
    const ms = Math.min(Math.max(10, target - Date.now()), 200);
    await sleep(ms);
    waited = Date.now() - startedAt;
  };

  while (st.cooldownUntil > Date.now()) {
    if (Date.now() >= deadline) return { waitedMs: waited, expired: true, release: () => {} };
    await sleepTo(st.cooldownUntil);
  }

  while (governor.inFlight >= maxConcurrency()) {
    if (Date.now() >= deadline) return { waitedMs: waited, expired: true, release: () => {} };
    await sleepTo(Date.now() + 150);
  }

  const gap = minIntervalMs() - (Date.now() - governor.lastDispatchAt);
  if (gap > 0) {
    if (Date.now() + gap > deadline) return { waitedMs: waited, expired: true, release: () => {} };
    await sleepTo(Date.now() + gap);
  }

  governor.inFlight += 1;
  governor.lastDispatchAt = Date.now();
  let released = false;
  return {
    waitedMs: Date.now() - startedAt,
    expired: false,
    release: () => {
      if (released) return;
      released = true;
      governor.inFlight = Math.max(0, governor.inFlight - 1);
    }
  };
}

/** Test helper — returns the governor to a pristine state. */
export function _resetGovernor(): void {
  governor.states.clear();
  governor.inFlight = 0;
  governor.lastDispatchAt = 0;
  governor.consecutiveFailures = 0;
  governor.outage = { open: false, reason: '', since: 0 };
  governor.runEndsAt = 0;
  governor.runStartedAt = 0;
}

export type { LlmProvider };
