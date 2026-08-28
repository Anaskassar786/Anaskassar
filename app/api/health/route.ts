import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { fetchFredMacroData, fetchMarketNews, fetchTwelveData } from '@/lib/data/ingestion';
import { appendHealthLog, listHealthLogs } from '@/lib/db/store';
import { modelsFor } from '@/lib/llm/models';

export const dynamic = 'force-dynamic';

interface Probe {
  provider_name: string;
  endpoint_tested: string;
  status: 'PASS' | 'FAIL';
  latency_ms: number;
  error_message?: string;
}

/**
 * Real connectivity probe against an OpenAI-compatible /models endpoint.
 * Reports key validity (401/403) distinctly from network failure.
 */
async function probeModelsEndpoint(name: string, url: string, headers?: Record<string, string>): Promise<Probe> {
  const endpoint = 'GET /models (connectivity + key validity)';
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    const latencyMs = Date.now() - t0;
    if (res.ok) {
      return { provider_name: name, endpoint_tested: endpoint, status: 'PASS', latency_ms: latencyMs };
    }
    const detail = res.status === 401 || res.status === 403 ? `invalid/expired key (HTTP ${res.status})` : `HTTP ${res.status}`;
    return { provider_name: name, endpoint_tested: endpoint, status: 'FAIL', latency_ms: latencyMs, error_message: detail };
  } catch (err) {
    return {
      provider_name: name,
      endpoint_tested: endpoint,
      status: 'FAIL',
      latency_ms: Date.now() - t0,
      error_message: err instanceof Error ? err.message : String(err)
    };
  }
}

function missingKeyProbe(name: string): Probe {
  return {
    provider_name: name,
    endpoint_tested: `env ${name.toUpperCase().replace(/_/g, '_')}_API_KEY`,
    status: 'FAIL',
    latency_ms: 0,
    error_message: 'API_KEY_MISSING'
  };
}

export async function GET() {
  const started = Date.now();

  // --- Data feeds: real cheap calls ---
  const [market, macro, news] = await Promise.all([
    fetchTwelveData('XAU/USD', '4h'),
    fetchFredMacroData('FEDFUNDS'),
    fetchMarketNews('gold Fed')
  ]);

  const dataProbes: Probe[] = [
    {
      provider_name: 'Twelve Data',
      endpoint_tested: 'time_series XAU/USD 4h',
      status: market.status === 'SUCCESS' ? 'PASS' : 'FAIL',
      latency_ms: Date.now() - started,
      error_message: market.error
    },
    {
      provider_name: 'FRED',
      endpoint_tested: 'series/observations FEDFUNDS',
      status: macro.status === 'SUCCESS' ? 'PASS' : 'FAIL',
      latency_ms: Date.now() - started,
      error_message: macro.error
    },
    {
      provider_name: 'News API',
      endpoint_tested: 'v2/everything gold Fed',
      status: news.status === 'SUCCESS' ? 'PASS' : 'FAIL',
      latency_ms: Date.now() - started,
      error_message: news.error
    }
  ];

  // --- LLM providers: real connectivity + key validity probes ---
  const [openrouter, nvidia, gemini] = await Promise.all([
    process.env.OPENROUTER_API_KEY
      ? probeModelsEndpoint(
          'OpenRouter',
          `${(process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '')}/models`,
          { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` }
        )
      : Promise.resolve(missingKeyProbe('OPENROUTER')),
    process.env.NVIDIA_API_KEY
      ? probeModelsEndpoint(
          'NVIDIA',
          `${(process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '')}/models`,
          { Authorization: `Bearer ${process.env.NVIDIA_API_KEY}` }
        )
      : Promise.resolve(missingKeyProbe('NVIDIA')),
    process.env.GEMINI_API_KEY
      ? probeModelsEndpoint(
          'Gemini',
          `${(process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '')}/models?key=${process.env.GEMINI_API_KEY}`
        )
      : Promise.resolve(missingKeyProbe('GEMINI'))
  ]);

  // --- File-backed session store probe ---
  let storeProbe: Probe;
  try {
    const dir = path.join(process.cwd(), 'data');
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.write-test-${Date.now()}`);
    await fs.writeFile(tmp, 'ok');
    await fs.rm(tmp);
    storeProbe = { provider_name: 'File Store', endpoint_tested: 'data/ writable', status: 'PASS', latency_ms: 0 };
  } catch (err) {
    storeProbe = {
      provider_name: 'File Store',
      endpoint_tested: 'data/ writable',
      status: 'FAIL',
      latency_ms: 0,
      error_message: err instanceof Error ? err.message : String(err)
    };
  }

  const probes = [...dataProbes, openrouter, nvidia, gemini, storeProbe];

  for (const p of probes) {
    await appendHealthLog(p);
  }

  const history = await listHealthLogs();
  const fails = probes.filter((p) => p.status === 'FAIL').length;

  return NextResponse.json({
    mode: 'NO-FAKE-DATA STRICT',
    execution: 'DISABLED',
    overall: fails === 0 ? 'READY' : 'DEGRADED',
    models: {
      openrouter: modelsFor('openrouter'),
      gemini: modelsFor('gemini'),
      nvidia: modelsFor('nvidia')
    },
    probes,
    history: history.slice(0, 20)
  });
}
