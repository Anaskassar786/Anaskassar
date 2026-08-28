import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  _resetGovernor,
  acquireSlot,
  beginRun,
  budgetRemainingMs,
  cooldownRemainingMs,
  fallbackBackoffMs,
  isOutageOpen,
  isRunBudgetExhausted,
  noteFailure,
  noteRateLimit,
  noteSuccess,
  outageInfo,
  parseRetryAfterMs,
  shouldSkipProvider,
  snapshot,
  stateFor
} from '@/lib/llm/rate-limit';

const envBackup: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'LLM_MIN_INTERVAL_MS',
  'LLM_MAX_CONCURRENCY',
  'LLM_MAX_WAIT_MS',
  'LLM_MAX_COOLDOWN_MS',
  'LLM_OUTAGE_THRESHOLD',
  'LLM_RUN_BUDGET_MS'
];

function quietGovernor() {
  for (const k of ENV_KEYS) {
    if (!(k in envBackup)) envBackup[k] = process.env[k];
  }
  process.env.LLM_MIN_INTERVAL_MS = '0';
  process.env.LLM_MAX_CONCURRENCY = '4';
  process.env.LLM_MAX_WAIT_MS = '5000';
  process.env.LLM_MAX_COOLDOWN_MS = '60000';
  process.env.LLM_OUTAGE_THRESHOLD = '3';
  process.env.LLM_RUN_BUDGET_MS = '0';
}

before(quietGovernor);
beforeEach(() => {
  quietGovernor();
  _resetGovernor();
});
after(() => {
  for (const k of ENV_KEYS) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
});

describe('parseRetryAfterMs — providers already tell us how long to wait', () => {
  it('reads a delta-seconds Retry-After header', () => {
    assert.equal(parseRetryAfterMs({ header: '27' }), 27_000);
    assert.equal(parseRetryAfterMs({ header: ' 4 ' }), 4_000);
  });

  it('reads an HTTP-date Retry-After header', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const header = new Date(now + 15_000).toUTCString();
    const ms = parseRetryAfterMs({ header, now });
    assert.ok(ms != null && ms > 9_000 && ms <= 16_000, `got ${ms}`);
  });

  it('reads JSON and prose hints from OpenRouter / NVIDIA / Gemini bodies', () => {
    assert.equal(parseRetryAfterMs({ body: '{"error":{"retry_after":12}}' }), 12_000);
    assert.equal(parseRetryAfterMs({ body: 'Too Many Requests. Please try again in 45 seconds.' }), 45_000);
    assert.equal(parseRetryAfterMs({ body: '{"x-ratelimit-reset-requests":"1.234"}' }), 1234);
    assert.equal(parseRetryAfterMs({ body: 'quota resets in 30s' }), 30_000);
  });

  it('returns null (not a guess) when the API said nothing — the exact NVIDIA body from the outage', () => {
    assert.equal(parseRetryAfterMs({ body: '{"status":429,"title":"Too Many Requests"}' }), null);
    assert.equal(parseRetryAfterMs({}), null);
  });

  it('picks the shortest of several hints and never goes negative', () => {
    assert.equal(parseRetryAfterMs({ header: '30', body: 'retry_after":3' }), 3_000);
    assert.equal(parseRetryAfterMs({ header: '0' }), 0);
  });
});

describe('cooldown policy', () => {
  it('escalates exponentially when the provider gives no hint', () => {
    assert.equal(fallbackBackoffMs(1), 4_000);
    assert.equal(fallbackBackoffMs(2), 8_000);
    assert.equal(fallbackBackoffMs(3), 16_000);
  });

  it('honours the provider hint and clamps to the configured ceiling', () => {
    const applied = noteRateLimit('nvidia', 21_000);
    assert.equal(applied, 21_000);
    process.env.LLM_MAX_COOLDOWN_MS = '5000';
    assert.equal(noteRateLimit('nvidia', 3_600_000), 5_000);
  });

  it('never lets a cooldown go backwards on a later 429', () => {
    noteRateLimit('openrouter', 30_000);
    const first = stateFor('openrouter').cooldownUntil;
    noteRateLimit('openrouter', 1_000);
    assert.ok(stateFor('openrouter').cooldownUntil >= first);
    assert.ok(cooldownRemainingMs('openrouter') > 20_000);
  });

  it('a success clears strikes and closes the breaker', () => {
    process.env.LLM_OUTAGE_THRESHOLD = '2';
    noteRateLimit('nvidia', 1_000);
    noteRateLimit('nvidia', 1_000);
    assert.equal(isOutageOpen(), true);
    noteSuccess('nvidia');
    assert.equal(isOutageOpen(), false);
    assert.equal(stateFor('nvidia').strikes, 0);
    assert.equal(cooldownRemainingMs('nvidia'), 0);
    assert.match(outageInfo().reason, /recovered via nvidia/);
  });

  it('counts each provider independently so one dead key cannot mute a healthy one', () => {
    process.env.LLM_OUTAGE_THRESHOLD = '5';
    noteRateLimit('nvidia', 5_000);
    noteRateLimit('nvidia', 5_000);
    assert.equal(shouldSkipProvider('nvidia').skip, false);
    assert.equal(stateFor('nvidia').strikes, 2);
    assert.equal(stateFor('openrouter').strikes, 0);
    // strikes >= threshold + 2 (i.e. 7) trips the per-provider breaker; openrouter stays usable
    for (let i = 0; i < 4; i++) noteRateLimit('nvidia', 5_000);
    assert.equal(stateFor('nvidia').strikes, 6);
    assert.equal(shouldSkipProvider('nvidia').skip, false);
    noteRateLimit('nvidia', 5_000);
    assert.match(shouldSkipProvider('nvidia').reason, /PROVIDER_BREAKER_OPEN/);
    assert.equal(shouldSkipProvider('openrouter').skip, false);
  });

  it('a rejected API key parks the provider instead of retrying it 10 times', () => {
    noteFailure('nvidia', 'AUTH', '{"status":401,"title":"Unauthorized"}');
    const verdict = shouldSkipProvider('nvidia');
    assert.equal(verdict.skip, true);
    assert.match(verdict.reason, /^COOLDOWN_/);
  });
});

