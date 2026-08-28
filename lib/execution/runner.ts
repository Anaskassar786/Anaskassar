import { AGENT_DEFINITIONS } from '@/lib/agents/definitions';
import { AgentOutputSchema, AgentOutput, VisionParserOutput } from '@/types/analysis';
import { chatJson, classifyLlmError, isLlmUnavailable, type LlmFailure } from '@/lib/llm/client';
import type { LlmErrorClass } from '@/lib/llm/models';
import { budgetRemainingMs, isRunBudgetExhausted, resetRateLimits, sleep, snapshot } from '@/lib/llm/rate-limit';
import {
  buildBatchSystemPrompt,
  parseBatchResponse,
  planAgentBatches,
  type AgentBatchGroup
} from '@/lib/execution/batching';
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
interface GroupCallResult {
  outputs: Array<AgentOutput & AgentRuntime>;
  failures: LlmFailure[];
  notes: string[];
  /** Provider-side error class when the whole group failed, 'NONE' otherwise. */
  errorClass: LlmErrorClass | 'NONE';
  retryAfterMs: number;
  provider: string;
}

function offlineGroup(
  group: AgentBatchGroup,
  reason: string,
  errorClass: LlmErrorClass,
  retryAfterMs: number,
  modelLabel: string,
  attempts: number
): Array<AgentOutput & AgentRuntime> {
  return group.agents.map((agentDef) => ({
    ...offlineOutput(agentDef, reason, errorClass, retryAfterMs),
    provider_used: 'none',
    model_used: modelLabel,
    execution_state: 'OFFLINE' as const,
    error_class: errorClass,
    attempts,
    retry_after_ms: retryAfterMs
  }));
}

/**
 * One request carrying every brief in the group.
 *
 * A specialist missing from an otherwise valid answer is recorded OFFLINE with
 * an EMPTY error class — never back-filled from a sibling's numbers.
 */
