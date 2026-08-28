import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { executeAgentBatch, type SnapshotPayload } from '@/lib/execution/runner';
import { isOfflineAgent, liveAgentCount, voteCountOf } from '@/lib/execution/offline';
import { _resetGovernor, beginRun } from '@/lib/llm/rate-limit';

const ENV_KEYS = [
  'LLM_PROVIDER_ORDER',
  'LLM_FAILOVER',
  'LLM_MIN_INTERVAL_MS',
  'LLM_MAX_CONCURRENCY',
  'LLM_MAX_WAIT_MS',
  'LLM_MAX_ATTEMPTS',
  'LLM_MAX_COOLDOWN_MS',
  'LLM_RUN_BUDGET_MS',
  'LLM_AGENT_GAP_MS',
  'LLM_IMAGE_MAX_BYTES',
  'LLM_AGENTS_ATTACH_CHART',
  'LLM_AGENT_BATCH_SIZE',
  'LLM_RATE_LIMIT_RECOVERY',
  'LLM_RATE_LIMIT_RECOVERY_MS',
  'NVIDIA_API_KEY',
  'NVIDIA_BASE_URL',
  'NVIDIA_DEFAULT_MODEL'
];
const backup: Record<string, string | undefined> = {};
let realFetch: typeof globalThis.fetch;
let requests: { url: string; body: string }[] = [];

function payload(overrides: Partial<SnapshotPayload> = {}): SnapshotPayload {
  return {
    sessionId: 'sess-test',
    imageBufferBase64: Buffer.from('fake-png').toString('base64'),
    imageMimeType: 'image/png',
    visionMetadata: {
      detected_symbol: 'XAU/USD',
      detected_timeframe: '4h',
      detected_current_price: 4561.609,
      visible_indicators: ['3 EMA'],
      chart_platform: 'TradingView',
      parse_confidence: 90,
      raw_ocr_notes: 'test fixture',
      parse_state: 'LIVE',
      parse_error_class: 'NONE',
      parse_error: '',
      parser_provider: 'nvidia',
      parser_model: 'minimaxai/minimax-m3'
    },
    marketData: {
      provider: 'Twelve Data',
      symbol: 'XAU/USD',
      timeframe: '4h',
      status: 'SUCCESS',
      price: 4561.609,
      candles: [
        { datetime: '2026-08-28', open: '4550', high: '4570', low: '4540', close: '4561', volume: '100' }
      ]
    },
    newsData: { provider: 'News API', status: 'SUCCESS', articles: [{ title: 'Fed holds', source: 'Reuters', publishedAt: '', url: '' }] },
    macroData: { provider: 'FRED', status: 'SUCCESS', seriesId: 'FEDFUNDS', latestValue: '3.63', latestDate: '2026-07-01' },
    riskAmount: 50_000,
    accountBalance: null,
    desiredProfit: null,
    userSymbol: 'XAU/USD',
    userTimeframe: '4h',
    ...overrides
  };
}

function stub(handler: (body: string) => { status: number; payload: unknown }) {
  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const body = String(init?.body ?? '');
    requests.push({ url: String(input), body });
    const res = handler(body);
    return {
      ok: res.status === 200,
      status: res.status,
      headers: { get: () => null },
      text: async () => JSON.stringify(res.payload)
    };
  }) as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
  for (const k of ENV_KEYS) backup[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  requests = [];
  _resetGovernor();
  beginRun(0);
  process.env.LLM_PROVIDER_ORDER = 'nvidia';
  process.env.LLM_FAILOVER = 'off';
  process.env.NVIDIA_API_KEY = 'nvapi-test';
  process.env.NVIDIA_DEFAULT_MODEL = 'minimaxai/minimax-m3';
  process.env.LLM_MIN_INTERVAL_MS = '0';
  process.env.LLM_MAX_CONCURRENCY = '4';
  process.env.LLM_MAX_WAIT_MS = '3000';
  process.env.LLM_MAX_COOLDOWN_MS = '1000';
  process.env.LLM_MAX_ATTEMPTS = '1';
  process.env.LLM_RUN_BUDGET_MS = '0';
  process.env.LLM_AGENT_GAP_MS = '0';
  // Batching + recovery are the production defaults; individual tests opt in.
  process.env.LLM_AGENT_BATCH_SIZE = '1';
  process.env.LLM_RATE_LIMIT_RECOVERY = 'off';
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (backup[k] === undefined) delete process.env[k];
    else process.env[k] = backup[k];
  }
});

