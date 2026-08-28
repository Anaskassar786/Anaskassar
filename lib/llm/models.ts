/**
 * Live model catalogs + dead-id filters.
 *
 * Gemini 2.0 Flash was retired. Google now returns 404 and tells callers to
 * use gemini-3.6-flash. OpenRouter similarly has no endpoints for
 * google/gemini-2.0-flash-001. Env defaults may still point at the dead ids —
 * those are skipped and the next catalog entry is tried.
 */

export type LlmProvider = 'openrouter' | 'nvidia' | 'gemini';

/** Why a call failed — drives retry vs stop, and what the terminal tells you to fix. */
export type LlmErrorClass =
  | 'RATE_LIMIT'
  | 'CREDITS'
  | 'AUTH'
  | 'MISSING_KEY'
  | 'MODEL_NOT_FOUND'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'UPSTREAM'
  | 'EMPTY'
  | 'CLIENT'
  | 'UNKNOWN';

/** Model ids known to 404 / "no longer available". Never call these. */
export const RETIRED_MODEL_IDS = new Set(
  [
    'google/gemini-2.0-flash-001',
    'google/gemini-2.0-flash',
    'google/gemini-2.0-flash-lite',
    'google/gemini-2.0-flash-lite-001',
    'gemini-2.0-flash',
    'gemini-2.0-flash-001',
    'gemini-2.0-flash-lite',
    'gemini-2.0-flash-lite-001',
    'models/gemini-2.0-flash',
    'models/gemini-2.0-flash-001'
  ].map((s) => s.toLowerCase())
);

const OPENROUTER_CATALOG = [
  'google/gemini-3.6-flash',
  'google/gemini-3.5-flash',
  'google/gemini-2.5-flash'
];

const GEMINI_CATALOG = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-flash'];

const NVIDIA_CATALOG = ['minimaxai/minimax-m3'];

function env(name: string, fallback = ''): string {
  return process.env[name] || fallback;
}

