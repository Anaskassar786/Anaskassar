import { extractJsonObject } from '@/lib/llm/json';

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
  prefer?: Array<'openrouter' | 'nvidia' | 'gemini'>;
  timeoutMs?: number;
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

async function callOpenAICompatible(opts: {
  url: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  json?: boolean;
  temperature?: number;
  timeoutMs: number;
  extraHeaders?: Record<string, string>;
}): Promise<string> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.2
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
  if (res.status === 429) {
    const err = new Error(`RATE_LIMIT:${raw.slice(0, 400)}`);
    (err as Error & { status: number }).status = 429;
    throw err;
  }
  if (!res.ok) {
    throw new Error(`LLM ${opts.url} ${res.status}: ${raw.slice(0, 500)}`);
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

async function callGemini(opts: ChatRequest): Promise<string> {
  const apiKey = env('GEMINI_API_KEY');
  if (!apiKey) throw new Error('GEMINI_API_KEY missing');
  const model = env('GEMINI_DEFAULT_MODEL', 'gemini-2.0-flash');

  const system = opts.messages
    .filter((m) => m.role === 'system' && typeof m.content === 'string')
    .map((m) => m.content as string)
    .join('\n');

  const image = extractInlineImage(opts.messages);
  const parts: Array<Record<string, unknown>> = [{ text: `${system}\n\n${flattenText(opts.messages)}` }];
  if (image) {
    parts.push({ inline_data: { mime_type: image.mime, data: image.data } });
  }

  const url = `${env('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta')}/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          temperature: opts.temperature ?? 0.2,
          responseMimeType: opts.json ? 'application/json' : 'text/plain'
        }
      })
    },
    opts.timeoutMs ?? 60000
  );

  const raw = await res.text();
  if (res.status === 429) {
    const err = new Error(`RATE_LIMIT:${raw.slice(0, 400)}`);
    (err as Error & { status: number }).status = 429;
    throw err;
  }
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${raw.slice(0, 500)}`);

  const data = JSON.parse(raw) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('\n') || '';
  if (!text) throw new Error('Empty Gemini content');
  return text;
}

export async function chatCompletion(req: ChatRequest): Promise<ChatResult> {
  const timeoutMs = req.timeoutMs ?? 60000;
  const order = req.prefer ?? ['openrouter', 'nvidia', 'gemini'];
  const errors: string[] = [];

  for (const provider of order) {
    try {
      if (provider === 'openrouter') {
        const key = env('OPENROUTER_API_KEY');
        if (!key) throw new Error('OPENROUTER_API_KEY missing');
        const model = env('OPENROUTER_DEFAULT_MODEL', 'google/gemini-2.0-flash-001');
        const content = await callOpenAICompatible({
          url: `${env('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1')}/chat/completions`,
          apiKey: key,
          model,
          messages: req.messages,
          json: req.json,
          temperature: req.temperature,
          timeoutMs,
          extraHeaders: {
            'HTTP-Referer': env('NEXT_PUBLIC_APP_URL', 'http://localhost:3000'),
            'X-Title': 'Trading AI AK'
          }
        });
        return { content, provider: 'openrouter', model };
      }

      if (provider === 'nvidia') {
        const key = env('NVIDIA_API_KEY');
        if (!key) throw new Error('NVIDIA_API_KEY missing');
        const model = env('NVIDIA_DEFAULT_MODEL', 'minimaxai/minimax-m3');
        const content = await callOpenAICompatible({
          url: `${env('NVIDIA_BASE_URL', 'https://integrate.api.nvidia.com/v1')}/chat/completions`,
          apiKey: key,
          model,
          messages: req.messages,
          json: false,
          temperature: req.temperature,
          timeoutMs
        });
        return { content, provider: 'nvidia', model };
      }

      if (provider === 'gemini') {
        const model = env('GEMINI_DEFAULT_MODEL', 'gemini-2.0-flash');
        const content = await callGemini(req);
        return { content, provider: 'gemini', model };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${provider}: ${message}`);
      const isRate = message.startsWith('RATE_LIMIT');
      if (isRate) {
        await new Promise((r) => setTimeout(r, 2500));
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
