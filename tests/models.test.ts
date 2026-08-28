import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  classifyLlmError,
  configuredProviders,
  defaultModel,
  effectiveProviderOrder,
  isPermanentLlmError,
  isRateLimitError,
  isRetiredModel,
  isRetryableLlmError,
  modelsFor,
  parseAffordableMaxTokens,
  providerHasKey,
  providerOrder,
  redactUrl,
  suggestedModelFromError
} from '@/lib/llm/models';

const ENV_KEYS = [
  'LLM_PROVIDER_ORDER',
  'LLM_FAILOVER',
  'NVIDIA_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'NVIDIA_DEFAULT_MODEL',
  'NVIDIA_FALLBACK_MODELS',
  'GEMINI_DEFAULT_MODEL',
  'GEMINI_FALLBACK_MODELS',
  'OPENROUTER_DEFAULT_MODEL',
  'OPENROUTER_FALLBACK_MODELS'
];

const backup: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) backup[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (backup[k] === undefined) delete process.env[k];
    else process.env[k] = backup[k];
  }
});

describe('classifyLlmError — measured against real provider bodies', () => {
  it('recognises the NVIDIA NIM 429 shape that killed the whole council', () => {
    const msg = 'RATE_LIMIT:{"status":429,"title":"Too Many Requests"}';
    assert.equal(classifyLlmError(msg), 'RATE_LIMIT');
    assert.equal(isRateLimitError(msg), true);
    assert.equal(isRetryableLlmError(msg), true);
    // A rate limit must never be treated as "this provider is dead forever".
    assert.equal(isPermanentLlmError(msg), false);
  });

  it('recognises OpenRouter credit reservation 402s and extracts the affordable cap', () => {
    const msg = 'LLM https://openrouter.ai/api/v1 402: {"error":{"message":"Key limit: requested up to 65536 tokens, but can only afford 8819"}}';
    assert.equal(classifyLlmError(msg), 'CREDITS');
    assert.equal(parseAffordableMaxTokens(msg), 8819);
  });

  it('recognises auth and missing-key failures (not retryable inside a run)', () => {
    assert.equal(classifyLlmError('{"status":401,"title":"Invalid API key"}'), 'AUTH');
    assert.equal(classifyLlmError('LLM https://api 403: permission denied'), 'AUTH');
    assert.equal(classifyLlmError('NVIDIA_API_KEY missing'), 'MISSING_KEY');
    assert.equal(isRetryableLlmError('NVIDIA_API_KEY missing'), false);
  });

  it('recognises retired models and aborted requests', () => {
    assert.equal(classifyLlmError('Gemini https://generativelanguage.googleapis.com 404: "This model is no longer available"'), 'MODEL_NOT_FOUND');
    assert.equal(classifyLlmError('OpenRouter 400: No endpoints found for google/gemini-2.0-flash'), 'MODEL_NOT_FOUND');
    assert.equal(classifyLlmError('TIMEOUT: request aborted after 55000ms (This operation was aborted)'), 'TIMEOUT');
    assert.equal(classifyLlmError('fetch failed: ENOTFOUND api.nvidia.com'), 'NETWORK');
    assert.equal(classifyLlmError('LLM https://api 503: upstream busy'), 'UPSTREAM');
    assert.equal(classifyLlmError('Empty LLM content'), 'EMPTY');
    assert.equal(classifyLlmError(''), 'UNKNOWN');
  });

  it('classifies the truncated "All providers failed" aggregate as the dominant cause', () => {
    const aggregate =
      'All LLM providers failed. nvidia/minimaxai/minimax-m3: RATE_LIMIT:{"status":429,"title":"Too Many Requests"} [retry-after:31s]';
    assert.equal(classifyLlmError(aggregate), 'RATE_LIMIT');
  });
});