describe('executeAgentBatch under a provider outage', () => {
  it('stops after two canary failures instead of firing 10 more doomed requests', async () => {
    stub(() => ({ status: 429, payload: { status: 429, title: 'Too Many Requests' } }));

    const batch = await executeAgentBatch(payload());

    assert.equal(batch.outputs.length, 10, 'every specialist still gets an honest record');
    assert.equal(batch.outputs.every((o) => isOfflineAgent(o)), true);
    assert.equal(liveAgentCount(batch.outputs), 0);
    assert.equal(batch.skippedAgents, 8, '8 agents must be skipped without a request');
    assert.equal(requests.length, 2, `expected exactly 2 network calls, saw ${requests.length}`);
    assert.equal(batch.dominantErrorClass, 'RATE_LIMIT');
    assert.equal(voteCountOf(batch.outputs).noTrade, 0, 'offline agents are NOT NO_TRADE votes');
    assert.equal(voteCountOf(batch.outputs).offline, 10);
    assert.match(batch.outputs[0].evidence[0], /rate limited \(HTTP 429\)/);
    assert.match(batch.outputs[9].evidence[0], /Skipped without a request/);
  });

  it('sends the chart only to the agents that can use it, and none of it while rate limited', async () => {
    stub(() => ({ status: 200, payload: { choices: [{ message: { content: '{"decision":"NO_TRADE","confidence":40,"data_quality":"LOW"}' } }] } }));

    const batch = await executeAgentBatch(payload());
    assert.equal(liveAgentCount(batch.outputs), 10);
    assert.equal(requests.length, 10);
    const withImage = requests.filter((r) => r.body.includes('image_url'));
    assert.equal(withImage.length, 8, 'macro (A8) and news (A9) specialists skip the screenshot');
    assert.equal(batch.dominantErrorClass, 'NONE');
    assert.equal(voteCountOf(batch.outputs).noTrade, 10);
  });

  it('drops an oversized screenshot rather than spending the whole quota on it', async () => {
    process.env.LLM_IMAGE_MAX_BYTES = '10';
    stub(() => ({ status: 200, payload: { choices: [{ message: { content: '{"decision":"BUY","confidence":55,"data_quality":"MEDIUM"}' } }] } }));

    const batch = await executeAgentBatch(payload({ imageBufferBase64: Buffer.from('x'.repeat(400)).toString('base64') }));
    assert.equal(requests.some((r) => r.body.includes('image_url')), false);
    assert.match(batch.batchWarnings.join(' '), /LLM_IMAGE_MAX_BYTES/);
    assert.equal(liveAgentCount(batch.outputs), 10);
  });

  it('keeps going through a per-agent JSON problem — only provider faults trip the breaker', async () => {
    let n = 0;
    stub(() => {
      n += 1;
      if (n <= 2) {
        return { status: 200, payload: { choices: [{ message: { content: 'sorry, no json here' } }] } };
      }
      return { status: 200, payload: { choices: [{ message: { content: '{"decision":"SELL","confidence":61,"data_quality":"MEDIUM"}' } }] } };
    });

    const batch = await executeAgentBatch(payload());
    assert.equal(requests.length, 10, 'a bad answer must not silence the other 8 specialists');
    assert.equal(liveAgentCount(batch.outputs), 8);
    assert.equal(batch.outputs.filter((o) => o.error_class === 'EMPTY').length, 2);
    assert.equal(batch.skippedAgents, 0);
  });

  it('honours the run budget: remaining agents are recorded, not silently dropped', async () => {
    process.env.LLM_RUN_BUDGET_MS = '1';
    beginRun(1); // arm the (already expired) budget for this run
    await new Promise((r) => setTimeout(r, 20));
    stub(() => ({ status: 200, payload: { choices: [{ message: { content: '{"decision":"BUY","confidence":50}' } }] } }));

    const batch = await executeAgentBatch(payload());
    assert.equal(requests.length, 0, 'a dead budget must not hit the network');
    assert.equal(batch.outputs.length, 10);
    assert.equal(batch.skippedAgents, 10);
    assert.match(batch.outputs[0].evidence[0], /LLM_RUN_BUDGET_EXHAUSTED|never ran/);
  });
});