async function callAgentGroup(
  group: AgentBatchGroup,
  payload: SnapshotPayload,
  opts: { attachChart: boolean; patient: boolean; oversizedImageBytes: number }
): Promise<GroupCallResult> {
  const notes: string[] = [];
  if (opts.oversizedImageBytes) {
    notes.push(
      `chart image ${Math.round(opts.oversizedImageBytes / 1024)}KB exceeds LLM_IMAGE_MAX_BYTES (${Math.round(
        maxImageBytes() / 1024
      )}KB) — the screenshot was dropped to protect the token budget`
    );
  }

  const single = group.agents.length === 1;
  const systemPrompt = single ? group.agents[0].systemPrompt : buildBatchSystemPrompt(group);
  const instruction = single
    ? 'Perform your specialist Round 1 analysis independently. You cannot see other agents. Output pure JSON matching schema.'
    : `Answer all ${group.agents.length} specialists (${group.agents
        .map((a) => `A${a.number}`)
        .join(', ')}) in one JSON object under "agents". Each specialist reasons independently — do not reconcile them.`;

  try {
    const mime = payload.imageMimeType || 'image/png';
    const userContent: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
      { type: 'text', text: `${buildSnapshotText(payload)}\n\n${instruction}` }
    ];
    if (opts.attachChart) {
      userContent.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${payload.imageBufferBase64}` } });
    }

    const perAgentTokens = envInt('LLM_AGENT_MAX_TOKENS', 2048);
    const { data, provider, model } = await chatJson<unknown>({
      json: true,
      temperature: 0.15,
      timeoutMs: envInt('LLM_AGENT_TIMEOUT_MS', 55000) + (single ? 0 : (group.agents.length - 1) * 10_000),
      // A batch must be able to emit several specialist objects; a cramped
      // completion window truncates the JSON and loses agents that DID run.
      maxTokens: Math.min(8192, single ? perAgentTokens : Math.round(perAgentTokens * 0.8 * group.agents.length)),
      patient: opts.patient,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ]
    });

    const parsed = parseBatchResponse(data, group);
    const outputs: Array<AgentOutput & AgentRuntime> = [];
    for (const agentDef of group.agents) {
      const raw = parsed.byAgent.get(agentDef.number);
      if (!raw) {
        outputs.push(
          ...offlineGroup(
            { ...group, agents: [agentDef] },
            `The model answered this batch but omitted agent ${agentDef.number}; nothing was copied from the other specialists to fill the gap.`,
            'EMPTY',
            0,
            model,
            1
          )
        );
        continue;
      }
      outputs.push({
        ...coerceAgentOutput(raw, agentDef),
        provider_used: provider,
        model_used: model,
        execution_state: 'LIVE' as const,
        error_class: 'NONE' as const,
        attempts: 1,
        retry_after_ms: 0
      });
    }

    if (parsed.missing.length) {
      notes.push(
        `Batch answer omitted agent(s) ${parsed.missing.join(', ')} — recorded OFFLINE rather than reconstructed. Lower LLM_AGENT_BATCH_SIZE if this repeats.`
      );
    }

    return { outputs, failures: [], notes, errorClass: 'NONE', retryAfterMs: 0, provider };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errorClass = isLlmUnavailable(err) ? err.errorClass : classifyLlmError(message);
    const retryAfterMs = isLlmUnavailable(err) ? err.retryAfterMs : 0;
    const attempts = isLlmUnavailable(err) ? Math.max(1, err.failures.length) : 1;
    return {
      outputs: offlineGroup(group, message, errorClass, retryAfterMs, 'none', attempts),
      failures: isLlmUnavailable(err) ? err.failures : [],
      notes,
      errorClass,
      retryAfterMs,
      provider: 'none'
    };
  }
}

/** Specialists per request. 1 restores the legacy one-call-per-agent behaviour. */
function batchSize(): number {
  return Math.max(1, Math.min(envInt('LLM_AGENT_BATCH_SIZE', 5), 10));
}

/** Seconds a rate-limited run may sit out before retrying the council once. */
function recoveryWaitMs(): number {
  return envInt('LLM_RATE_LIMIT_RECOVERY_MS', 75_000);
}

/**
 * Run the 10 specialists.
 *
 * Scheduling rules, all learned from real "COUNCIL OFFLINE — 10/10" runs:
 *  - specialists are grouped into batches (LLM_AGENT_BATCH_SIZE, default 5), so a
 *    full council costs 2 requests instead of 10. This is the primary defence
 *    against a free-tier 429: the quota is simply never asked for;
 *  - the screenshot rides on the chart-reading batch only, never on the
 *    macro/news batch;
 *  - the first batch is a patient canary: it will sit out a Retry-After window
 *    so a per-minute limit can reset mid-run;
 *  - if a whole batch dies for provider reasons and the provider quoted a
 *    reset that fits the run budget, the batch is retried ONCE after that wait
 *    instead of writing the run off (this is what turns the old dead end into a
 *    completed council on free tiers);
 *  - only after recovery also fails do the remaining batches get skipped —
 *    recorded OFFLINE, honestly, never as NO_TRADE votes.
 */
export async function executeAgentBatch(
  payload: SnapshotPayload,
  onProgress?: (agentNumber: number, status: string, output?: AgentOutput, meta?: AgentRunMeta) => void
): Promise<AgentBatchResult> {
  const outputs: Array<AgentOutput & AgentRuntime> = [];
  const failureDetails: LlmFailure[] = [];
  const providersTried = new Set<string>();
  let dominantErrorClass: LlmErrorClass | 'NONE' = 'NONE';
  let retryAfterMs = 0;
  let consecutiveProviderFailures = 0;
  let lastErrorClass: LlmErrorClass | 'NONE' = 'UNKNOWN';
  let skippedAgents = 0;
  let recoveryUsed = false;
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

  const groups = planAgentBatches(AGENT_DEFINITIONS, batchSize());
  if (groups.length < AGENT_DEFINITIONS.length) {
    batchWarnings.push(
      `Council batched into ${groups.length} request(s) instead of ${AGENT_DEFINITIONS.length} (LLM_AGENT_BATCH_SIZE=${batchSize()}) — each specialist still answers independently, but the run costs ${
        AGENT_DEFINITIONS.length - groups.length
      } fewer provider requests.`
    );
  }

  const record = (group: AgentBatchGroup, result: GroupCallResult, note?: string) => {
    for (const out of result.outputs) {
      const finalOut = note ? { ...out, warnings: [...out.warnings, note] } : out;
      outputs.push(finalOut);
      const meta: AgentRunMeta = {
        provider_used: finalOut.provider_used,
        model_used: finalOut.model_used,
        execution_state: finalOut.execution_state,
        error_class: finalOut.error_class,
        attempts: finalOut.attempts,
        retry_after_ms: finalOut.retry_after_ms
      };
      onProgress?.(finalOut.agent_number, finalOut.execution_state === 'LIVE' ? 'COMPLETED' : 'OFFLINE', finalOut, meta);
    }
    void group;
  };

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    const attachChart = globalAttach && !chartTooBig && group.needsChart;

    const tripped = shouldSkipRemainingAgents(consecutiveProviderFailures, lastErrorClass, envInt('LLM_CANARY_FAILURES_TO_TRIP', 2));
    const budgetGone = isRunBudgetExhausted();
    if (tripped.skip || budgetGone) {
      const reason = budgetGone
        ? `Skipped without a request: LLM run budget (LLM_RUN_BUDGET_MS) exhausted after ${outputs.length} agent(s). ${tripped.reason || ''}`.trim()
        : `Skipped without a request: ${tripped.reason}.`;
      const cls: LlmErrorClass = budgetGone && !tripped.skip ? 'TIMEOUT' : lastErrorClass === 'NONE' ? 'UNKNOWN' : lastErrorClass;
      const skipped = offlineGroup(group, reason, cls, retryAfterMs, 'skipped', 0);
      for (const out of skipped) {
        outputs.push(out);
        skippedAgents += 1;
        onProgress?.(out.agent_number, budgetGone ? 'SKIPPED_BUDGET' : 'SKIPPED_OUTAGE', out, {
          provider_used: 'none',
          model_used: 'skipped',
          execution_state: 'OFFLINE',
          error_class: cls,
          attempts: 0,
          retry_after_ms: retryAfterMs
        });
      }
      continue;
    }

    for (const a of group.agents) onProgress?.(a.number, 'RUNNING');

    const patient = gi === 0 || consecutiveProviderFailures > 0;
    let result = await callAgentGroup(group, payload, {
      attachChart,
      patient,
      oversizedImageBytes: chartTooBig ? chartBytes : 0
    });

    // RECOVERY: the provider told us when it will accept traffic again. If that
    // window fits inside the run budget, wait it out once instead of declaring
    // an outage — on free tiers this is the difference between a verdict and
    // "COUNCIL OFFLINE".
    const recoverable = result.errorClass === 'RATE_LIMIT' || result.errorClass === 'UPSTREAM' || result.errorClass === 'TIMEOUT';
    if (recoverable && !recoveryUsed && envBool('LLM_RATE_LIMIT_RECOVERY', true)) {
      const quoted = result.retryAfterMs > 0 ? result.retryAfterMs : 20_000;
      const wait = Math.min(quoted + 1_500, recoveryWaitMs());
      const budget = budgetRemainingMs();
      if (wait > 0 && wait + 5_000 < budget) {
        recoveryUsed = true;
        batchWarnings.push(
          `Provider asked for ~${Math.ceil(quoted / 1000)}s of backoff; the council waited it out once and retried instead of reporting an outage.`
        );
        for (const a of group.agents) onProgress?.(a.number, 'WAITING_RATE_LIMIT');
        await sleep(wait);
        resetRateLimits();
        const retry = await callAgentGroup(group, payload, {
          attachChart,
          patient: true,
          oversizedImageBytes: chartTooBig ? chartBytes : 0
        });
        failureDetails.push(...result.failures);
        result = retry;
      }
    }

    failureDetails.push(...result.failures);
    for (const note of result.notes) if (!batchWarnings.includes(note)) batchWarnings.push(note);

    const anyLive = result.outputs.some((o) => o.execution_state === 'LIVE');
    if (anyLive) {
      consecutiveProviderFailures = 0;
      lastErrorClass = 'NONE';
    } else {
      consecutiveProviderFailures += 1;
      lastErrorClass = result.errorClass === 'NONE' ? 'UNKNOWN' : result.errorClass;
      dominantErrorClass = lastErrorClass;
      retryAfterMs = Math.max(retryAfterMs, result.retryAfterMs);
      providersTried.add(result.provider);
    }

    record(group, result);

    if (gi < groups.length - 1 && !isRunBudgetExhausted()) {
      const gap = envInt('LLM_AGENT_GAP_MS', 1200);
      if (gap > 0) await sleep(gap);
    }
  }

  // Batches complete out of agent order (chart batch first, macro/news last);
  // the terminal renders A1..A10, so restore the canonical order here.
  outputs.sort((a, b) => a.agent_number - b.agent_number);

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
