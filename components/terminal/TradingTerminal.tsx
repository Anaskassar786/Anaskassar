'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { downscaleImage } from '@/lib/image/downscale';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Cpu,
  Database,
  Gauge,
  ImageIcon,
  Loader2,
  Newspaper,
  Scale,
  ShieldAlert,
  Upload
} from 'lucide-react';

type Decision = 'BUY' | 'SELL' | 'NO_TRADE';
/**
 * OFFLINE = no model ever answered for that specialist (provider outage / rate
 * limit) — it is not a vote. SKIPPED_* = never sent, to preserve quota.
 */
type AgentStatus = 'IDLE' | 'RUNNING' | 'COMPLETED' | 'OFFLINE' | 'SKIPPED_OUTAGE' | 'SKIPPED_BUDGET' | 'FAILED';

interface AgentOutput {
  agent_number: number;
  agent_name: string;
  decision: Decision;
  confidence: number;
  evidence: string[];
  supporting_factors: string[];
  contradicting_factors: string[];
  entry_zone: { low: number | null; high: number | null };
  stop_loss: number | null;
  take_profit_1: number | null;
  take_profit_2: number | null;
  take_profit_3: number | null;
  risk_reward: number | null;
  invalidation_conditions: string[];
  data_quality: string;
  warnings: string[];
  provider_used?: string;
  model_used?: string;
  execution_state?: 'LIVE' | 'OFFLINE';
  error_class?: string;
  attempts?: number;
  retry_after_ms?: number;
}

interface AnalysisResult {
  success: boolean;
  status?: string;
  details?: string;
  error?: string;
  sessionId: string;
  reusedFrozenSession?: boolean;
  timeframeMismatchWarning: boolean;
  visionMetadata: {
    detected_symbol: string;
    detected_timeframe: string;
    detected_current_price: number | null;
    visible_indicators: string[];
    chart_platform: string;
    parse_confidence: number;
    raw_ocr_notes: string;
    /** LIVE = model answered · OFFLINE = no provider answered · NO_TEXT = nothing legible. */
    parse_state?: 'LIVE' | 'OFFLINE' | 'NO_TEXT';
    parse_error_class?: string;
    parse_error?: string;
    parser_provider?: string;
    parser_model?: string;
    candle_ohlc?: { open: number | null; high: number | null; low: number | null; close: number | null };
  };
  voteDistribution: { buy: number; sell: number; noTrade: number; offline?: number };
  providerDiagnostics?: {
    council_state: 'HEALTHY' | 'DEGRADED' | 'OUTAGE';
    live_agents: number;
    offline_agents: number;
    dominant_error_class: string;
    retry_after_ms: number;
    providers_tried: string[];
    skipped_agents: number;
    remediation: string[];
    run_budget_remaining_ms?: number;
  };
  agentOutputs: AgentOutput[];
  debateResult: {
    voteSummary: { buy: number; sell: number; noTrade: number; offline?: number };
    liveAgents?: number;
    offlineAgents?: number;
    topBullishClaim: { agent: string; claim: string };
    topBearishClaim: { agent: string; claim: string };
    bullCounterargument: string;
    bearCounterargument: string;
    synthesisConclusion: string;
  } | null;
  chiefJudgeVerdict: {
    final_decision: Decision;
    vote_distribution: { buy: number; sell: number; no_trade: number };
    final_confidence: number;
    entry: { low: number | null; high: number | null };
    stop_loss: number | null;
    targets: { tp1: number | null; tp2: number | null; tp3: number | null };
    risk_amount: number;
    position_size: number | null;
    risk_reward: number | null;
    decision_summary: string;
    strongest_bullish_arguments: string[];
    strongest_bearish_arguments: string[];
    rejected_arguments: string[];
    invalidation_conditions: string[];
    warnings: string[];
    data_quality: string;
    chief_judge_model?: string;
    provider_used?: string;
  } | null;
  positionSizingResult: { positionSizeLots: number | null; slDistancePips: number; warning?: string } | null;
  frozenMarketData: { status: string; provider: string; price?: number; error?: string; symbol?: string; timeframe?: string };
  frozenMacroData: { status: string; provider: string; latestValue?: string; latestDate?: string; error?: string; seriesId?: string };
  frozenNewsData: { status: string; provider: string; articles?: Array<{ title: string; source: string; publishedAt: string }>; error?: string };
  screenshotUrl: string;
  outcome?: {
    outcome: string;
    actual_entry?: number | null;
    actual_exit?: number | null;
    actual_pnl?: number | null;
    notes?: string;
    recorded_at: string;
  } | null;
}

interface SessionIndexItem {
  id: string;
  created_at: string;
  user_symbol: string;
  user_timeframe: string;
  detected_symbol: string;
  status: string;
  final_decision: string | null;
}

const AGENT_NAMES = [
  'STRUCTURE',
  'SMC',
  'LIQUIDITY',
  'PRICE ACTION',
  'VOLUME',
  'FVG / S&D',
  'TREND',
  'MACRO',
  'NEWS',
  'RISK'
];

