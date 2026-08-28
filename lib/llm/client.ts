import { extractJsonObject } from '@/lib/llm/json';
import {
  DEFAULT_MAX_TOKENS,
  classifyLlmError,
  effectiveProviderOrder,
  isCreditError,
  isJsonModeError,
  isPermanentLlmError,
  isRateLimitError,
  isRetiredModel,
  isRetryableLlmError,
  modelsFor,
  parseAffordableMaxTokens,
  providerKeyEnv,
  redactUrl,
  suggestedModelFromError,
  type LlmErrorClass,
  type LlmProvider
} from '@/lib/llm/models';
import {
  acquireSlot,
  budgetRemainingMs,
  cooldownRemainingMs,
  maxWaitMs,
  isOutageOpen,
  isRunBudgetExhausted,
  noteFailure,
  noteModelFailure,
  noteRateLimit,
  noteSuccess,
  parseRetryAfterMs,
  resetRateLimits,
  shouldSkipProvider,
  tripOutage
} from '@/lib/llm/rate-limit';


export type ChatMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | {
      role: 'user';
      content: Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      >;
    };

export interface ChatRequest {
  messages: ChatMessage[];
  json?: boolean;
  temperature?: number;
  prefer?: LlmProvider[];
  timeoutMs?: number;
  maxTokens?: number;
  /**
   * Attempts *per provider* for retryable failures (429/timeout/5xx). The wait
   * between attempts is decided by the shared governor, not here, so a whole
   * council cannot stampede a rate-limited key.
   */
  attemptsPerProvider?: number;
  /** Set by the canary agent: keep waiting for Retry-After as long as the run budget allows. */
  patient?: boolean;
}

export interface ChatResult {
  content: string;
  provider: string;
  model: string;
}

export interface LlmFailure {
  provider: string;
  model?: string;
  errorClass: LlmErrorClass;
  message: string;
  retryAfterMs?: number;
}

/**
 * Thrown when every candidate provider was tried and none could answer. Carries
 * structure so the runner/pipeline/UI can tell "the LLM is offline" apart from
 * "the market data is missing" — the difference between an honest NO_TRADE and a
 * silently fabricated one.
 */
export class LlmUnavailableError extends Error {
  readonly code = 'PROVIDER_OUTAGE';
  readonly errorClass: LlmErrorClass;
  readonly failures: LlmFailure[];
  readonly retryAfterMs: number;
  readonly outage: boolean;

  constructor(message: string, failures: LlmFailure[], errorClass: LlmErrorClass, retryAfterMs: number, outage: boolean) {
    super(message);
    this.name = 'LlmUnavailableError';
    this.failures = failures;
    this.errorClass = errorClass;
    this.retryAfterMs = retryAfterMs;
    this.outage = outage;
  }
}

export function isLlmUnavailable(err: unknown): err is LlmUnavailableError {
  return err instanceof LlmUnavailableError || (err as LlmUnavailableError)?.code === 'PROVIDER_OUTAGE';
}

