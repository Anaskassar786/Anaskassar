import { NextResponse } from 'next/server';
import { fetchFredMacroData, fetchMarketNews, fetchTwelveData } from '@/lib/data/ingestion';
import { appendHealthLog, listHealthLogs } from '@/lib/db/store';

export const dynamic = 'force-dynamic';

export async function GET() {
  const started = Date.now();
  const [market, macro, news] = await Promise.all([
    fetchTwelveData('XAU/USD', '4h'),
    fetchFredMacroData('FEDFUNDS'),
    fetchMarketNews('gold Fed')
  ]);

  const probes = [
    {
      provider_name: 'Twelve Data',
      endpoint_tested: 'time_series XAU/USD 4h',
      status: (market.status === 'SUCCESS' ? 'PASS' : 'FAIL') as 'PASS' | 'FAIL',
      latency_ms: Date.now() - started,
      error_message: market.error
    },
    {
      provider_name: 'FRED',
      endpoint_tested: 'series/observations FEDFUNDS',
      status: (macro.status === 'SUCCESS' ? 'PASS' : 'FAIL') as 'PASS' | 'FAIL',
      latency_ms: Date.now() - started,
      error_message: macro.error
    },
    {
      provider_name: 'News API',
      endpoint_tested: 'v2/everything gold Fed',
      status: (news.status === 'SUCCESS' ? 'PASS' : 'FAIL') as 'PASS' | 'FAIL',
      latency_ms: Date.now() - started,
      error_message: news.error
    },
    {
      provider_name: 'OpenRouter',
      endpoint_tested: 'env OPENROUTER_API_KEY',
      status: (process.env.OPENROUTER_API_KEY ? 'PASS' : 'FAIL') as 'PASS' | 'FAIL',
      latency_ms: 0,
      error_message: process.env.OPENROUTER_API_KEY ? undefined : 'API_KEY_MISSING'
    },
    {
      provider_name: 'NVIDIA',
      endpoint_tested: 'env NVIDIA_API_KEY',
      status: (process.env.NVIDIA_API_KEY ? 'PASS' : 'FAIL') as 'PASS' | 'FAIL',
      latency_ms: 0,
      error_message: process.env.NVIDIA_API_KEY ? undefined : 'API_KEY_MISSING'
    }
  ];

  for (const p of probes) {
    await appendHealthLog(p);
  }

  const history = await listHealthLogs();
  return NextResponse.json({
    mode: 'NO-FAKE-DATA STRICT',
    execution: 'DISABLED',
    probes,
    history: history.slice(0, 20)
  });
}