function batchedAnswer(numbers: number[], decision = 'BUY') {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            agents: numbers.map((n) => ({
              agent_number: n,
              decision,
              confidence: 50 + n,
              data_quality: 'MEDIUM',
              evidence: [`agent ${n} evidence`],
              entry_zone: { low: 4500, high: 4510 },
              stop_loss: 4480
            }))
          })
        }
      }
    ]
  };
}

describe('batched council (the free-tier 429 fix)', () => {
  it('runs all 10 specialists in 3 requests instead of 10', async () => {
    process.env.LLM_AGENT_BATCH_SIZE = '5';
    stub((body) => {
      const wanted = [...body.matchAll(/AGENT (\d+) —/g)].map((m) => Number(m[1]));
      return { status: 200, payload: batchedAnswer([...new Set(wanted)]) };
    });

    const batch = await executeAgentBatch(payload());

    // 8 chart-reading specialists (5 + 3) + 1 text-only batch = 3 requests.
    assert.equal(requests.length, 3, `batched council must cost 3 requests, saw ${requests.length}`);
    assert.equal(liveAgentCount(batch.outputs), 10, 'every specialist still produces a live verdict');
    assert.deepEqual(batch.outputs.map((o) => o.agent_number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(voteCountOf(batch.outputs).buy, 10);
    assert.equal(voteCountOf(batch.outputs).offline, 0);
  });

  it('never attaches the screenshot to the macro/news batch', async () => {
    process.env.LLM_AGENT_BATCH_SIZE = '5';
    stub((body) => {
      const wanted = [...body.matchAll(/AGENT (\d+) —/g)].map((m) => Number(m[1]));
      return { status: 200, payload: batchedAnswer([...new Set(wanted)]) };
    });

    await executeAgentBatch(payload());
    const imaged = requests.filter((r) => r.body.includes('image_url'));
    assert.equal(imaged.length, 2, 'only the chart-reading batches carry the image');
    const textOnly = requests.find((r) => !r.body.includes('image_url'));
    assert.ok(textOnly && /AGENT 8 —/.test(textOnly.body) && /AGENT 9 —/.test(textOnly.body));
  });

  it('records a specialist the model forgot as OFFLINE instead of copying a sibling', async () => {
    process.env.LLM_AGENT_BATCH_SIZE = '5';
    stub((body) => {
      const wanted = [...new Set([...body.matchAll(/AGENT (\d+) —/g)].map((m) => Number(m[1])))];
      return { status: 200, payload: batchedAnswer(wanted.filter((n) => n !== 3)) };
    });

    const batch = await executeAgentBatch(payload());
    const a3 = batch.outputs.find((o) => o.agent_number === 3)!;
    assert.equal(a3.execution_state, 'OFFLINE');
    assert.equal(a3.error_class, 'EMPTY');
    assert.equal(a3.stop_loss, null, 'nothing may be back-filled from another specialist');
    assert.equal(liveAgentCount(batch.outputs), 9);
    assert.match(batch.batchWarnings.join(' '), /omitted agent/i);
  });

  it('waits out the quoted Retry-After once and completes the council', async () => {
    process.env.LLM_AGENT_BATCH_SIZE = '5';
    process.env.LLM_RATE_LIMIT_RECOVERY = 'on';
    process.env.LLM_RATE_LIMIT_RECOVERY_MS = '1200';
    process.env.LLM_MAX_COOLDOWN_MS = '50';
    beginRun(60_000);
    let first = true;
    stub((body) => {
      if (first) {
        first = false;
        return { status: 429, payload: { status: 429, title: 'Too Many Requests' } };
      }
      const wanted = [...new Set([...body.matchAll(/AGENT (\d+) —/g)].map((m) => Number(m[1])))];
      return { status: 200, payload: batchedAnswer(wanted, 'SELL') };
    });

    const batch = await executeAgentBatch(payload());

    assert.equal(liveAgentCount(batch.outputs), 10, 'a single 429 must no longer end the run');
    assert.equal(voteCountOf(batch.outputs).sell, 10);
    assert.match(batch.batchWarnings.join(' '), /waited it out once/i);
  });
});