function env(name: string, fallback = ''): string {
  return process.env[name] || fallback;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    // A real timeout surfaces as AbortError; anything else is a transport failure
    // (DNS, refused, TLS). They need different wording or operators chase the
    // wrong fix — "aborted after 45000ms" was reported for a request that died in
    // 3ms because the host could not be resolved at all.
    const where = redactUrl(url);
    const name = err instanceof Error ? err.name : '';
    const msg = err instanceof Error ? err.message : String(err);
    if (name === 'AbortError' || /abort/i.test(msg)) {
      throw new Error(`TIMEOUT: request to ${where} aborted after ${timeoutMs}ms`);
    }
    throw new Error(`LLM network error for ${where}: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Retry-After (seconds or HTTP-date) → ms, plus provider-specific JSON hints. */
function retryAfterFromResponse(res: Response, body: string): number | null {
  return parseRetryAfterMs({ header: res.headers.get('retry-after') || res.headers.get('x-ratelimit-reset'), body });
}

function httpError(status: number, url: string, raw: string, prefix = 'LLM', retryAfterMs: number | null = null): Error {
  // Never echo a query string: Gemini keys ride in `?key=…` and this text ends up
  // persisted in session JSON and rendered in the terminal.
  const snippet = raw.slice(0, 500);
  const where = redactUrl(url);
  const suffix = retryAfterMs && retryAfterMs > 0 ? ` [retry-after:${Math.ceil(retryAfterMs / 1000)}s]` : '';
  if (status === 429) {
    return Object.assign(new Error(`RATE_LIMIT:${snippet}${suffix}`), { status: 429, retryAfterMs: retryAfterMs ?? 0 });
  }
  if (status === 402) {
    return Object.assign(new Error(`CREDITS:${snippet}`), { status: 402, retryAfterMs: 0 });
  }
  const err = new Error(`${prefix} ${where} ${status}: ${snippet}${suffix}`);
  return Object.assign(err, { status, retryAfterMs: retryAfterMs ?? 0 });
}

/** Back-compat shim: the pipeline calls this at the top of a fresh run. */
export function resetLlmCooldowns() {
  resetRateLimits();
}

function resolveMaxTokens(requested?: number): number {
  const fromEnv = Number(process.env.LLM_MAX_TOKENS || '');
  const fallback = Number.isFinite(fromEnv) && fromEnv >= 256 ? fromEnv : DEFAULT_MAX_TOKENS;
  const n = requested ?? fallback;
  return Math.max(256, Math.min(8192, n));
}

async function callOpenAICompatible(opts: {
  url: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  json?: boolean;
  temperature?: number;
  timeoutMs: number;
  maxTokens?: number;
  extraHeaders?: Record<string, string>;
}): Promise<string> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.2,
    // Never omit this — OpenRouter reserves the model's full 65k default and 402s on small balances.
    max_tokens: resolveMaxTokens(opts.maxTokens)
  };
  if (opts.json) {
    body.response_format = { type: 'json_object' };
  }

  const res = await fetchWithTimeout(
    opts.url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        ...opts.extraHeaders
      },
      body: JSON.stringify(body)
    },
    opts.timeoutMs
  );

  const raw = await res.text();
  if (!res.ok) {
    throw httpError(res.status, opts.url, raw, 'LLM', retryAfterFromResponse(res, raw));
  }

  const data = JSON.parse(raw) as {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => c.text || '').join('\n');
  }
  throw new Error('Empty LLM content');
}

async function callOpenAICompatibleWithJsonFallback(opts: Parameters<typeof callOpenAICompatible>[0]): Promise<string> {
  try {
    return await callOpenAICompatible(opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.json && isJsonModeError(message)) {
      return callOpenAICompatible({ ...opts, json: false });
    }
    throw err;
  }
}

function flattenText(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      if (typeof m.content === 'string') return `${m.role.toUpperCase()}:\n${m.content}`;
      return m.content
        .map((part) => (part.type === 'text' ? part.text : '[IMAGE ATTACHED]'))
        .join('\n');
    })
    .join('\n\n');
}

function extractInlineImage(messages: ChatMessage[]): { mime: string; data: string } | null {
  for (const m of messages) {
    if (typeof m.content === 'string') continue;
    for (const part of m.content) {
      if (part.type === 'image_url') {
        const url = part.image_url.url;
        const match = url.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
        if (match) return { mime: match[1], data: match[2] };
      }
    }
  }
  return null;
}

async function callGeminiModel(opts: ChatRequest, model: string): Promise<string> {
  const apiKey = env('GEMINI_API_KEY');
  if (!apiKey) throw new Error('GEMINI_API_KEY missing');

  const system = opts.messages
    .filter((m) => m.role === 'system' && typeof m.content === 'string')
    .map((m) => m.content as string)
    .join('\n');

  const image = extractInlineImage(opts.messages);
  const userText = flattenText(opts.messages.filter((m) => m.role !== 'system'));
  const parts: Array<Record<string, unknown>> = [{ text: [system, userText].filter(Boolean).join('\n\n') }];
  if (image) {
    parts.push({ inline_data: { mime_type: image.mime, data: image.data } });
  }

  const base = env('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
  const url = `${base}/models/${model}:generateContent?key=${apiKey}`;

  const generationConfig: Record<string, unknown> = {
    temperature: opts.temperature ?? 0.2,
    maxOutputTokens: resolveMaxTokens(opts.maxTokens)
  };
  if (opts.json) {
    generationConfig.responseMimeType = 'application/json';
  }

  const post = async (config: Record<string, unknown>) => {
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: config
        })
      },
      opts.timeoutMs ?? 60000
    );
    const raw = await res.text();
    if (!res.ok) throw httpError(res.status, url, raw, 'Gemini', retryAfterFromResponse(res, raw));
    const data = JSON.parse(raw) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('\n') || '';
    if (!text) throw new Error('Empty Gemini content');
    return text;
  };

  try {
    return await post(generationConfig);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.json && isJsonModeError(message)) {
      const rest = { ...generationConfig };
      delete rest.responseMimeType;
      return post(rest);
    }
    throw err;
  }
}

async function openRouterChat(req: ChatRequest, model: string, maxTokens: number): Promise<string> {
  const key = env('OPENROUTER_API_KEY');
  if (!key) throw new Error('OPENROUTER_API_KEY missing');
  return callOpenAICompatibleWithJsonFallback({
    url: `${env('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1').replace(/\/$/, '')}/chat/completions`,
    apiKey: key,
    model,
    messages: req.messages,
    json: req.json,
    temperature: req.temperature,
    timeoutMs: req.timeoutMs ?? 60000,
    maxTokens,
    extraHeaders: {
      'HTTP-Referer': env('NEXT_PUBLIC_APP_URL', 'http://localhost:3000'),
      'X-Title': 'Trading AI AK'
    }
  });
}

async function nvidiaChat(req: ChatRequest, model: string, maxTokens: number): Promise<string> {
  const key = env('NVIDIA_API_KEY');
  if (!key) throw new Error('NVIDIA_API_KEY missing');
  return callOpenAICompatible({
    url: `${env('NVIDIA_BASE_URL', 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '')}/chat/completions`,
    apiKey: key,
    model,
    messages: req.messages,
    // NIM's minimax endpoint rejects response_format; prompt-level JSON only.
    json: false,
    temperature: req.temperature,
    timeoutMs: req.timeoutMs ?? 60000,
    maxTokens
  });
}

interface ProviderOutcome {
  ok: true;
  result: ChatResult;
}
interface ProviderFailureOutcome {
  ok: false;
  failures: LlmFailure[];
}

/** Non-patient callers (health probes, debate) will not sit in a 429 backoff. */
const FAST_WAIT_MS = 15_000;

function attemptsPerProvider(req: ChatRequest): number {
  const fromEnv = Number(env('LLM_MAX_ATTEMPTS', '') || '');
  const base = Number.isFinite(fromEnv) && fromEnv >= 1 ? Math.min(fromEnv, 6) : 3;
  return Math.max(1, Math.min(req.attemptsPerProvider ?? base, 6));
}

/**
 * One provider, its model catalogue, a bounded number of attempts, and the
 * governor deciding how long we may wait. Rate limits back off and retry the
 * same model (they are per key, not per model); a 404 walks to the next model.
 */
async function runProvider(
  provider: LlmProvider,
  req: ChatRequest,
  maxTokens: number,
  triedModels: Set<string>
): Promise<ProviderOutcome | ProviderFailureOutcome> {
  const models = [...modelsFor(provider)];
  const failures: LlmFailure[] = [];
  const attempts = attemptsPerProvider(req);
  const waitCeiling = req.patient ? maxWaitMs() : FAST_WAIT_MS;

  const bail = () => ({ ok: false as const, failures });

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const key = `${provider}:${model}`;
    if (triedModels.has(key)) continue;
    triedModels.add(key);

    for (let attempt = 0; attempt < attempts; attempt++) {
      const skip = shouldSkipProvider(provider);
      if (skip.skip) {
        failures.push({
          provider,
          model,
          errorClass: skip.reason === 'LLM_RUN_BUDGET_EXHAUSTED' ? 'TIMEOUT' : 'RATE_LIMIT',
          message: skip.reason,
          retryAfterMs: cooldownRemainingMs(provider)
        });
        return bail();
      }

      const slot = await acquireSlot(provider, waitCeiling);
      try {
        if (slot.expired) {
          failures.push({
            provider,
            model,
            errorClass: 'RATE_LIMIT',
            message: `wait budget exhausted; provider still cooling down ${Math.ceil(cooldownRemainingMs(provider) / 1000)}s`,
            retryAfterMs: cooldownRemainingMs(provider)
          });
          return bail();
        }

        let content: string;
        if (provider === 'openrouter') content = await openRouterChat(req, model, maxTokens);
        else if (provider === 'nvidia') content = await nvidiaChat(req, model, maxTokens);
        else content = await callGeminiModel({ ...req, maxTokens }, model);

        noteSuccess(provider);
        return { ok: true, result: { content, provider, model } };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const errorClass = classifyLlmError(message);
        const retryAfterMs = (err as { retryAfterMs?: number })?.retryAfterMs ?? null;
        failures.push({ provider, model, errorClass, message, retryAfterMs: retryAfterMs ?? undefined });

        if (errorClass === 'RATE_LIMIT') {
          const cooldown = noteRateLimit(provider, retryAfterMs, message);
          const canWait = cooldown <= waitCeiling && cooldown <= budgetRemainingMs();
          if (attempt + 1 < attempts && canWait && !isRunBudgetExhausted()) continue;
          return bail();
        }

        // OpenRouter 402 is usually a max_tokens reservation problem, not a real
        // empty balance: try once more with the affordable cap it quotes.
        if (errorClass === 'CREDITS' && provider === 'openrouter') {
          const afford = parseAffordableMaxTokens(message);
          const nextCap = afford ? Math.max(256, Math.min(maxTokens, afford - 64)) : Math.min(2048, maxTokens);
          if (nextCap < maxTokens) {
            try {
              const content = await openRouterChat(req, model, nextCap);
              noteSuccess(provider);
              return { ok: true, result: { content, provider, model } };
            } catch (retryErr) {
              const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
              failures.push({ provider, model: `${model}@${nextCap}`, errorClass: classifyLlmError(retryMsg), message: retryMsg });
            }
          }
          noteFailure(provider, 'CREDITS', message);
          return bail();
        }

        if (errorClass === 'AUTH' || errorClass === 'MISSING_KEY') {
          noteFailure(provider, errorClass, message);
          return bail();
        }

        if (errorClass === 'MODEL_NOT_FOUND') {
          noteModelFailure(provider);
          const suggested = suggestedModelFromError(message);
          if (suggested && !isRetiredModel(suggested) && !models.includes(suggested)) models.push(suggested);
          break; // dead id: move to the next model with a fresh attempt budget
        }

        const transient = errorClass === 'TIMEOUT' || errorClass === 'NETWORK' || errorClass === 'UPSTREAM' || errorClass === 'EMPTY';
        noteFailure(provider, errorClass, message);
        if (transient && attempt + 1 < attempts && !isRunBudgetExhausted() && !isOutageOpen()) continue;
        break;
      } finally {
        slot.release();
      }
    }
  }

  return bail();
}

export async function chatCompletion(req: ChatRequest): Promise<ChatResult> {
  const order = req.prefer?.length ? req.prefer : effectiveProviderOrder();
  const failures: LlmFailure[] = [];
  const triedModels = new Set<string>();

  for (const provider of order) {
    if (!env(providerKeyEnv(provider))) {
      failures.push({ provider, errorClass: 'MISSING_KEY', message: `${providerKeyEnv(provider)} not set` });
      noteFailure(provider, 'MISSING_KEY');
      continue;
    }

    // No global "skip everything because the breaker is open" rule here: a dead
    // primary key must not stop a healthy failover key. The *runner* is what
    // short-circuits the remaining specialists once the outage is confirmed.

    const outcome = await runProvider(provider, req, resolveMaxTokens(req.maxTokens), triedModels);
    if (outcome.ok) return outcome.result;
    failures.push(...outcome.failures);
  }

  if (isRunBudgetExhausted() && !failures.some((f) => f.message.includes('LLM_RUN_BUDGET_EXHAUSTED'))) {
    failures.push({ provider: order[order.length - 1] || 'nvidia', errorClass: 'TIMEOUT', message: 'LLM_RUN_BUDGET_EXHAUSTED' });
  }

  const dominant = dominantErrorClass(failures);
  const retryAfterMs = Math.max(0, ...failures.map((f) => f.retryAfterMs ?? 0));
  const detail = failures
    .map((f) => `${f.provider}${f.model ? `/${f.model}` : ''}: ${f.errorClass} — ${f.message.slice(0, 240)}`)
    .join(' | ');
  throw new LlmUnavailableError(
    `All LLM providers failed${retryAfterMs > 0 ? ` (retry in ~${Math.ceil(retryAfterMs / 1000)}s)` : ''}. ${detail}`,
    failures,
    dominant,
    retryAfterMs,
    isOutageOpen()
  );
}

export function dominantErrorClass(failures: LlmFailure[]): LlmErrorClass {
  const priority: LlmErrorClass[] = [
    'RATE_LIMIT',
    'MISSING_KEY',
    'AUTH',
    'CREDITS',
    'MODEL_NOT_FOUND',
    'TIMEOUT',
    'NETWORK',
    'UPSTREAM',
    'EMPTY',
    'CLIENT',
    'UNKNOWN'
  ];
  for (const cls of priority) {
    if (failures.some((f) => f.errorClass === cls)) return cls;
  }
  return failures[0]?.errorClass ?? 'UNKNOWN';
}

/**
 * Cheap reachability probe used by `/api/health` and the canary: 1 token, so a
 * health check cannot itself eat the quota the council needs.
 */
export async function probeProvider(provider: LlmProvider, model?: string): Promise<{ ok: boolean; model: string; message?: string }> {
  if (!env(providerKeyEnv(provider))) {
    return { ok: false, model: model ?? modelsFor(provider)[0], message: `${providerKeyEnv(provider)} not set` };
  }
  const target = model ?? modelsFor(provider)[0];
  try {
    await (provider === 'openrouter'
      ? openRouterChat({ messages: [{ role: 'user', content: 'Reply with the single word: OK' }], json: false }, target, 256)
      : provider === 'nvidia'
        ? nvidiaChat(
            { messages: [{ role: 'user', content: 'Reply with the single word: OK' }], timeoutMs: 15_000 },
            target,
            256
          )
        : callGeminiModel(
            {
              messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
              timeoutMs: 15_000,
              maxTokens: 256
            },
            target
          ));
    noteSuccess(provider);
    return { ok: true, model: target };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, model: target, message: message.slice(0, 300) };
  }
}

export async function chatJson<T = unknown>(req: ChatRequest): Promise<{ data: T } & ChatResult> {
  const result = await chatCompletion({ ...req, json: true });
  const data = extractJsonObject(result.content) as T;
  return { ...result, data };
}

/** Re-exports so callers (runner, judge, health) need one import site for the
 * classification + governor vocabulary instead of reaching into two modules. */
export {
  isCreditError,
  isPermanentLlmError,
  isRateLimitError,
  isRetryableLlmError,
  classifyLlmError,
  modelsFor,
  budgetRemainingMs,
  tripOutage
};
