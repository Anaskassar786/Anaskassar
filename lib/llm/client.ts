import { extractJsonObject } from '@/lib/llm/json';
import {
  DEFAULT_MAX_TOKENS,
  isCreditError,
  isJsonModeError,
  isPermanentLlmError,
  isRateLimitError,
  isRetiredModel,
  modelsFor,
  parseAffordableMaxTokens,
  suggestedModelFromError,
  type LlmProvider
} from '@/lib/llm/models';

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
}

export interface ChatResult {
  content: string;
  provider: string;
  model: string;
}

function env(name: string, fallback = ''): string {
  return process.env[name] || fallback;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function httpError(status: number, url: string, raw: string, prefix = 'LLM'): Error {
  const snippet = raw.slice(0, 500);
  if (status === 429) {
    return Object.assign(new Error(`RATE_LIMIT:${snippet}`), { status: 429 });
  }
  if (status === 402) {
    return Object.assign(new Error(`CREDITS:${snippet}`), { status: 402 });
  }
  const err = new Error(`${prefix} ${url} ${status}: ${snippet}`);
  (err as Error & { status: number }).status = status;
  return err;
}

/** Per-process cooldowns so a 402/429 is not re-hammered by the next 9 agents. */
const cooldownUntil: Partial<Record<LlmProvider, number>> = {};

export function resetLlmCooldowns() {
  cooldownUntil.openrouter = 0;
  cooldownUntil.nvidia = 0;
  cooldownUntil.gemini = 0;
}

function coolDown(provider: LlmProvider, ms: number) {
  cooldownUntil[provider] = Date.now() + ms;
}

function isCooling(provider: LlmProvider): boolean {
  return Date.now() < (cooldownUntil[provider] || 0);
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
  if (!res.ok) throw httpError(res.status, opts.url, raw);

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
    if (!res.ok) throw httpError(res.status, url, raw, 'Gemini');
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

export async function chatCompletion(req: ChatRequest): Promise<ChatResult> {
  const timeoutMs = req.timeoutMs ?? 60000;
  const order = req.prefer ?? ['openrouter', 'nvidia', 'gemini'];
  const errors: string[] = [];
  const triedModels = new Set<string>();
  const maxTokens = resolveMaxTokens(req.maxTokens);

  for (const provider of order) {
    if (isCooling(provider)) {
      errors.push(`${provider}: cooling down after credits/rate-limit`);
      continue;
    }
    try {
      if (provider === 'openrouter') {
        if (!env('OPENROUTER_API_KEY')) throw new Error('OPENROUTER_API_KEY missing');
        const models = modelsFor('openrouter');
        let last: unknown;
        for (const model of models) {
          if (triedModels.has(`openrouter:${model}`)) continue;
          triedModels.add(`openrouter:${model}`);
          try {
            const content = await openRouterChat(req, model, maxTokens);
            return { content, provider: 'openrouter', model };
          } catch (err) {
            last = err;
            const message = err instanceof Error ? err.message : String(err);
            errors.push(`openrouter/${model}: ${message}`);
            if (isCreditError(message)) {
              const afford = parseAffordableMaxTokens(message);
              const nextCap = afford ? Math.max(256, Math.min(maxTokens, afford - 64)) : Math.min(2048, maxTokens);
              if (nextCap < maxTokens) {
                try {
                  const content = await openRouterChat(req, model, nextCap);
                  return { content, provider: 'openrouter', model };
                } catch (retryErr) {
                  const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                  errors.push(`openrouter/${model}@${nextCap}: ${retryMsg}`);
                  last = retryErr;
                  if (isCreditError(retryMsg)) {
                    coolDown('openrouter', 120_000);
                    break;
                  }
                }
              } else {
                coolDown('openrouter', 120_000);
                break;
              }
            }
            if (isRateLimitError(message)) {
              coolDown('openrouter', 45_000);
              await new Promise((r) => setTimeout(r, 1500));
              break;
            }
            if (isPermanentLlmError(message)) continue;
          }
        }
        if (last) throw last;
        throw new Error('No OpenRouter models configured');
      }

      if (provider === 'nvidia') {
        const key = env('NVIDIA_API_KEY');
        if (!key) throw new Error('NVIDIA_API_KEY missing');
        const models = modelsFor('nvidia');
        let last: unknown;
        for (const model of models) {
          if (triedModels.has(`nvidia:${model}`)) continue;
          triedModels.add(`nvidia:${model}`);
          try {
            const content = await callOpenAICompatible({
              url: `${env('NVIDIA_BASE_URL', 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '')}/chat/completions`,
              apiKey: key,
              model,
              messages: req.messages,
              json: false,
              temperature: req.temperature,
              timeoutMs,
              maxTokens
            });
            return { content, provider: 'nvidia', model };
          } catch (err) {
            last = err;
            const message = err instanceof Error ? err.message : String(err);
            errors.push(`nvidia/${model}: ${message}`);
            if (isRateLimitError(message)) {
              coolDown('nvidia', 45_000);
              await new Promise((r) => setTimeout(r, 1500));
              break;
            }
          }
        }
        if (last) throw last;
        throw new Error('No NVIDIA models configured');
      }

      if (provider === 'gemini') {
        if (!env('GEMINI_API_KEY')) throw new Error('GEMINI_API_KEY missing');
        const models = modelsFor('gemini');
        let last: unknown;
        for (const model of models) {
          if (triedModels.has(`gemini:${model}`)) continue;
          triedModels.add(`gemini:${model}`);
          try {
            const content = await callGeminiModel({ ...req, maxTokens }, model);
            return { content, provider: 'gemini', model };
          } catch (err) {
            last = err;
            const message = err instanceof Error ? err.message : String(err);
            errors.push(`gemini/${model}: ${message}`);
            const suggested = suggestedModelFromError(message);
            if (suggested && !isRetiredModel(suggested) && !triedModels.has(`gemini:${suggested}`)) {
              models.push(suggested);
            }
            if (isRateLimitError(message)) {
              coolDown('gemini', 60_000);
              await new Promise((r) => setTimeout(r, 1500));
              break;
            }
          }
        }
        if (last) throw last;
        throw new Error('No Gemini models configured');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!errors.some((e) => e.startsWith(`${provider}:`) || e.startsWith(`${provider}/`))) {
        errors.push(`${provider}: ${message}`);
      }
      if (isRateLimitError(message)) {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }

  throw new Error(`All LLM providers failed. ${errors.join(' | ')}`);
}

export async function chatJson<T = unknown>(req: ChatRequest): Promise<{ data: T } & ChatResult> {
  const result = await chatCompletion({ ...req, json: true });
  const data = extractJsonObject(result.content) as T;
  return { ...result, data };
}

export { isCreditError, isPermanentLlmError, isRateLimitError, modelsFor };