describe('model catalogues', () => {
  it('never calls a retired Gemini id, even when the env still points at one', () => {
    process.env.GEMINI_DEFAULT_MODEL = 'gemini-2.0-flash';
    process.env.GEMINI_FALLBACK_MODELS = 'gemini-2.0-flash-001,gemini-2.5-flash';
    const models = modelsFor('gemini');
    assert.equal(models.includes('gemini-2.0-flash'), false);
    assert.equal(models.includes('gemini-2.0-flash-001'), false);
    assert.equal(models[0], 'gemini-2.5-flash');
    assert.equal(defaultModel('gemini'), 'gemini-2.5-flash');
  });

  it('falls back to the live catalogue when every configured id is dead', () => {
    process.env.OPENROUTER_DEFAULT_MODEL = 'google/gemini-2.0-flash';
    assert.equal(modelsFor('openrouter')[0], 'google/gemini-3.6-flash');
  });

  it('honours env-added NVIDIA fallbacks ahead of the catalogue', () => {
    process.env.NVIDIA_DEFAULT_MODEL = 'minimaxai/minimax-m3';
    process.env.NVIDIA_FALLBACK_MODELS = 'mistralai/mistral-large,nvidia/llama-3.3-nemotron-super-49b-v1';
    assert.deepEqual(modelsFor('nvidia'), [
      'minimaxai/minimax-m3',
      'mistralai/mistral-large',
      'nvidia/llama-3.3-nemotron-super-49b-v1'
    ]);
  });

  it('isRetiredModel tolerates the models/ prefix and casing', () => {
    assert.equal(isRetiredModel('models/gemini-2.0-flash-001'), true);
    assert.equal(isRetiredModel('GEMINI-3.6-flash'), false);
  });

  it('picks the replacement Google suggests in a 404 body, but never a retired one', () => {
    assert.equal(suggestedModelFromError('Please update your code to use models/gemini-3.7-flash.'), 'gemini-3.7-flash');
    assert.equal(suggestedModelFromError('use models/gemini-2.0-flash'), null);
    assert.equal(suggestedModelFromError('nothing useful here'), null);
  });
});

describe('provider order + failover', () => {
  it('keeps the configured preference when no other key exists', () => {
    process.env.NVIDIA_API_KEY = 'nvapi-x';
    process.env.LLM_PROVIDER_ORDER = 'nvidia';
    assert.deepEqual(providerOrder(), ['nvidia']);
    assert.deepEqual(effectiveProviderOrder(), ['nvidia']);
  });

  it('appends any other key-backed provider so one 429 cannot zero the council', () => {
    process.env.NVIDIA_API_KEY = 'nvapi-x';
    process.env.OPENROUTER_API_KEY = 'sk-or-x';
    process.env.LLM_PROVIDER_ORDER = 'nvidia';
    assert.deepEqual(effectiveProviderOrder(), ['nvidia', 'openrouter']);
    assert.deepEqual(configuredProviders(), ['nvidia', 'openrouter']);
  });

  it('LLM_FAILOVER=off restores strict single-provider behaviour', () => {
    process.env.NVIDIA_API_KEY = 'nvapi-x';
    process.env.GEMINI_API_KEY = 'g-x';
    process.env.LLM_PROVIDER_ORDER = 'nvidia';
    process.env.LLM_FAILOVER = 'off';
    assert.deepEqual(effectiveProviderOrder(), ['nvidia']);
  });

  it('drops unknown provider names and whitespace, and never returns an empty order', () => {
    process.env.LLM_PROVIDER_ORDER = ' openai , nvidia ,, ';
    assert.deepEqual(providerOrder(), ['nvidia']);
    process.env.LLM_PROVIDER_ORDER = 'wat';
    assert.deepEqual(providerOrder(), ['nvidia']);
  });

  it('treats a blank key as "not configured"', () => {
    process.env.GEMINI_API_KEY = '   ';
    assert.equal(providerHasKey('gemini'), false);
    process.env.GEMINI_API_KEY = 'g-x';
    assert.equal(providerHasKey('gemini'), true);
  });
});

describe('redactUrl — credentials must not reach session JSON or the browser', () => {
  it('strips the Gemini query key and any userinfo credentials', () => {
    const url =
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=AIzaSECRETSECRET';
    const red = redactUrl(url);
    assert.equal(red.includes('AIzaSECRETSECRET'), false);
    assert.match(red, /key=REDACTED/);
    assert.match(redactUrl('https://user:pw@example.com/v1/x'), /^https:\/\/REDACTED@/);
    assert.equal(redactUrl('https://api.twelvedata.com/time_series?symbol=XAU/USD'), 'https://api.twelvedata.com/time_series?symbol=XAU/USD');
  });
});
