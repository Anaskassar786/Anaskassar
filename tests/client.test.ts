import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { LlmUnavailableError, chatCompletion, chatJson, dominantErrorClass, isLlmUnavailable } from '@/lib/llm/client';
import { _resetGovernor, beginRun, isOutageOpen } from '@/lib/llm/rate-limit';

/**
 * These exercise the real client against a stubbed fetch — the exact code path
 * that produced "All LLM providers failed" for all 10 specialists + vision.
 */

const ENV_KEYS = [
  'LLM_PROVIDER_ORDER',
  'LLM_FAILOVER',
  'LLM_MIN_INTERVAL_MS',
  'LLM_MAX_CONCURRENCY',
  'LLM_MAX_WAIT_MS',
  'LLM_MAX_ATTEMPTS',
  'LLM_RUN_BUDGET_MS',
  'LLM_MAX_TOKENS',
  'NVIDIA_API_KEY',
  'NVIDIA_BASE_URL',
  'NVIDIA_DEFAULT_MODEL',
  'OPENROUTER_API_KEY',
  'OPENROUTER_BASE_URL',
  'OPENROUTER_DEFAULT_MODEL',
  'GEMINI_API_KEY',
  'GEMINI_BASE_URL',
  'GEMINI_DEFAULT_MODEL'
];
const backup: Record<string, string | undefined> = {};

interface Call {
  url: string;
  body: { model?: string; max_tokens?: number; response_format?: unknown } | null;
}
const calls: Call[] = [];
let realFetch: typeof globalThis.fetch;

function jsonResponse(status: number, payload: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? headers[name] ?? null },
    text: async () => JSON.stringify(payload)
  };
}

function openAiReply(content: string) {
  return { choices: [{ message: { content } }] };
}

type Responder = (url: string, index: number) => Promise<{ ok: boolean; status: number; headers: { get: (n: string) => string | null }; text: () => Promise<string> }>;

function stubFetch(respond: Responder) {
  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    let body: Call['body'] = null;
    try {
      body = init?.body ? JSON.parse(init.body) : null;
    } catch {
      body = null;
    }
    calls.push({ url, body });
    return (await respond(url, calls.length - 1)) as never;
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  for (const k of ENV_KEYS) backup[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  calls.length = 0;
  _resetGovernor();
  beginRun(0);
  process.env.LLM_MIN_INTERVAL_MS = '0';
  process.env.LLM_MAX_CONCURRENCY = '4';
  process.env.LLM_MAX_WAIT_MS = '3000';
  process.env.LLM_RUN_BUDGET_MS = '0';
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (backup[k] === undefined) delete process.env[k];
    else process.env[k] = backup[k];
  }
});

const NIM_429 = { status: 429, title: 'Too Many Requests' };

describe('failover: one rate-limited key must not end the run', () => {
  it('walks from a 429ing NVIDIA key to a healthy OpenRouter key', async () => {
    process.env.LLM_PROVIDER_ORDER = 'nvidia';
    process.env.NVIDIA_API_KEY = 'nvapi-live';
    process.env.OPENROUTER_API_KEY = 'sk-or-live';
    process.env.LLM_MAX_ATTEMPTS = '2';

    stubFetch(async (url) => {
      if (url.includes('nvidia')) return jsonResponse(429, NIM_429, { 'retry-after': '1' });
      return jsonResponse(200, openAiReply('{"decision":"BUY","confidence":70}'));
    });

    const res = await chatCompletion({ messages: [{ role: 'user', content: 'analyze' }], json: true });
    assert.equal(res.provider, 'openrouter');
    const nvidiaCalls = calls.filter((c) => c.url.includes('nvidia')).length;
    assert.equal(nvidiaCalls, 2, 'NVIDIA must be retried only up to LLM_MAX_ATTEMPTS, not once per agent');
    // max_tokens is always sent, or OpenRouter reserves 65k and 402s on small balances.
    assert.ok(calls.some((c) => c.url.includes('openrouter') && typeof c.body?.max_tokens === 'number'));
  });

  it('still parses JSON wrapped in prose or code fences', async () => {
    process.env.LLM_PROVIDER_ORDER = 'nvidia';
    process.env.NVIDIA_API_KEY = 'nvapi-live';
    process.env.NVIDIA_DEFAULT_MODEL = 'minimaxai/minimax-m3';
    stubFetch(async () => jsonResponse(200, openAiReply('Sure!\n```json\n{"decision":"sell","confidence":64.5}\n```')));

    const { data, provider } = await chatJson<{ decision: string; confidence: number }>({
      messages: [{ role: 'user', content: 'analyze' }],
      json: true
    });
    assert.equal(provider, 'nvidia');
    assert.equal(String(data.decision).toUpperCase(), 'SELL');
    assert.equal(data.confidence, 64.5);
  });

  it('LLM_FAILOVER=off keeps the failure strictly inside the configured provider', async () => {
    process.env.LLM_PROVIDER_ORDER = 'nvidia';
    process.env.NVIDIA_API_KEY = 'nvapi-live';
    process.env.OPENROUTER_API_KEY = 'sk-or-live';
    process.env.LLM_FAILOVER = 'off';
    process.env.LLM_MAX_ATTEMPTS = '1';

    stubFetch(async (url) => (url.includes('nvidia') ? jsonResponse(429, NIM_429) : jsonResponse(200, openAiReply('{}'))));

    await assert.rejects(
      () => chatCompletion({ messages: [{ role: 'user', content: 'analyze' }] }),
      (err: unknown) => {
        assert.ok(isLlmUnavailable(err));
        const e = err as LlmUnavailableError;
        assert.equal(e.errorClass, 'RATE_LIMIT');
        assert.equal(e.failures.some((f) => f.provider === 'openrouter'), false, 'openrouter must not be tried');
        return true;
      }
    );
  });
});

