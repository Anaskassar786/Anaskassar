import { AGENT_DEFINITIONS } from '@/lib/agents/definitions';
import { AgentOutputSchema, AgentOutput, VisionParserOutput } from '@/types/analysis';
import { chatJson, classifyLlmError, isLlmUnavailable, type LlmFailure } from '@/lib/llm/client';
import type { LlmErrorClass } from '@/lib/llm/models';
import { isRunBudgetExhausted, snapshot } from '@/lib/llm/rate-limit';
import {
  asStringArray,
  clamp,
  normalizeDataQuality,
  normalizeDecision,
  numOrNull
} from '@/lib/llm/json';
import {
  offlineEvidence,
  shouldSkipRemainingAgents,
  type AgentExecutionState,
  type AgentRuntime
} from '@/lib/execution/offline';
import type { MarketDataSnapshot, MacroDataSnapshot, NewsDataSnapshot } from '@/lib/data/ingestion';

export type { AgentRuntime };

export interface SnapshotPayload {
  sessionId: string;
  imageBufferBase64: string;
  imageMimeType?: string;
  visionMetadata: VisionParserOutput;
  marketData: MarketDataSnapshot;
  newsData: NewsDataSnapshot;
  macroData: MacroDataSnapshot;
  riskAmount: number;
  accountBalance?: number | null;
  desiredProfit?: number | null;
  userSymbol: string;
  userTimeframe: string;
}

export interface AgentRunMeta {
  provider_used: string;
  model_used: string;
  execution_state: AgentExecutionState;
  error_class: LlmErrorClass | 'NONE';
  attempts: number;
  retry_after_ms: number;
}