describe('outage breaker', () => {
  it('opens after the configured consecutive failures and reports why', () => {
    process.env.LLM_OUTAGE_THRESHOLD = '2';
    noteRateLimit('nvidia', 1_000);
    assert.equal(isOutageOpen(), false);
    noteRateLimit('nvidia', 1_000);
    assert.equal(isOutageOpen(), true);
    assert.match(outageInfo().reason, /nvidia rate limited 2x in a row/);
  });

  it('timeouts count too — a wedged provider is as useless as a 429', () => {
    process.env.LLM_OUTAGE_THRESHOLD = '2';
    noteFailure('gemini', 'TIMEOUT');
    noteFailure('gemini', 'TIMEOUT');
    assert.equal(isOutageOpen(), true);
    assert.match(outageInfo().reason, /gemini: TIMEOUT/);
  });
});

describe('run budget', () => {
  it('bounds the whole run so the UI cannot hang past maxDuration', async () => {
    beginRun(30);
    assert.ok(budgetRemainingMs() <= 30);
    assert.equal(isRunBudgetExhausted(), false);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(isRunBudgetExhausted(), true);
    assert.equal(shouldSkipProvider('nvidia').reason, 'LLM_RUN_BUDGET_EXHAUSTED');
  });

  it('beginRun clears a stale breaker so a fixed key gets a clean probe', () => {
    process.env.LLM_OUTAGE_THRESHOLD = '1';
    noteRateLimit('nvidia', 1_000);
    assert.equal(isOutageOpen(), true);
    beginRun(0);
    assert.equal(isOutageOpen(), false);
    assert.equal(stateFor('nvidia').strikes, 0, 'strikes are per-run so a recovered key gets a real probe');
    assert.ok(cooldownRemainingMs('nvidia') > 0, 'the active cooldown is still respected');
  });
});

describe('acquireSlot pacing', () => {
  it('enforces the minimum gap between two outbound requests', async () => {
    process.env.LLM_MIN_INTERVAL_MS = '120';
    _resetGovernor();
    beginRun(0);
    const a = await acquireSlot('nvidia');
    a.release();
    const t0 = Date.now();
    const b = await acquireSlot('nvidia');
    b.release();
    assert.ok(Date.now() - t0 >= 100, `second request waited only ${Date.now() - t0}ms`);
  });

  it('serialises on the concurrency gate instead of stampeding', async () => {
    process.env.LLM_MAX_CONCURRENCY = '1';
    process.env.LLM_MIN_INTERVAL_MS = '0';
    _resetGovernor();
    beginRun(0);
    const held = await acquireSlot('nvidia');
    let entered = false;
    const second = acquireSlot('nvidia').then((lease) => {
      entered = true;
      lease.release();
      return lease;
    });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(entered, false, 'second request jumped the queue');
    held.release();
    await second;
    assert.equal(entered, true);
    assert.equal(snapshot().inFlight, 0);
  });

  it('gives up instead of sleeping through a window longer than its patience', async () => {
    _resetGovernor();
    beginRun(0);
    noteRateLimit('nvidia', 40_000);
    process.env.LLM_MAX_WAIT_MS = '80';
    const lease = await acquireSlot('nvidia', 80);
    assert.equal(lease.expired, true);
    lease.release();
  });

  it('a patient canary waits out a short free-tier reset', async () => {
    _resetGovernor();
    beginRun(0);
    noteRateLimit('nvidia', 120);
    const t0 = Date.now();
    const lease = await acquireSlot('nvidia', 2_000);
    lease.release();
    assert.equal(lease.expired, false);
    assert.ok(Date.now() - t0 >= 100, 'canary did not wait for the reset');
  });
});
