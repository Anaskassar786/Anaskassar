/**
 * Live model catalogs + dead-id filters.
 *
 * Gemini 2.0 Flash was retired. Google now returns 404 and tells callers to
 * use gemini-3.6-flash. OpenRouter similarly has no endpoints for
 * google/gemini-2.0-flash-001. Env defaults may still point at the dead ids —
 * those are skipped and the next catalog entry is tried.
 */

export type LlmProvider = 'openrouter' | 'nvidia' | 'gemini';

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
  const match =
    message.match(/use models\/([a-zA-Z0-9._-]+)/i) ||
    message.match(/update your code to use models\/([a-zA-Z0-9._-]+)/i);
  if (!match) return null;
  const id = match[1].replace(/^models\//, '');
  if (!id || isRetiredModel(id)) return null;
  return id;
}

export function isPermanentLlmError(message: string): boolean {
  const m = message.toLowerCase();
  if (m.includes('rate_limit') || m.includes('429')) return false;
  return (
    m.includes(' 404') ||
    m.includes('404:') ||
    m.includes('"code":404') ||
    m.includes('no endpoints found') ||
    m.includes('no longer available') ||
    m.includes('api_key missing') ||
    m.includes('api key missing') ||
    m.includes(' 401') ||
    m.includes(' 403') ||
    m.includes('invalid api key') ||
    m.includes('incorrect api key')
  );
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

const PROVIDERS: LlmProvider[] = ['nvidia', 'openrouter', 'gemini'];

/**
 * Default is NVIDIA-only (free NIM key). Override with
 * LLM_PROVIDER_ORDER=nvidia,openrouter,gemini if you want failover.
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