export interface AgentBatchResult {
  outputs: Array<AgentOutput & AgentRuntime>;
  /** Dominant reason the council could not run, when it could not run. */
  dominantErrorClass: LlmErrorClass | 'NONE';
  retryAfterMs: number;
  providersTried: string[];
  failureDetails: LlmFailure[];
  batchWarnings: string[];
  governor: ReturnType<typeof snapshot>;
  skippedAgents: number;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = (process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function envInt(name: string, fallback: number): number {
  const raw = (process.env[name] || '').trim();
  // An unset variable must fall back, not coerce to 0 — `Number('')` is 0, and a
  // silent 0 here once disabled every chart attachment and the upload guard.
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Approx. bytes of raw image behind a base64 string. */
function base64Bytes(b64: string): number {
  return Math.floor((b64.length * 3) / 4);
}

/** Uploads above this are sent to the models text-only; big PNGs cause 429s. */
function maxImageBytes(): number {
  return envInt('LLM_IMAGE_MAX_BYTES', 1_500_000);
}

function offlineOutput(
  agentDef: (typeof AGENT_DEFINITIONS)[0],
  reason: string,
  errorClass: LlmErrorClass,
  retryAfterMs = 0
): AgentOutput {
  const { evidence, warning } = offlineEvidence(reason, errorClass);
  return AgentOutputSchema.parse({
    agent_number: agentDef.number,
    agent_name: agentDef.name,
    decision: 'NO_TRADE',
    confidence: 0,
    evidence: [evidence],
    supporting_factors: [],
    contradicting_factors: [`Provider error before any analysis: ${errorClass}`],
    entry_zone: { low: null, high: null },
    stop_loss: null,
    take_profit_1: null,
    take_profit_2: null,
    take_profit_3: null,
    risk_reward: null,
    invalidation_conditions: ['This specialist never ran — re-run once an LLM provider answers'],
    data_quality: 'INSUFFICIENT',
    warnings: [warning, retryAfterMs > 0 ? `provider backing off ~${Math.ceil(retryAfterMs / 1000)}s` : ''].filter(Boolean),
    execution_state: 'OFFLINE',
    error_class: errorClass,
    attempts: 0,
    retry_after_ms: retryAfterMs
  });
}

function coerceAgentOutput(raw: Record<string, unknown>, agentDef: (typeof AGENT_DEFINITIONS)[0]): AgentOutput {
  const entry = (raw.entry_zone as Record<string, unknown> | undefined) || {};
  const candidate = {
    agent_number: agentDef.number,
    agent_name: agentDef.name,
    decision: normalizeDecision(raw.decision),
    confidence: clamp(Number(raw.confidence) || 0, 0, 100),
    evidence: asStringArray(raw.evidence),
    supporting_factors: asStringArray(raw.supporting_factors),
    contradicting_factors: asStringArray(raw.contradicting_factors),
    entry_zone: {
      low: numOrNull(entry.low ?? raw.entry_low),
      high: numOrNull(entry.high ?? raw.entry_high)
    },
    stop_loss: numOrNull(raw.stop_loss),
    take_profit_1: numOrNull(raw.take_profit_1 ?? raw.tp1),
    take_profit_2: numOrNull(raw.take_profit_2 ?? raw.tp2),
    take_profit_3: numOrNull(raw.take_profit_3 ?? raw.tp3),
    risk_reward: numOrNull(raw.risk_reward),
    invalidation_conditions: asStringArray(raw.invalidation_conditions),
    data_quality: normalizeDataQuality(raw.data_quality),
    warnings: asStringArray(raw.warnings),
    // A specialist that answered is LIVE by definition, even on INSUFFICIENT data.
    execution_state: 'LIVE' as const,
    error_class: 'NONE' as const,
    attempts: 1,
    retry_after_ms: 0
  };
  return AgentOutputSchema.parse(candidate);
}

function compactMarket(market: MarketDataSnapshot): MarketDataSnapshot {
  const cap = envInt('LLM_MARKET_CANDLES', 12);
  if (!market.candles || market.candles.length <= cap) return market;
  return { ...market, candles: market.candles.slice(0, cap) };
}

function compactNews(news: NewsDataSnapshot): NewsDataSnapshot {
  const cap = envInt('LLM_NEWS_ITEMS', 5);
  if (!news.articles || news.articles.length <= cap) return news;
  return { ...news, articles: news.articles.slice(0, cap) };
}

function buildSnapshotText(payload: SnapshotPayload): string {
  return `ANALYSIS SNAPSHOT (IMMUTABLE):
Session: ${payload.sessionId}
User Symbol: ${payload.userSymbol}
User Timeframe: ${payload.userTimeframe}
Detected Symbol: ${payload.visionMetadata.detected_symbol}
Detected Timeframe: ${payload.visionMetadata.detected_timeframe}
Detected Price: ${payload.visionMetadata.detected_current_price}
Visible Indicators: ${JSON.stringify(payload.visionMetadata.visible_indicators)}
Vision Notes: ${payload.visionMetadata.raw_ocr_notes}
Market Data: ${JSON.stringify(compactMarket(payload.marketData))}
Macro Data: ${JSON.stringify(payload.macroData)}
News Data: ${JSON.stringify(compactNews(payload.newsData))}
User Risk Amount: $${payload.riskAmount}
Account Balance: ${payload.accountBalance ?? 'NOT_PROVIDED'}
Desired Profit: ${payload.desiredProfit ?? 'NOT_PROVIDED'}

Perform your specialist Round 1 analysis independently. You cannot see other agents. Output pure JSON matching schema.`;
}

interface AgentCallResult {
  output: AgentOutput;
  meta: AgentRunMeta;
  failures: LlmFailure[];
  note?: string;
}

async function callSingleAgent(
  agentDef: (typeof AGENT_DEFINITIONS)[0],
  payload: SnapshotPayload,
  opts: { attachChart: boolean; patient: boolean; oversizedImageBytes: number }
): Promise<AgentCallResult> {
  try {
    const mime = payload.imageMimeType || 'image/png';
    const userContent: Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    > = [{ type: 'text', text: buildSnapshotText(payload) }];
    if (opts.attachChart) {
      userContent.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${payload.imageBufferBase64}` } });
    }

    const { data, provider, model } = await chatJson<Record<string, unknown>>({
      json: true,
      temperature: 0.15,
      timeoutMs: envInt('LLM_AGENT_TIMEOUT_MS', 55000),
      maxTokens: envInt('LLM_AGENT_MAX_TOKENS', 2048),
      patient: opts.patient,
      messages: [
        { role: 'system', content: agentDef.systemPrompt },
        { role: 'user', content: userContent }
      ]
    });

    return {
      output: coerceAgentOutput(data, agentDef),
      meta: {
        provider_used: provider,
        model_used: model,
        execution_state: 'LIVE',
        error_class: 'NONE',
        attempts: 1,
        retry_after_ms: 0
      },
      failures: [],
      note: opts.oversizedImageBytes
        ? `chart image ${Math.round(opts.oversizedImageBytes / 1024)}KB exceeds LLM_IMAGE_MAX_BYTES (${Math.round(
            maxImageBytes() / 1024
          )}KB) — the screenshot was dropped to protect the token budget`
        : undefined
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errorClass = isLlmUnavailable(err) ? err.errorClass : classifyLlmError(message);
    const retryAfterMs = isLlmUnavailable(err) ? err.retryAfterMs : 0;
    const attempts = isLlmUnavailable(err) ? Math.max(1, err.failures.length) : 1;
    const output = offlineOutput(agentDef, message, errorClass, retryAfterMs);
    return {
      output,
      meta: {
        provider_used: 'none',
        model_used: 'none',
        execution_state: 'OFFLINE',
        error_class: errorClass,
        attempts,
        retry_after_ms: retryAfterMs
      },
      failures: isLlmUnavailable(err) ? err.failures : []
    };
  }
}

/**
 * Run the 10 isolated specialists.
 *
 * Scheduling rules learned the hard way (one 429 used to zero out the whole
 * council):
 *  - strictly serial by default, with a pacing gap owned by the rate governor;
 *  - the first agent is a *canary* and is patient: it will sit out a
 *    `Retry-After` window so a per-minute free-tier limit recovers mid-run;
 *  - if two agents in a row die for provider reasons, the remaining specialists
 *    are recorded as OFFLINE without a request — preserving quota and, more
 *    importantly, telling the truth about why there is no verdict;
 *  - the whole batch respects LLM_RUN_BUDGET_MS so a run cannot outlive the
 *    serverless `maxDuration` and strand the UI on a spinner.
 */
export async function executeAgentBatch(
  payload: SnapshotPayload,
  onProgress?: (agentNumber: number, status: string, output?: AgentOutput, meta?: AgentRunMeta) => void
): Promise<AgentBatchResult> {
  const outputs: Array<AgentOutput & AgentRuntime> = [];
  const failureDetails: LlmFailure[] = [];
  const providersTried = new Set<string>();
  // 'NONE' until a specialist actually fails — a healthy council must not report
  // a phantom error class to the judge/UI.
  let dominantErrorClass: LlmErrorClass | 'NONE' = 'NONE';
  let retryAfterMs = 0;
  let consecutiveProviderFailures = 0;
  let lastErrorClass: LlmErrorClass | 'NONE' = 'UNKNOWN';
  let skippedAgents = 0;
  const batchWarnings: string[] = [];

  const chartBytes = base64Bytes(payload.imageBufferBase64);
  const chartTooBig = chartBytes > maxImageBytes();
  const globalAttach = envBool('LLM_AGENTS_ATTACH_CHART', true);
  if (chartTooBig) {
    batchWarnings.push(
      `Screenshot is ${Math.round(chartBytes / 1024)}KB (> LLM_IMAGE_MAX_BYTES ${Math.round(
        maxImageBytes() / 1024
      )}KB). Specialists ran on the frozen numeric snapshot only — downscale the upload to keep chart context without tripping provider rate limits.`
    );
  }

  for (let index = 0; index < AGENT_DEFINITIONS.length; index++) {
    const agentDef = AGENT_DEFINITIONS[index];
    // Macro + news specialists work from frozen feeds; the screenshot adds no
    // signal there and costs the most tokens — the scarcest budget during a 429.
    const wantsChart = agentDef.number !== 8 && agentDef.number !== 9;
    const attachChart = globalAttach && !chartTooBig && wantsChart;

    const tripped = shouldSkipRemainingAgents(consecutiveProviderFailures, lastErrorClass, envInt('LLM_CANARY_FAILURES_TO_TRIP', 2));
    const budgetGone = isRunBudgetExhausted();
    if (tripped.skip || budgetGone) {
      const reason = budgetGone
        ? `Skipped without a request: LLM run budget (LLM_RUN_BUDGET_MS) exhausted after ${index} agent(s). ${tripped.reason || ''}`.trim()
        : `Skipped without a request: ${tripped.reason}.`;
      const cls: LlmErrorClass = budgetGone && !tripped.skip ? 'TIMEOUT' : lastErrorClass === 'NONE' ? 'UNKNOWN' : lastErrorClass;
      const output = offlineOutput(agentDef, reason, cls, retryAfterMs);
      const meta: AgentRunMeta = {
        provider_used: 'none',
        model_used: 'skipped',
        execution_state: 'OFFLINE',
        error_class: cls,
        attempts: 0,
        retry_after_ms: retryAfterMs
      };
      outputs.push({ ...output, ...meta });
      skippedAgents += 1;
      onProgress?.(agentDef.number, budgetGone ? 'SKIPPED_BUDGET' : 'SKIPPED_OUTAGE', output, meta);
      continue;
    }

    onProgress?.(agentDef.number, 'RUNNING');
    const canary = index === 0 || consecutiveProviderFailures > 0;
    const { output, meta, failures, note } = await callSingleAgent(agentDef, payload, {
      attachChart,
      patient: canary,
      oversizedImageBytes: chartTooBig ? chartBytes : 0
    });
    failureDetails.push(...failures);
    if (note && !batchWarnings.includes(note)) batchWarnings.push(note);

    if (meta.execution_state === 'LIVE') {
      consecutiveProviderFailures = 0;
      lastErrorClass = 'NONE';
    } else {
      consecutiveProviderFailures += 1;
      lastErrorClass = meta.error_class;
      dominantErrorClass = meta.error_class;
      retryAfterMs = Math.max(retryAfterMs, meta.retry_after_ms);
      providersTried.add(meta.provider_used);
    }

    const finalOutput = note ? { ...output, warnings: [...output.warnings, note] } : output;
    outputs.push({ ...finalOutput, ...meta });
    onProgress?.(agentDef.number, meta.execution_state === 'LIVE' ? 'COMPLETED' : 'OFFLINE', finalOutput, meta);

    if (index < AGENT_DEFINITIONS.length - 1 && !isRunBudgetExhausted()) {
      const gap = envInt('LLM_AGENT_GAP_MS', 1200);
      if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap));
    }
  }

  // Merge what the governor observed directly — the per-agent error text is
  // useful but the cooldown/budget picture is only visible centrally.
  const gov = snapshot();
  for (const p of gov.providers) {
    providersTried.add(p.provider);
    if (p.rateLimits > 0 && dominantErrorClass === 'NONE') dominantErrorClass = 'RATE_LIMIT';
  }

  return {
    outputs,
    dominantErrorClass,
    retryAfterMs,
    providersTried: [...providersTried].filter((p) => p && p !== 'none'),
    failureDetails,
    batchWarnings,
    governor: gov,
    skippedAgents
  };
}