function csv(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function unique(items: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const s = (item || '').trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s.replace(/^models\//, ''));
  }
  return out;
}

export function isRetiredModel(model: string): boolean {
  return RETIRED_MODEL_IDS.has(model.trim().toLowerCase()) || RETIRED_MODEL_IDS.has(`models/${model.trim().toLowerCase()}`);
}

const PROVIDERS: LlmProvider[] = ['nvidia', 'openrouter', 'gemini'];

const KEY_ENV: Record<LlmProvider, string> = {
  nvidia: 'NVIDIA_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  gemini: 'GEMINI_API_KEY'
};

export function allProviders(): LlmProvider[] {
  return [...PROVIDERS];
}

export function providerKeyEnv(provider: LlmProvider): string {
  return KEY_ENV[provider];
}

/** True when the provider has a usable key in the environment. */
export function providerHasKey(provider: LlmProvider): boolean {
  return env(KEY_ENV[provider]).trim().length > 0;
}

export function configuredProviders(): LlmProvider[] {
  return PROVIDERS.filter(providerHasKey);
}

/**
 * Failover tail.
 *
 * `LLM_PROVIDER_ORDER=nvidia` used to mean "one key, one model, no way out": a
 * single 429 killed vision, all 10 specialists, the debate and the judge in one
 * go. Now the configured order stays the *preference* and any other provider
 * with a live key is appended as a fallback that is only reached when the
 * preferred one fails. Set `LLM_FAILOVER=off` to restore strict single-provider
 * behaviour (e.g. to keep spend on one account).
 */
export function effectiveProviderOrder(): LlmProvider[] {
  const primary = providerOrder();
  if (env('LLM_FAILOVER', 'on').trim().toLowerCase() === 'off') return primary;
  const tail = configuredProviders().filter((p) => !primary.includes(p));
  return tail.length ? [...primary, ...tail] : primary;
}

/** Strip credentials that some providers (Gemini) carry in the query string. */
export function redactUrl(url: string): string {
  return url
    .replace(/([?&])(key|api[_-]?key|access[_-]?token|token)=([^&]+)/gi, '$1$2=REDACTED')
    .replace(/https?:\/\/[^/@\s]+@/, 'https://REDACTED@');
}

export function modelsFor(provider: LlmProvider): string[] {
  if (provider === 'openrouter') {
    const preferred = unique([
      env('OPENROUTER_DEFAULT_MODEL'),
      ...csv(env('OPENROUTER_FALLBACK_MODELS')),
      ...OPENROUTER_CATALOG
    ]);
    const live = preferred.filter((m) => !isRetiredModel(m));
    return live.length ? live : [...OPENROUTER_CATALOG];
  }

  if (provider === 'gemini') {
    const preferred = unique([
      env('GEMINI_DEFAULT_MODEL'),
      ...csv(env('GEMINI_FALLBACK_MODELS')),
      ...GEMINI_CATALOG
    ]);
    const live = preferred.filter((m) => !isRetiredModel(m));
    return live.length ? live : [...GEMINI_CATALOG];
  }

  const preferred = unique([
    env('NVIDIA_DEFAULT_MODEL'),
    ...csv(env('NVIDIA_FALLBACK_MODELS')),
    ...NVIDIA_CATALOG
  ]);
  const live = preferred.filter((m) => !isRetiredModel(m));
  return live.length ? live : [...NVIDIA_CATALOG];
}

export function defaultModel(provider: LlmProvider): string {
  return modelsFor(provider)[0];
}

/** Pull a replacement model id out of Google's "use models/X" 404 body. */
export function suggestedModelFromError(message: string): string | null {
  const match = message.match(/use models\/([a-zA-Z0-9._-]+)/i);
  if (!match) return null;
  // Providers paste the id inside a sentence ("...to use models/gemini-3.7-flash.")
  // — a trailing dot would produce an id that 404s forever.
  const id = match[1].replace(/^models\//, '').replace(/[._-]+$/, '');
  if (!id || isRetiredModel(id)) return null;
  return id;
}

export function isPermanentLlmError(message: string): boolean {
  const cls = classifyLlmError(message);
  return cls === 'AUTH' || cls === 'MISSING_KEY' || cls === 'MODEL_NOT_FOUND' || cls === 'CREDITS';
}

/**
 * Single source of truth for "why did this call fail", used by the governor
 * (retry vs stop), the runner (OFFLINE labelling) and the terminal (what the
 * operator must actually fix). Substring checks are written against real
 * provider bodies: NVIDIA NIM answers 429/401 with `{"status":401,"title":"..."}`
 * rather than an OpenAI-shaped `{"error":{"code":...}}`.
 */
export function classifyLlmError(message: string): LlmErrorClass {
  const m = (message || '').toLowerCase();
  if (!m.trim()) return 'UNKNOWN';

  if (m.includes('api_key missing') || m.includes('api key missing') || m.includes('api_keymissing')) return 'MISSING_KEY';
  if (isRateLimitError(m)) return 'RATE_LIMIT';
  if (isCreditError(m)) return 'CREDITS';
  if (
    m.includes(' 401') ||
    m.includes('401:') ||
    m.includes('"status":401') ||
    m.includes('"code":401') ||
    m.includes(' 403') ||
    m.includes('403:') ||
    m.includes('"status":403') ||
    m.includes('invalid api key') ||
    m.includes('incorrect api key') ||
    m.includes('unauthorized') ||
    m.includes('permission denied') ||
    m.includes('invalid_token')
  ) {
    return 'AUTH';
  }
  if (
    m.includes(' 404') ||
    m.includes('404:') ||
    m.includes('"status":404') ||
    m.includes('"code":404') ||
    m.includes('no endpoints found') ||
    m.includes('no longer available') ||
    m.includes('not found for model') ||
    m.includes('model is not supported')
  ) {
    return 'MODEL_NOT_FOUND';
  }
  if (m.includes('aborted') || m.includes('timeout') || m.includes('timed out') || m.includes('etimedout')) return 'TIMEOUT';
  if (
    m.includes('empty llm content') ||
    m.includes('empty gemini content') ||
    m.includes('empty model response') ||
    m.includes('no json object found')
  ) {
    return 'EMPTY';
  }
  if (m.includes('fetch failed') || m.includes('enotfound') || m.includes('econnrefused') || m.includes('network')) {
    return 'NETWORK';
  }
  const upstream = m.match(/(?: 5\d\d:|"status":(5\d\d)|"code":(5\d\d))/);
  if (upstream) return 'UPSTREAM';
  if (m.includes('client') && m.includes(' 4')) return 'CLIENT';
  return 'UNKNOWN';
}

/** Worth another attempt (after backing off) inside the same run? */
export function isRetryableLlmError(message: string): boolean {
  const cls = classifyLlmError(message);
  return cls === 'RATE_LIMIT' || cls === 'TIMEOUT' || cls === 'NETWORK' || cls === 'UPSTREAM' || cls === 'EMPTY';
}

export function isRateLimitError(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes('rate_limit') || m.includes('429') || m.includes('too many requests') || m.includes('quota exceeded');
}

export function isCreditError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('credits:') ||
    m.includes(' 402') ||
    m.includes('402:') ||
    m.includes('"code":402') ||
    m.includes('requires more credits') ||
    m.includes('can only afford') ||
    m.includes('insufficient credits') ||
    m.includes('upgrade to a paid account')
  );
}

/** OpenRouter 402 often says: "can only afford 8819". */
export function parseAffordableMaxTokens(message: string): number | null {
  const match = message.match(/can only afford\s+(\d+)/i);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export const DEFAULT_MAX_TOKENS = 4096;

/**
 * Preferred order only — see `effectiveProviderOrder()` for what the client
 * actually walks (preference + failover tail of any other key-backed provider).
 */
export function providerOrder(): LlmProvider[] {
  const raw = unique(csv(env('LLM_PROVIDER_ORDER', 'nvidia')));
  const parsed = raw.filter((p): p is LlmProvider => (PROVIDERS as string[]).includes(p));
  return parsed.length ? parsed : ['nvidia'];
}

export function isJsonModeError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('response_format') ||
    m.includes('json_object') ||
    m.includes('response_mime_type') ||
    m.includes('responsemimetype') ||
    m.includes('structured output')
  );
}