describe('honest failure payloads', () => {
  it('surfaces the provider error class and retry window instead of a bare "All LLM providers failed"', async () => {
    process.env.LLM_PROVIDER_ORDER = 'nvidia';
    process.env.NVIDIA_API_KEY = 'nvapi-live';
    process.env.LLM_MAX_ATTEMPTS = '1';
    stubFetch(async () => jsonResponse(429, { ...NIM_429, retry_after: 17 }));

    await assert.rejects(
      () => chatCompletion({ messages: [{ role: 'user', content: 'analyze' }], patient: false }),
      (err: unknown) => {
        const e = err as LlmUnavailableError;
        assert.ok(e instanceof LlmUnavailableError);
        assert.equal(e.code, 'PROVIDER_OUTAGE');
        assert.equal(e.errorClass, 'RATE_LIMIT');
        assert.equal(e.retryAfterMs, 17_000);
        assert.match(e.message, /retry in ~17s/);
        assert.match(e.message, /nvidia\/minimaxai\/minimax-m3: RATE_LIMIT/);
        return true;
      }
    );
  });

  it('reports a missing key as MISSING_KEY for every provider rather than "rate limited"', async () => {
    process.env.LLM_PROVIDER_ORDER = 'nvidia,openrouter,gemini';
    stubFetch(async () => jsonResponse(200, openAiReply('{}')));

    await assert.rejects(
      () => chatCompletion({ messages: [{ role: 'user', content: 'analyze' }] }),
      (err: unknown) => {
        const e = err as LlmUnavailableError;
        assert.equal(e.errorClass, 'MISSING_KEY');
        assert.equal(dominantErrorClass(e.failures), 'MISSING_KEY');
        return true;
      }
    );
    assert.equal(calls.length, 0, 'a run without keys must not hit the network');
  });

  it('never leaks an API key that rides in a request URL', async () => {
    process.env.LLM_PROVIDER_ORDER = 'gemini';
    process.env.GEMINI_API_KEY = 'AIzaSECRET-DO-NOT-PERSIST';
    process.env.GEMINI_DEFAULT_MODEL = 'gemini-3.6-flash';
    process.env.LLM_MAX_ATTEMPTS = '1';
    stubFetch(async () => jsonResponse(500, { error: { message: 'backend boom' } }));

    await assert.rejects(
      () => chatCompletion({ messages: [{ role: 'user', content: 'analyze' }] }),
      (err: unknown) => {
        const message = (err as Error).message;
        assert.equal(message.includes('AIzaSECRET-DO-NOT-PERSIST'), false, `key leaked: ${message}`);
        assert.match(message, /key=REDACTED/);
        return true;
      }
    );
  });

  it('the breaker opens when every provider keeps 429ing, so later agents skip fast', async () => {
    process.env.LLM_PROVIDER_ORDER = 'nvidia';
    process.env.NVIDIA_API_KEY = 'nvapi-live';
    process.env.LLM_MAX_ATTEMPTS = '2';
    process.env.LLM_OUTAGE_THRESHOLD = '3';
    process.env.LLM_MAX_COOLDOWN_MS = '1000';
    process.env.LLM_MAX_WAIT_MS = '3000';
    stubFetch(async () => jsonResponse(429, NIM_429));

    // Two calls: first request 429 (strike 1) → backoff → retry 429 (strike 2) → bail.
    await assert.rejects(() => chatCompletion({ messages: [{ role: 'user', content: 'a' }] }));
    const firstRunCalls = calls.length;
    assert.equal(firstRunCalls, 2);

    // A third consecutive failure opens the breaker and the message says so.
    calls.length = 0;
    await assert.rejects(() => chatCompletion({ messages: [{ role: 'user', content: 'a' }] }));
    assert.ok(isOutageOpen(), 'breaker should be open after 3 consecutive rate limits');
    assert.ok(calls.length <= firstRunCalls, 'an open breaker must not send more than one probe');
  });
});

describe('a retired model id must not disable the provider', () => {
  it('walks to the next catalogue model instead of parking the key', async () => {
    process.env.LLM_PROVIDER_ORDER = 'nvidia';
    process.env.NVIDIA_API_KEY = 'nvapi-live';
    process.env.NVIDIA_DEFAULT_MODEL = 'minimaxai/minimax-m3';
    process.env.NVIDIA_FALLBACK_MODELS = 'mistralai/mistral-large';
    process.env.LLM_MAX_ATTEMPTS = '2';

    stubFetch(async (_url, index) =>
      index === 0
        ? jsonResponse(404, { error: { message: 'No endpoints found for minimaxai/minimax-m3' } })
        : jsonResponse(200, openAiReply('{"decision":"NO_TRADE"}'))
    );

    const res = await chatCompletion({ messages: [{ role: 'user', content: 'analyze' }] });
    assert.equal(res.model, 'mistralai/mistral-large');
    assert.equal(calls.length, 2);
    const { shouldSkipProvider } = await import('@/lib/llm/rate-limit');
    assert.equal(shouldSkipProvider('nvidia').skip, false, 'a 404 model must not cool down the whole provider');
  });
});

describe('dominantErrorClass', () => {
  it('prioritises the actionable cause', () => {
    assert.equal(
      dominantErrorClass([
        { provider: 'gemini', errorClass: 'TIMEOUT', message: 'x' },
        { provider: 'nvidia', errorClass: 'RATE_LIMIT', message: 'y' }
      ]),
      'RATE_LIMIT'
    );
    assert.equal(dominantErrorClass([{ provider: 'nvidia', errorClass: 'AUTH', message: 'x' }]), 'AUTH');
    assert.equal(dominantErrorClass([]), 'UNKNOWN');
  });
});
