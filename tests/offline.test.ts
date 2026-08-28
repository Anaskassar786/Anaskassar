import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  councilOutcome,
  isOfflineAgent,
  liveAgentCount,
  offlineAgentCount,
  offlineEvidence,
  remediationFor,
  runStatusFor,
  shouldSkipRemainingAgents,
  voteCountOf
} from '@/lib/execution/offline';

type Fake = {
  decision?: 'BUY' | 'SELL' | 'NO_TRADE';
  execution_state?: 'LIVE' | 'OFFLINE';
  data_quality?: string;
  provider_used?: string;
  model_used?: string;
};

const live = (decision: 'BUY' | 'SELL' | 'NO_TRADE', data_quality = 'MEDIUM'): Fake => ({
  decision,
  execution_state: 'LIVE',
  data_quality,
  provider_used: 'nvidia',
  model_used: 'minimaxai/minimax-m3'
});

const offline = (): Fake => ({
  decision: 'NO_TRADE',
  execution_state: 'OFFLINE',
  data_quality: 'INSUFFICIENT',
  provider_used: 'none',
  model_used: 'none'
});

describe('isOfflineAgent — "the model never answered" is not "the model said no trade"', () => {
  it('reads execution_state when present', () => {
    assert.equal(isOfflineAgent(offline()), true);
    assert.equal(isOfflineAgent(live('NO_TRADE')), false);
  });

  it('still recognises legacy fallback records written before execution_state existed', () => {
    assert.equal(isOfflineAgent({ provider_used: 'none', model_used: 'fallback' } as Fake), true);
    assert.equal(isOfflineAgent({ model_used: 'none' } as Fake), true);
    assert.equal(isOfflineAgent({ provider_used: 'gemini', model_used: 'gemini-3.6-flash' } as Fake), false);
  });

  it('counts live and offline agents', () => {
    const agents = [live('BUY'), offline(), offline(), live('NO_TRADE', 'HIGH')];
    assert.equal(liveAgentCount(agents), 2);
    assert.equal(offlineAgentCount(agents), 2);
  });
});

describe('voteCountOf — the exact bug from the incident report', () => {
  it('does not turn 10 offline specialists into 10 NO_TRADE votes', () => {
    const votes = voteCountOf(Array.from({ length: 10 }, offline));
    assert.deepEqual(votes, { buy: 0, sell: 0, noTrade: 0, offline: 10 });
  });

  it('counts real opinions and reports the gap separately', () => {
    const votes = voteCountOf([live('BUY'), live('BUY'), live('NO_TRADE'), offline(), offline()]);
    assert.deepEqual(votes, { buy: 2, sell: 0, noTrade: 1, offline: 2 });
  });

  it('a genuine, well-evidenced NO_TRADE from every agent is NOT an outage', () => {
    const all = Array.from({ length: 10 }, () => live('NO_TRADE', 'HIGH'));
    assert.deepEqual(voteCountOf(all), { buy: 0, sell: 0, noTrade: 10, offline: 0 });
    assert.equal(councilOutcome(10, liveAgentCount(all)), 'HEALTHY');
  });
});

describe('councilOutcome + status mapping', () => {
  it('OUTAGE when nothing answered, DEGRADED below half coverage, HEALTHY at half or better', () => {
    assert.equal(councilOutcome(10, 0), 'OUTAGE');
    assert.equal(councilOutcome(10, 4), 'DEGRADED');
    assert.equal(councilOutcome(10, 5), 'HEALTHY');
    assert.equal(councilOutcome(10, 10), 'HEALTHY');
    assert.equal(councilOutcome(0, 0), 'OUTAGE');
  });

  it('an outage outranks a data gap — the fix is "restore a provider", not "wait for candles"', () => {
    assert.equal(runStatusFor({ council: 'OUTAGE', dataUnavailable: true }), 'PROVIDER_OUTAGE');
    assert.equal(runStatusFor({ council: 'OUTAGE', dataUnavailable: false }), 'PROVIDER_OUTAGE');
    assert.equal(runStatusFor({ council: 'HEALTHY', dataUnavailable: true }), 'DATA_UNAVAILABLE');
    assert.equal(runStatusFor({ council: 'DEGRADED', dataUnavailable: false }), 'PARTIAL');
    assert.equal(runStatusFor({ council: 'HEALTHY', dataUnavailable: false }), 'COMPLETED');
  });
});

describe('shouldSkipRemainingAgents — stop hammering, keep honesty', () => {
  it('one provider failure retries; two in a row stops the queue', () => {
    assert.equal(shouldSkipRemainingAgents(1, 'RATE_LIMIT').skip, false);
    assert.equal(shouldSkipRemainingAgents(2, 'RATE_LIMIT').skip, true);
    assert.match(shouldSkipRemainingAgents(2, 'RATE_LIMIT').reason, /rate limited/);
  });

  it('treats dead keys, credit exhaustion and timeouts as provider-side', () => {
    for (const cls of ['AUTH', 'MISSING_KEY', 'CREDITS', 'TIMEOUT', 'NETWORK', 'UPSTREAM'] as const) {
      assert.equal(shouldSkipRemainingAgents(2, cls).skip, true, cls);
    }
  });

  it('never stops the council for a per-agent problem (bad JSON, retired model id)', () => {
    assert.equal(shouldSkipRemainingAgents(5, 'EMPTY').skip, false);
    assert.equal(shouldSkipRemainingAgents(5, 'MODEL_NOT_FOUND').skip, false);
    assert.equal(shouldSkipRemainingAgents(5, 'NONE').skip, false);
  });

  it('the trip threshold is configurable', () => {
    assert.equal(shouldSkipRemainingAgents(3, 'RATE_LIMIT', 4).skip, false);
    assert.equal(shouldSkipRemainingAgents(4, 'RATE_LIMIT', 4).skip, true);
  });
});

describe('offline wording and remediation', () => {
  it('says the specialist never ran — it never claims a trading opinion', () => {
    const { evidence, warning } = offlineEvidence('Execution failed: 429', 'RATE_LIMIT');
    assert.match(evidence, /never ran/);
    assert.match(evidence, /holds no opinion/);
    assert.match(evidence, /429/);
    assert.equal(warning, 'Agent did not run — no vote');
    assert.doesNotMatch(evidence, /\bBUY\b|\bSELL\b/);
  });

  it('missing key is answered with "set a key", not "wait a minute"', () => {
    assert.match(remediationFor('MISSING_KEY', 0, [])[0], /valid API key/);
    assert.match(remediationFor('AUTH', 0, [])[0], /valid API key/);
    assert.match(remediationFor('CREDITS', 0, [])[0], /Top up/);
    assert.match(remediationFor('MODEL_NOT_FOUND', 0, [])[0], /model id/);
  });

  it('rate limits come with the actual wait time, failover advice and a token-budget lever', () => {
    const steps = remediationFor('RATE_LIMIT', 31_000, ['nvidia', 'openrouter']);
    assert.ok(steps.length >= 3);
    assert.match(steps.join('\n'), /~31s/);
    assert.match(steps.join('\n'), /LLM_PROVIDER_ORDER=nvidia, openrouter, gemini|LLM_PROVIDER_ORDER=nvidia,openrouter,gemini/);
    assert.match(steps.join('\n'), /LLM_IMAGE_MAX_EDGE|downscale/);
    assert.match(steps.join('\n'), /LLM_MAX_ATTEMPTS/);
  });
});