function fmt(n: number | null | undefined, digits = 2): string {
  if (n == null || Number.isNaN(n)) return 'N/A';
  return n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

function decisionTone(d?: string) {
  if (d === 'BUY') return 'buy';
  if (d === 'SELL') return 'sell';
  return 'hold';
}

function toneClasses(tone: string) {
  if (tone === 'buy') return 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300';
  if (tone === 'sell') return 'bg-rose-950/40 border-rose-500/40 text-rose-300';
  if (tone === 'offline') return 'bg-slate-900 border-slate-700 text-slate-400';
  return 'bg-amber-950/40 border-amber-500/40 text-amber-300';
}

export default function TradingTerminal() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [symbol, setSymbol] = useState('XAU/USD');
  const [timeframe, setTimeframe] = useState('4h');
  const [riskAmount, setRiskAmount] = useState('500');
  const [accountBalance, setAccountBalance] = useState('');
  const [desiredProfit, setDesiredProfit] = useState('');
  const [reuseFrozen, setReuseFrozen] = useState(true);
  const [loading, setLoading] = useState(false);
  const [phaseLabel, setPhaseLabel] = useState('');
  const [agentStatus, setAgentStatus] = useState<Record<number, AgentStatus>>({});
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clock, setClock] = useState('');
  const [health, setHealth] = useState<{ ready: boolean; label: string; risk?: string | null }>({ ready: false, label: 'CHECKING' });
  const [sessions, setSessions] = useState<SessionIndexItem[]>([]);
  const [expandedAgent, setExpandedAgent] = useState<number | null>(1);
  const [outcomeForm, setOutcomeForm] = useState({
    outcome: 'WIN',
    actual_entry: '',
    actual_exit: '',
    actual_pnl: '',
    notes: ''
  });
  const [outcomeMsg, setOutcomeMsg] = useState('');
  const [uploadNote, setUploadNote] = useState('');

  useEffect(() => {
    const tick = () =>
      setClock(
        new Date().toLocaleString('en-GB', {
          hour12: false,
          timeZone: 'UTC',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        }) + ' UTC'
      );
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/sessions');
      const data = await res.json();
      setSessions(data.sessions || []);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadSessions();
    fetch('/api/health')
      .then((r) => r.json())
      .then((data) => {
        const probes: { status: string }[] = data.probes || [];
        const fails = probes.filter((p) => p.status === 'FAIL').length;
        const order: string[] = data.models?.order || [];
        setHealth({
          ready: fails === 0,
          label: `${fails === 0 ? `APIs: READY (${probes.length}/${probes.length})` : `APIs: DEGRADED (${probes.length - fails}/${probes.length})`} · LLM: ${order.join(' → ') || 'none'}`,
          risk: data.llm?.single_provider_risk || null
        });
      })
      .catch(() => setHealth({ ready: false, label: 'APIs: UNREACHABLE', risk: null }));
  }, [loadSessions]);

  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const consumeSse = async (res: Response) => {
    if (!res.body) throw new Error('No stream body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const chunks = buf.split('\n\n');
      buf = chunks.pop() || '';
      for (const chunk of chunks) {
        const line = chunk
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.replace(/^data:\s?/, ''))
          .join('');
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.type === 'phase') setPhaseLabel(`PHASE ${event.phase}: ${event.label}`);
        if (event.type === 'agent') {
          const map: Record<string, AgentStatus> = {
            RUNNING: 'RUNNING',
            COMPLETED: 'COMPLETED',
            OFFLINE: 'OFFLINE',
            SKIPPED_OUTAGE: 'SKIPPED_OUTAGE',
            SKIPPED_BUDGET: 'SKIPPED_BUDGET'
          };
          setAgentStatus((prev) => ({
            ...prev,
            [event.agentNumber]: map[event.status] || (event.status === 'COMPLETED' ? 'COMPLETED' : 'RUNNING')
          }));
        }
        if (event.type === 'providers' && event.diagnostics?.council_state === 'OUTAGE') {
          setPhaseLabel('COUNCIL OFFLINE — no request budget was wasted on the remaining specialists');
        }
        if (event.type === 'complete') {
          setResult(event.result);
          setPhaseLabel(event.result.reusedFrozenSession ? 'FROZEN SESSION REPLAYED' : 'COMPLETED');
        }
        if (event.type === 'error') throw new Error(event.message);
      }
    }
  };

  const handleRunAnalysis = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) {
      setError('Upload a TradingView chart screenshot first.');
      return;
    }
    setError(null);
    setOutcomeMsg('');
    setLoading(true);
    setResult(null);
    setPhaseLabel('PHASE 0: Queuing vision engine');
    setAgentStatus(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i + 1, 'IDLE'])) as Record<number, AgentStatus>);

    // Downscale in the browser first: an untouched 4 MB PNG is ~30k vision tokens
    // per call and is the fastest way to trip a provider 429 before the council
    // even starts.
    let payload: File | Blob = file;
    let payloadName = file.name || 'chart.png';
    try {
      setPhaseLabel('PHASE 0: Preparing screenshot');
      const configuredMaxEdge = Number(process.env.NEXT_PUBLIC_LLM_IMAGE_MAX_EDGE || 1400);
      const maxEdge = Number.isFinite(configuredMaxEdge) && configuredMaxEdge >= 640 ? Math.floor(configuredMaxEdge) : 1400;
      const prepared = await downscaleImage(file, file.name || 'chart.png', { maxEdge });
      payload = prepared.blob;
      payloadName = prepared.name;
      setUploadNote(prepared.note);
    } catch {
      setUploadNote('Screenshot sent as uploaded (downscale unavailable in this browser).');
    }

    const formData = new FormData();
    formData.append('screenshot', payload, payloadName);
    formData.append('symbol', symbol);
    formData.append('timeframe', timeframe);
    formData.append('riskAmount', riskAmount);
    if (accountBalance) formData.append('accountBalance', accountBalance);
    if (desiredProfit) formData.append('desiredProfit', desiredProfit);
    formData.append('reuseFrozen', reuseFrozen ? 'true' : 'false');
    formData.append('stream', '1');

    try {
      const res = await fetch('/api/analyze?stream=1', { method: 'POST', body: formData });
      const ctype = res.headers.get('content-type') || '';
      if (ctype.includes('text/event-stream')) {
        await consumeSse(res);
      } else {
        const data = await res.json();
        if (!res.ok) throw new Error(data.details || data.error || 'Analysis failed');
        setResult(data);
        setPhaseLabel(data.reusedFrozenSession ? 'FROZEN SESSION REPLAYED' : 'COMPLETED');
      }
      await loadSessions();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Analysis failed');
    } finally {
      setLoading(false);
    }
  };

  const openSession = async (id: string) => {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/sessions/${id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Session load failed');
      setResult(data);
      setPhaseLabel('FROZEN SESSION LOADED — live APIs not recalled');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Load failed');
    } finally {
      setLoading(false);
    }
  };

  const submitOutcome = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!result?.sessionId) return;
    setOutcomeMsg('');
    try {
      const res = await fetch(`/api/sessions/${result.sessionId}/outcome`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          outcome: outcomeForm.outcome,
          actual_entry: outcomeForm.actual_entry ? Number(outcomeForm.actual_entry) : null,
          actual_exit: outcomeForm.actual_exit ? Number(outcomeForm.actual_exit) : null,
          actual_pnl: outcomeForm.actual_pnl ? Number(outcomeForm.actual_pnl) : null,
          notes: outcomeForm.notes
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Outcome save failed');
      setOutcomeMsg('Outcome stored. Decision rules were not altered.');
      setResult({ ...result, outcome: data.outcome });
    } catch (err: unknown) {
      setOutcomeMsg(err instanceof Error ? err.message : 'Save failed');
    }
  };

  const verdictTone = decisionTone(result?.chiefJudgeVerdict?.final_decision);
  const diag = result?.providerDiagnostics;
  const councilOutage = result?.status === 'PROVIDER_OUTAGE' || diag?.council_state === 'OUTAGE';
  const councilDegraded = diag?.council_state === 'DEGRADED';
  const offlineVotes = result?.voteDistribution?.offline ?? diag?.offline_agents ?? 0;
  const completedAgents = useMemo(
    () => Object.values(agentStatus).filter((s) => s === 'COMPLETED').length,
    [agentStatus]
  );

  return (
    <div className="min-h-screen text-slate-100 p-4 md:p-6">
      <header className="border border-slate-800/80 bg-slate-950/70 backdrop-blur rounded-2xl px-5 py-4 mb-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-emerald-500/15 border border-emerald-400/30 grid place-items-center text-emerald-300 font-black">
              AK
            </div>
            <div>
              <h1 className="text-xl md:text-2xl font-bold tracking-[0.18em] text-emerald-400">TRADING AI AK</h1>
              <p className="text-[11px] text-slate-400 tracking-wide">
                10-AGENT COUNCIL + CHIEF JUDGE · POSITION TRADING DECISION SUPPORT
              </p>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className="bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-full flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full live-dot ${health.ready ? 'bg-emerald-400' : 'bg-amber-400'}`} />
            {health.label}
          </span>
          <span className="bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-full text-slate-400">{clock}</span>
          <span className="bg-slate-900 border border-amber-900/50 px-3 py-1.5 rounded-full text-amber-300">
            MODE: NO-FAKE-DATA STRICT
          </span>
          {health.risk && (
            <span
              title={health.risk}
              className="bg-rose-950/40 border border-rose-800 px-3 py-1.5 rounded-full text-rose-300 cursor-help"
            >
              SINGLE PROVIDER RISK
            </span>
          )}
          <span className="bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-full text-slate-400">
            EXECUTION: DISABLED
          </span>
        </div>
      </header>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-5">
        <aside className="xl:col-span-4 space-y-5">
          <section className="bg-slate-950/80 border border-slate-800 rounded-2xl p-5">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300 border-b border-slate-800 pb-2 mb-4 flex items-center gap-2">
              <Upload size={14} /> New Analysis Parameters
            </h2>
            <form onSubmit={handleRunAnalysis} className="space-y-4">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Chart Screenshot (TradingView)</label>
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                  className="w-full text-xs text-slate-300 bg-slate-950 border border-slate-800 rounded-lg p-2 focus:outline-none focus:border-emerald-500"
                />
                {uploadNote && <p className="text-[10px] text-slate-500 mt-1">{uploadNote}</p>}
                {preview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={preview} alt="Chart preview" className="mt-3 w-full rounded-lg border border-slate-800 max-h-48 object-cover" />
                ) : (
                  <div className="mt-3 h-28 rounded-lg border border-dashed border-slate-800 grid place-items-center text-slate-600 text-[11px]">
                    <span className="flex items-center gap-2">
                      <ImageIcon size={14} /> Drop a 4H / 1D / 15m chart
                    </span>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Symbol">
                  <select
                    value={symbol}
                    onChange={(e) => setSymbol(e.target.value)}
                    className="field"
                  >
                    <option value="XAU/USD">XAU/USD (Gold)</option>
                    <option value="EUR/USD">EUR/USD</option>
                    <option value="GBP/USD">GBP/USD</option>
                    <option value="USD/JPY">USD/JPY</option>
                    <option value="AUD/USD">AUD/USD</option>
                    <option value="USD/CAD">USD/CAD</option>
                  </select>
                </Field>
                <Field label="Timeframe">
                  <select value={timeframe} onChange={(e) => setTimeframe(e.target.value)} className="field">
                    <option value="15m">15M</option>
                    <option value="1h">1H</option>
                    <option value="4h">4H</option>
                    <option value="1d">1D</option>
                    <option value="1w">1W</option>
                  </select>
                </Field>
              </div>

              <Field label="Risk Amount ($)">
                <input type="number" min="1" value={riskAmount} onChange={(e) => setRiskAmount(e.target.value)} className="field" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Account Balance (optional)">
                  <input type="number" value={accountBalance} onChange={(e) => setAccountBalance(e.target.value)} className="field" placeholder="—" />
                </Field>
                <Field label="Desired Profit (optional)">
                  <input type="number" value={desiredProfit} onChange={(e) => setDesiredProfit(e.target.value)} className="field" placeholder="—" />
                </Field>
              </div>

              <label className="flex items-start gap-2 text-[11px] text-slate-400">
                <input
                  type="checkbox"
                  checked={reuseFrozen}
                  onChange={(e) => setReuseFrozen(e.target.checked)}
                  className="mt-0.5 accent-emerald-500"
                />
                Replay frozen session if this screenshot hash already exists (no live API recall). Failed / INSUFFICIENT council runs are never reused.
              </label>

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-emerald-500 hover:bg-emerald-400 disabled:bg-slate-800 disabled:text-slate-500 text-slate-950 font-bold text-xs py-3 rounded-lg uppercase tracking-widest transition-colors flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <Loader2 size={14} className="animate-spin" /> Running Multi-Agent Council
                  </>
                ) : (
                  'Run Analysis'
                )}
              </button>
            </form>
            {error && (
              <p className="mt-3 text-xs text-rose-400 border border-rose-900/50 bg-rose-950/30 rounded-lg p-3">{error}</p>
            )}
            {loading && (
              <div className="mt-4 space-y-3">
                <p className="text-[11px] text-emerald-400 tracking-wide">{phaseLabel}</p>
                <div className="grid grid-cols-5 gap-1.5">
                  {Array.from({ length: 10 }, (_, i) => {
                    const n = i + 1;
                    const st = agentStatus[n] || 'IDLE';
                    const dead = st === 'OFFLINE' || st === 'SKIPPED_OUTAGE' || st === 'SKIPPED_BUDGET';
                    return (
                      <div
                        key={n}
                        title={`A${n} · ${st}`}
                        className={`text-[10px] text-center rounded py-1.5 border ${
                          st === 'COMPLETED'
                            ? 'border-emerald-700 bg-emerald-950/50 text-emerald-300'
                            : st === 'RUNNING'
                              ? 'border-amber-700 bg-amber-950/40 text-amber-300'
                              : dead
                                ? 'border-rose-900 bg-rose-950/30 text-rose-300'
                                : 'border-slate-800 text-slate-600'
                        }`}
                      >
                        A{n}
                        {dead ? <span className="block text-[8px] tracking-tight">{st === 'OFFLINE' ? 'offline' : 'not sent'}</span> : null}
                      </div>
                    );
                  })}
                </div>
                <p className="text-[10px] text-slate-500">
                  Serial queue with shared rate governor · {completedAgents}/10 answered · a provider that fails twice in a row stops the remaining requests instead of burning the quota
                </p>
              </div>
            )}
          </section>

          <section className="bg-slate-950/80 border border-slate-800 rounded-2xl p-5">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300 border-b border-slate-800 pb-2 mb-3 flex items-center gap-2">
              <Database size={14} /> Immutable Sessions
            </h2>
            <div className="space-y-2 max-h-72 overflow-auto pr-1">
              {sessions.length === 0 && <p className="text-[11px] text-slate-500">No stored sessions yet.</p>}
              {sessions.slice(0, 12).map((s) => (
                <button
                  key={s.id}
                  onClick={() => openSession(s.id)}
                  className="w-full text-left text-[11px] border border-slate-800 hover:border-emerald-700/60 rounded-lg px-3 py-2 bg-slate-900/50"
                >
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-200">
                      {s.detected_symbol || s.user_symbol} · {s.user_timeframe}
                    </span>
                    <span
                      className={
                        s.status === 'PROVIDER_OUTAGE'
                          ? 'text-slate-500'
                          : s.final_decision === 'BUY'
                            ? 'text-emerald-400'
                            : s.final_decision === 'SELL'
                              ? 'text-rose-400'
                              : 'text-amber-400'
                      }
                    >
                      {/* An outage is not a verdict — never show its stored NO_TRADE as if it were one. */}
                      {s.status === 'PROVIDER_OUTAGE' ? 'NO VERDICT (OFFLINE)' : s.final_decision || s.status}
                    </span>
                  </div>
                  <div className="text-slate-500 mt-0.5">{new Date(s.created_at).toISOString().replace('T', ' ').slice(0, 19)} UTC</div>
                </button>
              ))}
            </div>
          </section>
        </aside>

        <main className="xl:col-span-8 space-y-5">
          {!result && !loading && (
            <div className="border border-slate-800 rounded-2xl p-10 bg-slate-950/50 text-center text-slate-500">
              <ShieldAlert className="mx-auto mb-3 text-slate-600" />
              <p className="text-sm">Awaiting chart. This terminal never executes trades and never fabricates market data.</p>
              <p className="text-[11px] mt-2 text-slate-600">If a feed fails, the council must output DATA_UNAVAILABLE / INSUFFICIENT DATA.</p>
            </div>
          )}

          {result && (
            <>
              {result.reusedFrozenSession && (
                <Banner tone="hold">Frozen snapshot replayed. Live market, news, and macro APIs were not recalled.</Banner>
              )}
              {result.timeframeMismatchWarning && (
                <Banner tone="sell">
                  TIMEFRAME MISMATCH: user selected {timeframe.toUpperCase()} but vision detected {result.visionMetadata.detected_timeframe}.
                </Banner>
              )}
              {!result.chiefJudgeVerdict && (
                <Banner tone="sell">
                  {result.status === 'DATA_UNAVAILABLE'
                    ? 'DATA_UNAVAILABLE — '
                    : result.status === 'PROVIDER_OUTAGE'
                      ? 'PROVIDER_OUTAGE — '
                      : 'SESSION FAILED — '}
                  {result.details || result.error || 'No verdict was produced. The terminal never fabricates an analysis; retry when at least one data source is reachable.'}
                </Banner>
              )}

              {councilOutage && result.chiefJudgeVerdict && (
                <section className="border border-rose-500/50 bg-rose-950/30 rounded-2xl p-6">
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div>
                      <span className="text-[11px] uppercase tracking-[0.25em] text-rose-300">No verdict — infrastructure failure</span>
                      <h2 className="text-4xl font-black mt-1 tracking-tight text-rose-200">COUNCIL OFFLINE</h2>
                      <p className="text-xs text-rose-100/80 mt-3 max-w-3xl leading-relaxed">
                        {result.chiefJudgeVerdict?.decision_summary}
                      </p>
                    </div>
                    <div className="text-right text-[10px] text-rose-200/80 space-y-1">
                      <div>LIVE AGENTS: {diag?.live_agents ?? 0}/10</div>
                      <div>OFFLINE: {diag?.offline_agents ?? offlineVotes}/10</div>
                      <div>ERROR: {diag?.dominant_error_class || 'UNKNOWN'}</div>
                      {diag?.retry_after_ms ? <div>RETRY IN: ~{Math.ceil(diag.retry_after_ms / 1000)}s</div> : null}
                      {diag?.skipped_agents ? <div>REQUESTS SAVED: {diag.skipped_agents}</div> : null}
                    </div>
                  </div>
                  {!!diag?.remediation?.length && (
                    <div className="mt-4 border-t border-rose-900/60 pt-3">
                      <div className="text-[10px] uppercase tracking-widest text-rose-300 mb-1">How to fix this</div>
                      <ul className="list-disc pl-4 space-y-1 text-[11px] text-rose-100/90">
                        {diag.remediation.map((r: string) => (
                          <li key={r.slice(0, 40)}>{r}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <p className="text-[10px] text-rose-200/60 mt-3">
                    This run was NOT frozen for replay, so the same screenshot can be re-analysed the moment a provider answers.
                  </p>
                </section>
              )}

              {councilDegraded && (
                <Banner tone="hold">
                  PARTIAL COUNCIL — {diag?.live_agents}/10 specialists answered; {diag?.offline_agents} never reached a model ({diag?.dominant_error_class}).
                  The verdict below is judged on live evidence only; offline agents were not counted as votes.
                </Banner>
              )}

              {result.chiefJudgeVerdict && (
              <>
              {/* During an outage the "final decision" card is suppressed entirely:
                  the COUNCIL OFFLINE panel above replaces it, and the evidence,
                  votes and agent cards below stay visible so the failure is auditable. */}
              {!councilOutage && (
              <section className={`relative overflow-hidden border rounded-2xl p-6 ${toneClasses(verdictTone)}`}>
                <div className="flex justify-between items-start gap-4 flex-wrap">
                  <div>
                    <span className="text-[11px] uppercase tracking-[0.25em] text-slate-400">Chief Judge Final Decision</span>
                    <h2 className="text-5xl font-black mt-1 tracking-tight">{result.chiefJudgeVerdict.final_decision}</h2>
                    <p className="text-xs text-slate-300/90 mt-3 max-w-3xl leading-relaxed">
                      {result.chiefJudgeVerdict.decision_summary}
                    </p>
                  </div>
                  <div className="text-right">
                    <div className="text-[11px] text-slate-400 uppercase tracking-widest">Judge Confidence</div>
                    <div className="text-3xl font-bold">{result.chiefJudgeVerdict.final_confidence}/100</div>
                    <div className="text-[10px] text-slate-500 mt-1">Not a win-rate · not a probability of profit</div>
                    <div className="text-[10px] text-slate-500 mt-1">DQ: {result.chiefJudgeVerdict.data_quality}</div>
                    {(result.chiefJudgeVerdict.chief_judge_model || result.chiefJudgeVerdict.provider_used) && (
                      <div className="text-[10px] text-slate-500 mt-1">
                        {result.chiefJudgeVerdict.provider_used}/{result.chiefJudgeVerdict.chief_judge_model}
                      </div>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-6 pt-4 border-t border-slate-800/80 text-xs">
                  <Metric label="Entry Zone" value={result.chiefJudgeVerdict.entry.low != null ? `${fmt(result.chiefJudgeVerdict.entry.low, 3)} – ${fmt(result.chiefJudgeVerdict.entry.high, 3)}` : 'N/A'} />
                  <Metric label="Stop Loss" value={fmt(result.chiefJudgeVerdict.stop_loss, 3)} danger />
                  <Metric
                    label="TP1 / TP2 / TP3"
                    value={`${fmt(result.chiefJudgeVerdict.targets.tp1, 3)} / ${fmt(result.chiefJudgeVerdict.targets.tp2, 3)} / ${fmt(result.chiefJudgeVerdict.targets.tp3, 3)}`}
                    good
                  />
                  <Metric
                    label="Position Size"
                    value={result.chiefJudgeVerdict.position_size != null ? `${result.chiefJudgeVerdict.position_size} lots` : 'N/A'}
                    warn
                  />
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-3 text-xs">
                  <Metric label="Risk Amount" value={`$${fmt(result.chiefJudgeVerdict.risk_amount, 2)}`} />
                  <Metric label="R:R" value={fmt(result.chiefJudgeVerdict.risk_reward, 2)} />
                  <Metric label="SL Distance" value={result.positionSizingResult?.slDistancePips ? `${result.positionSizingResult.slDistancePips} pips` : 'N/A'} />
                  <Metric label="Vision Px" value={fmt(result.visionMetadata.detected_current_price, 3)} />
                </div>
              </section>
              )}

              <section className="bg-slate-950/80 border border-slate-800 rounded-2xl p-5">
                <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest mb-1">Agent Council Distribution</h3>
                <p className="text-[10px] text-slate-500 mb-4">Exact specialist vote counts only. Never interpreted as probability of profit.</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center text-xs">
                  <VoteBox label="BUY VOTES" value={result.voteDistribution.buy} tone="buy" />
                  <VoteBox label="SELL VOTES" value={result.voteDistribution.sell} tone="sell" />
                  <VoteBox label="NO TRADE (LIVE ONLY)" value={result.voteDistribution.noTrade} tone="hold" />
                  <VoteBox label="OFFLINE — NOT VOTES" value={result.voteDistribution.offline ?? 0} tone="offline" />
                </div>
              </section>

              {result.debateResult && (
              <section className="bg-slate-950/80 border border-slate-800 rounded-2xl p-5 space-y-3">
                <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest border-b border-slate-800 pb-2 flex items-center gap-2">
                  <Scale size={14} /> Adversarial Debate Synthesis
                </h3>
                <p className="text-xs">
                  <span className="text-emerald-400 font-bold">Bull claim ({result.debateResult.topBullishClaim.agent}): </span>
                  {result.debateResult.topBullishClaim.claim}
                </p>
                <p className="text-xs">
                  <span className="text-rose-400 font-bold">Bear claim ({result.debateResult.topBearishClaim.agent}): </span>
                  {result.debateResult.topBearishClaim.claim}
                </p>
                <p className="text-xs">
                  <span className="text-emerald-400 font-bold">Bulls rebuttal: </span>
                  {result.debateResult.bullCounterargument}
                </p>
                <p className="text-xs">
                  <span className="text-rose-400 font-bold">Bears rebuttal: </span>
                  {result.debateResult.bearCounterargument}
                </p>
                <p className="text-xs">
                  <span className="text-amber-400 font-bold">Neutral synthesis: </span>
                  {result.debateResult.synthesisConclusion}
                </p>
              </section>
              )}

              <section className="bg-slate-950/80 border border-slate-800 rounded-2xl p-5">
                <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest mb-4 flex items-center gap-2">
                  <Cpu size={14} /> Round 1 — 10 Independent Specialists
                </h3>
                <div className="space-y-2">
                  {(result.agentOutputs || []).map((agent) => {
                    const open = expandedAgent === agent.agent_number;
                    const agentOffline = agent.execution_state === 'OFFLINE' || agent.model_used === 'none' || agent.model_used === 'skipped' || agent.provider_used === 'none';
                    const tone = agentOffline ? 'offline' : decisionTone(agent.decision);
                    return (
                      <div key={agent.agent_number} className="border border-slate-800 rounded-xl overflow-hidden">
                        <button
                          onClick={() => setExpandedAgent(open ? null : agent.agent_number)}
                          className="w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left text-xs bg-slate-900/40"
                        >
                          <span className="text-slate-400 w-8">A{agent.agent_number}</span>
                          <span className="flex-1 text-slate-200 truncate">
                            {agent.agent_name}{' '}
                            <span className="text-slate-500">· {AGENT_NAMES[agent.agent_number - 1]}</span>
                          </span>
                          <span className={`px-2 py-0.5 rounded border text-[10px] ${toneClasses(tone)}`}>
                            {agentOffline ? (agent.model_used === 'skipped' ? 'NOT SENT' : 'OFFLINE') : agent.decision}
                          </span>
                          <span className="text-slate-400 w-16 text-right">{agentOffline ? '—' : `${agent.confidence}/100`}</span>
                          <ChevronDown size={14} className={`text-slate-500 transition ${open ? 'rotate-180' : ''}`} />
                        </button>
                        {open && (
                          <div className="px-4 py-3 text-[11px] space-y-2 border-t border-slate-800 bg-slate-950/80">
                            <div className="text-slate-500">
                              data_quality={agent.data_quality}
                              {agent.provider_used ? ` · ${agent.provider_used}/${agent.model_used}` : ''}
                              {agentOffline && agent.error_class && agent.error_class !== 'NONE' ? ` · error=${agent.error_class}` : ''}
                              {agentOffline && agent.retry_after_ms ? ` · backoff=${Math.ceil(agent.retry_after_ms / 1000)}s` : ''}
                            </div>
                            <List label="Evidence" items={agent.evidence} />
                            <List label="Supporting" items={agent.supporting_factors} />
                            <List label="Contradicting" items={agent.contradicting_factors} />
                            <List label="Invalidation" items={agent.invalidation_conditions} />
                            <List label="Warnings" items={agent.warnings} />
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 pt-1 text-slate-300">
                              <span>Entry {fmt(agent.entry_zone.low, 3)}–{fmt(agent.entry_zone.high, 3)}</span>
                              <span>SL {fmt(agent.stop_loss, 3)}</span>
                              <span>TP1 {fmt(agent.take_profit_1, 3)}</span>
                              <span>R:R {fmt(agent.risk_reward, 2)}</span>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>

              </>
              )}

              <section className="grid md:grid-cols-3 gap-4">
                <FreezeCard
                  icon={<Activity size={14} />}
                  title="Twelve Data"
                  status={result.frozenMarketData?.status}
                  body={
                    result.frozenMarketData?.status === 'SUCCESS'
                      ? `${result.frozenMarketData.symbol || ''} ${result.frozenMarketData.timeframe || ''} · last ${fmt(result.frozenMarketData.price, 3)}`
                      : `DATA_UNAVAILABLE${result.frozenMarketData?.error ? `: ${result.frozenMarketData.error}` : ''}`
                  }
                />
                <FreezeCard
                  icon={<Gauge size={14} />}
                  title="FRED Macro"
                  status={result.frozenMacroData?.status}
                  body={
                    result.frozenMacroData?.status === 'SUCCESS'
                      ? `${result.frozenMacroData.seriesId} = ${result.frozenMacroData.latestValue} (${result.frozenMacroData.latestDate})`
                      : `DATA_UNAVAILABLE${result.frozenMacroData?.error ? `: ${result.frozenMacroData.error}` : ''}`
                  }
                />
                <FreezeCard
                  icon={<Newspaper size={14} />}
                  title="News Feed"
                  status={result.frozenNewsData?.status}
                  body={
                    result.frozenNewsData?.status === 'SUCCESS'
                      ? `${result.frozenNewsData.articles?.length || 0} headlines frozen`
                      : `DATA_UNAVAILABLE${result.frozenNewsData?.error ? `: ${result.frozenNewsData.error}` : ''}`
                  }
                />
              </section>

              <section className="bg-slate-950/80 border border-slate-800 rounded-2xl p-5 text-[11px] space-y-2">
                <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest">Vision Extract + Warnings</h3>
                <p>
                  {result.visionMetadata.detected_symbol} · {result.visionMetadata.detected_timeframe} · parse {result.visionMetadata.parse_confidence}/100 · {result.visionMetadata.chart_platform}
                </p>
                <p className={result.visionMetadata.parse_state === 'OFFLINE' ? 'text-rose-300' : 'text-slate-500'}>
                  vision parser:{' '}
                  {result.visionMetadata.parse_state === 'OFFLINE'
                    ? `OFFLINE (${result.visionMetadata.parse_error_class}) — the model never answered, this is not a reading of the chart`
                    : result.visionMetadata.parse_state === 'NO_TEXT'
                      ? 'NO_TEXT — a model read the chart and found nothing legible'
                      : `LIVE · ${result.visionMetadata.parser_provider}/${result.visionMetadata.parser_model}`}
                </p>
                <p className="text-slate-500">{result.visionMetadata.raw_ocr_notes}</p>
                {result.visionMetadata.visible_indicators?.length > 0 && (
                  <p>Indicators: {result.visionMetadata.visible_indicators.join(', ')}</p>
                )}
                {result.screenshotUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={result.screenshotUrl} alt="Stored chart" className="mt-2 max-h-40 rounded-lg border border-slate-800 object-contain" />
                )}
                {(result.chiefJudgeVerdict?.warnings || []).map((w, i) => (
                  <p key={`${i}-${w}`} className="text-amber-300 flex gap-2">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {w}
                  </p>
                ))}
                {result.providerDiagnostics && (
                  <div className="pt-2 border-t border-slate-800">
                    <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">Council capacity</div>
                    <div className="flex flex-wrap gap-1.5 text-[10px]">
                      <span className="px-2 py-0.5 rounded border border-slate-700 text-slate-300">
                        state={result.providerDiagnostics.council_state}
                      </span>
                      <span className="px-2 py-0.5 rounded border border-slate-700 text-slate-300">
                        live {result.providerDiagnostics.live_agents}/10
                      </span>
                      {result.providerDiagnostics.offline_agents > 0 && (
                        <span className="px-2 py-0.5 rounded border border-rose-800 text-rose-300">
                          offline {result.providerDiagnostics.offline_agents}
                        </span>
                      )}
                      {result.providerDiagnostics.skipped_agents > 0 && (
                        <span className="px-2 py-0.5 rounded border border-slate-700 text-slate-300">
                          {result.providerDiagnostics.skipped_agents} requests saved
                        </span>
                      )}
                      {result.providerDiagnostics.providers_tried.map((pr: string) => (
                        <span key={pr} className="px-2 py-0.5 rounded border border-slate-700 text-slate-400">
                          {pr}
                        </span>
                      ))}
                      {result.providerDiagnostics.run_budget_remaining_ms != null && result.providerDiagnostics.run_budget_remaining_ms >= 0 && (
                        <span className="px-2 py-0.5 rounded border border-slate-700 text-slate-400">
                          run budget left {(result.providerDiagnostics.run_budget_remaining_ms / 1000).toFixed(0)}s
                        </span>
                      )}
                    </div>
                  </div>
                )}
                <div className="grid md:grid-cols-2 gap-3 pt-2">
                  <List label="Strongest bullish" items={result.chiefJudgeVerdict?.strongest_bullish_arguments} />
                  <List label="Strongest bearish" items={result.chiefJudgeVerdict?.strongest_bearish_arguments} />
                </div>
                <List label="Rejected arguments" items={result.chiefJudgeVerdict?.rejected_arguments} />
                <List label="Invalidation" items={result.chiefJudgeVerdict?.invalidation_conditions} />
              </section>

              <section className="bg-slate-950/80 border border-slate-800 rounded-2xl p-5">
                <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest mb-3">Trade Outcome Log</h3>
                <p className="text-[10px] text-slate-500 mb-3">
                  WIN / LOSS feedback is stored against this session. It does not rewrite agent prompts or judge rules.
                </p>
                {result.outcome && (
                  <p className="text-xs text-emerald-300 mb-3 flex items-center gap-2">
                    <CheckCircle2 size={14} /> Recorded {result.outcome.outcome} at {result.outcome.recorded_at}
                  </p>
                )}
                <form onSubmit={submitOutcome} className="grid md:grid-cols-5 gap-2 items-end">
                  <Field label="Outcome">
                    <select
                      value={outcomeForm.outcome}
                      onChange={(e) => setOutcomeForm({ ...outcomeForm, outcome: e.target.value })}
                      className="field"
                    >
                      <option>WIN</option>
                      <option>LOSS</option>
                      <option>BREAKEVEN</option>
                      <option>SKIPPED</option>
                    </select>
                  </Field>
                  <Field label="Actual entry">
                    <input className="field" value={outcomeForm.actual_entry} onChange={(e) => setOutcomeForm({ ...outcomeForm, actual_entry: e.target.value })} />
                  </Field>
                  <Field label="Actual exit">
                    <input className="field" value={outcomeForm.actual_exit} onChange={(e) => setOutcomeForm({ ...outcomeForm, actual_exit: e.target.value })} />
                  </Field>
                  <Field label="PnL $">
                    <input className="field" value={outcomeForm.actual_pnl} onChange={(e) => setOutcomeForm({ ...outcomeForm, actual_pnl: e.target.value })} />
                  </Field>
                  <button className="bg-slate-100 text-slate-950 text-xs font-bold rounded-lg py-2 uppercase tracking-wider">Save</button>
                  <div className="md:col-span-5">
                    <input
                      className="field"
                      placeholder="Notes / post-analysis review"
                      value={outcomeForm.notes}
                      onChange={(e) => setOutcomeForm({ ...outcomeForm, notes: e.target.value })}
                    />
                  </div>
                </form>
                {outcomeMsg && <p className="text-[11px] text-slate-400 mt-2">{outcomeMsg}</p>}
              </section>
            </>
          )}
        </main>
      </div>

      <footer className="mt-6 text-[10px] text-slate-600 text-center tracking-wide">
        TRADING AI AK is a private decision-support terminal. Not a broker. No order routing. Never fabricates prices, candles, indicators, API responses, backtests, win rates, confidence-as-probability, or news.
      </footer>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] text-slate-400 mb-1">{label}</span>
      {children}
    </label>
  );
}

function Metric({
  label,
  value,
  danger,
  good,
  warn
}: {
  label: string;
  value: string;
  danger?: boolean;
  good?: boolean;
  warn?: boolean;
}) {
  return (
    <div>
      <span className="text-slate-500 block text-[10px] uppercase tracking-wider">{label}</span>
      <span className={`font-bold ${danger ? 'text-rose-300' : good ? 'text-emerald-300' : warn ? 'text-amber-300' : 'text-slate-100'}`}>
        {value}
      </span>
    </div>
  );
}

function VoteBox({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={`border p-3 rounded-xl ${toneClasses(tone)}`}>
      <div className="font-bold text-2xl">{value}</div>
      <div className="text-slate-400 text-[10px] tracking-widest mt-1">{label}</div>
    </div>
  );
}

function Banner({ children, tone }: { children: React.ReactNode; tone: string }) {
  return <div className={`border rounded-xl px-4 py-3 text-xs ${toneClasses(tone)}`}>{children}</div>;
}

function List({ label, items }: { label: string; items?: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div>
      <div className="text-slate-500 uppercase tracking-wider text-[10px] mb-1">{label}</div>
      <ul className="list-disc pl-4 space-y-0.5 text-slate-300">
        {items.map((item, i) => (
          <li key={`${i}-${item.slice(0, 48)}`}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function FreezeCard({
  icon,
  title,
  status,
  body
}: {
  icon: React.ReactNode;
  title: string;
  status?: string;
  body: string;
}) {
  const ok = status === 'SUCCESS';
  return (
    <div className="bg-slate-950/80 border border-slate-800 rounded-2xl p-4 text-[11px]">
      <div className="flex items-center justify-between mb-2">
        <span className="flex items-center gap-2 text-slate-300">
          {icon} {title}
        </span>
        <span className={ok ? 'text-emerald-400' : 'text-amber-400'}>{ok ? 'FROZEN' : 'DATA_UNAVAILABLE'}</span>
      </div>
      <p className="text-slate-400 leading-relaxed">{body}</p>
    </div>
  );
}
