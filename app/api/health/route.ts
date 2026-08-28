import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { fetchFredMacroData, fetchMarketNews, fetchTwelveData } from '@/lib/data/ingestion';
import { appendHealthLog, listHealthLogs } from '@/lib/db/store';
import {
  configuredProviders,
  effectiveProviderOrder,
  modelsFor,
  providerHasKey,
  providerKeyEnv,
  providerOrder
} from '@/lib/llm/models';
import { outageInfo, runBudgetMs, snapshot as governorSnapshot } from '@/lib/llm/rate-limit';
import { probeProvider } from '@/lib/llm/client';

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

export async function GET(req: Request) {
  const searchParams = new URL(req.url).searchParams;
  const started = Date.now();
  const probesExtra: Probe[] = [];

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

  // --- Council capacity: what the governor is currently allowing ---
  const order = effectiveProviderOrder();
  const gov = governorSnapshot();
  const llm = {
    preferred_order: providerOrder(),
    effective_order: order,
    failover: (process.env.LLM_FAILOVER || 'on').toLowerCase() !== 'off',
    key_configured: {
      openrouter: providerHasKey('openrouter'),
      nvidia: providerHasKey('nvidia'),
      gemini: providerHasKey('gemini')
    },
    providers_with_keys: configuredProviders(),
    pacing: {
      min_interval_ms: Number(process.env.LLM_MIN_INTERVAL_MS || 900),
      max_concurrency: Number(process.env.LLM_MAX_CONCURRENCY || 1),
      max_attempts: Number(process.env.LLM_MAX_ATTEMPTS || 3),
      max_wait_ms: Number(process.env.LLM_MAX_WAIT_MS || 90000),
      run_budget_ms: runBudgetMs(),
      image_max_bytes: Number(process.env.LLM_IMAGE_MAX_BYTES || 1500000)
    },
    governor: gov,
    outage: outageInfo(),
    single_provider_risk:
      order.length === 1
        ? `Only ${order[0]} is reachable. A 429 on ${providerKeyEnv(order[0] as 'nvidia')} therefore stops vision, all 10 specialists, the debate and the judge at once. Add OPENROUTER_API_KEY or GEMINI_API_KEY (failover is on) or set LLM_PROVIDER_ORDER=${order[0]},openrouter,gemini.`
        : null
  };

  const probes = [...dataProbes, openrouter, nvidia, gemini, storeProbe];

  // `?probe=1` additionally spends 1 completion token per provider, which is the
  // only way to tell "key is valid" from "key is valid but rate limited right now".
  if (searchParams.get('probe') === '1') {
    const live = await Promise.all(
      configuredProviders().map(async (p) => {
        const res = await probeProvider(p);
        return {
          provider_name: `${p} (1-token probe)`,
          endpoint_tested: `POST chat/completions ${res.model}`,
          status: res.ok ? ('PASS' as const) : ('FAIL' as const),
          latency_ms: Date.now() - started,
          error_message: res.message
        } satisfies Probe;
      })
    );
    probesExtra.push(...live);
  }

  for (const p of [...probes, ...probesExtra]) {
    await appendHealthLog(p);
  }

  const history = await listHealthLogs();
  const fails = probes.filter((p) => p.status === 'FAIL').length;

  return NextResponse.json({
    mode: 'NO-FAKE-DATA STRICT',
    execution: 'DISABLED',
    overall: fails === 0 && order.length > 0 ? 'READY' : 'DEGRADED',
    models: {
      order,
      nvidia: modelsFor('nvidia'),
      openrouter: modelsFor('openrouter'),
      gemini: modelsFor('gemini')
    },
    llm,
    probes: [...probes, ...probesExtra],
    history: history.slice(0, 20)
  });
}
