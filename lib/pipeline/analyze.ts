import crypto from 'crypto';
import { parseChartScreenshot } from '@/lib/vision/processor';
import { fetchFredMacroData, fetchMarketNews, fetchTwelveData } from '@/lib/data/ingestion';
import { executeAgentBatch, SnapshotPayload } from '@/lib/execution/runner';
import { runAdversarialDebate } from '@/lib/debate/engine';
import { runChiefJudge } from '@/lib/judge/chief_judge';
import { resetLlmCooldowns } from '@/lib/llm/client';
import {
  councilOutcome,
  isOfflineAgent,
  runStatusFor,
  liveAgentCount,
  offlineAgentCount,
  remediationFor,
  voteCountOf,
  type ProviderDiagnostics,
  type VoteCounts
} from '@/lib/execution/offline';
import { beginRun, budgetRemainingMs, snapshot as governorSnapshot } from '@/lib/llm/rate-limit';
import { effectiveProviderOrder } from '@/lib/llm/models';
import { calculatePositionSize, calculateRiskReward } from '@/lib/quant/sizing';
import {
  AnalysisSessionRecord,
  findCompletedByHash,
  saveScreenshot,
  upsertSession
} from '@/lib/db/store';

export type PipelineEvent =
  | { type: 'session'; sessionId: string; reused?: boolean }
  | { type: 'phase'; phase: number; label: string }
  | { type: 'vision'; visionMetadata: SnapshotPayload['visionMetadata']; timeframeMismatch: boolean }
  | { type: 'freeze'; market: unknown; macro: unknown; news: unknown }
  | { type: 'agent'; agentNumber: number; status: string; output?: unknown }
  | { type: 'debate'; debate: unknown }
  | { type: 'judge'; verdict: unknown }
  | { type: 'providers'; diagnostics: ProviderDiagnostics }
  | { type: 'complete'; result: AnalysisApiResult }
  | { type: 'error'; message: string };

export interface AnalyzeInput {
  imageBuffer: Buffer;
  mimeType: string;
  userSymbol: string;
  userTimeframe: string;
  riskAmount: number;
  accountBalance: number | null;
  desiredProfit: number | null;
  reuseFrozen?: boolean;
}

export type { ProviderDiagnostics };

export interface AnalysisApiResult {
  success: boolean;
  status?: 'COMPLETED' | 'PARTIAL' | 'DATA_UNAVAILABLE' | 'PROVIDER_OUTAGE' | 'FAILED';
  details?: string;
  sessionId: string;
  reusedFrozenSession?: boolean;
  timeframeMismatchWarning: boolean;
  visionMetadata: SnapshotPayload['visionMetadata'];
  voteDistribution: VoteCounts;
  providerDiagnostics?: ProviderDiagnostics;
  agentOutputs: unknown;
  debateResult: unknown;
  chiefJudgeVerdict: unknown;
  positionSizingResult: unknown;
  frozenMarketData: unknown;
  frozenMacroData: unknown;
  frozenNewsData: unknown;
  screenshotUrl: string;
}

function isReusableFrozenSession(existing: AnalysisSessionRecord): boolean {
  // Only a fully healthy council is worth replaying. PARTIAL / PROVIDER_OUTAGE
  // runs must stay re-runnable, otherwise a rate-limited minute permanently
  // freezes a screenshot into a non-answer.
  if (existing.status !== 'COMPLETED') return false;
  const judge = existing.final_decision;
  if (!judge) return false;
  const judgeModel = (judge as { chief_judge_model?: string; provider_used?: string }).chief_judge_model;
  const judgeProvider = (judge as { provider_used?: string }).provider_used;
  if (judge.data_quality === 'INSUFFICIENT' && (judgeModel === 'fallback' || judgeProvider === 'none')) {
    return false;
  }
  const agents = existing.agent_analyses || [];
  if (agents.length === 0) return false;
  // execution_state is authoritative; the legacy provider/model check keeps
  // older sessions on disk from being mistaken for healthy runs.
  if (agents.some((a) => isOfflineAgent(a))) return false;
  const failed = agents.filter((a) => a.provider_used === 'none' || a.model_used === 'fallback' || a.model_used === 'none').length;
  if (failed > 0) return false;
  return true;
}

function extFromMime(mime: string): string {
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  return 'png';
}

export async function runAnalysisPipeline(
  input: AnalyzeInput,
  emit?: (event: PipelineEvent) => void
): Promise<AnalysisApiResult> {
  // Fresh run: clear provider cooldowns and arm the wall-clock budget so a
  // rate-limited key cannot strand the UI on a spinner for 10+ minutes.
  resetLlmCooldowns();
  beginRun();
  const screenshotHash = crypto.createHash('sha256').update(input.imageBuffer).digest('hex');

  if (input.reuseFrozen !== false) {
    const existing = await findCompletedByHash(screenshotHash);
    // Only replay sessions that actually produced a live analysis.
    // Fallback NO_TRADE from dead LLM models must NOT lock the user out of a retry.
    if (existing && existing.final_decision && existing.debate && isReusableFrozenSession(existing)) {
      const result: AnalysisApiResult = {
        success: true,
        sessionId: existing.id,
        reusedFrozenSession: true,
        timeframeMismatchWarning: existing.timeframe_mismatch_warning,
        visionMetadata: existing.vision_metadata,
        voteDistribution: existing.debate.voteSummary,
        providerDiagnostics: existing.provider_diagnostics ?? undefined,
        agentOutputs: existing.agent_analyses,
        debateResult: existing.debate,
        chiefJudgeVerdict: existing.final_decision,
        positionSizingResult: existing.position_sizing,
        frozenMarketData: existing.frozen_market_data,
        frozenMacroData: existing.frozen_macro_data,
        frozenNewsData: existing.frozen_news_data,
        screenshotUrl: existing.screenshot_url
      };
      emit?.({ type: 'session', sessionId: existing.id, reused: true });
      emit?.({ type: 'complete', result });
      return result;
    }
  }

  const sessionId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const imageBase64 = input.imageBuffer.toString('base64');
  const screenshotUrl = await saveScreenshot(screenshotHash, input.imageBuffer, extFromMime(input.mimeType));

  emit?.({ type: 'session', sessionId });
  emit?.({ type: 'phase', phase: 0, label: 'Vision pre-processor' });

  const visionMeta = await parseChartScreenshot(imageBase64, input.mimeType);
  const timeframeMismatch =
    visionMeta.detected_timeframe !== 'UNKNOWN' &&
    visionMeta.detected_timeframe.toLowerCase() !== input.userTimeframe.toLowerCase();

  emit?.({ type: 'vision', visionMetadata: visionMeta, timeframeMismatch });

  const effectiveSymbol = visionMeta.detected_symbol !== 'UNKNOWN' ? visionMeta.detected_symbol : input.userSymbol;
  const effectiveTimeframe =
    visionMeta.detected_timeframe !== 'UNKNOWN' ? visionMeta.detected_timeframe : input.userTimeframe;

  emit?.({ type: 'phase', phase: 1, label: 'Immutable analysis session freeze' });

  const newsQuery =
    effectiveSymbol.includes('XAU') || effectiveSymbol.includes('GOLD')
      ? 'Gold USD Fed Interest Rates Inflation'
      : `${effectiveSymbol} forex Fed interest rates`;

  const [marketSnapshot, macroSnapshot, newsSnapshot] = await Promise.all([
    fetchTwelveData(effectiveSymbol, effectiveTimeframe),
    fetchFredMacroData('FEDFUNDS'),
    fetchMarketNews(newsQuery)
  ]);

  emit?.({ type: 'freeze', market: marketSnapshot, macro: macroSnapshot, news: newsSnapshot });

  let record: AnalysisSessionRecord = {
    id: sessionId,
    created_at: createdAt,
    screenshot_url: screenshotUrl,
    screenshot_hash: screenshotHash,
    user_symbol: input.userSymbol,
    user_timeframe: input.userTimeframe,
    detected_symbol: visionMeta.detected_symbol,
    detected_timeframe: visionMeta.detected_timeframe,
    detected_current_price: visionMeta.detected_current_price,
    timeframe_mismatch_warning: timeframeMismatch,
    risk_amount: input.riskAmount,
    account_balance: input.accountBalance,
    desired_profit: input.desiredProfit,
    frozen_market_data: marketSnapshot,
    frozen_news_data: newsSnapshot,
    frozen_macro_data: macroSnapshot,
    vision_metadata: visionMeta,
    status: 'RUNNING',
    agent_analyses: [],
    debate: null,
    final_decision: null,
    position_sizing: null,
    outcome: null
  };
  await upsertSession(record);

  // HARD GUARD (no-fabrication mandate): if the screenshot yielded nothing
  // AND every live feed failed, refuse to run the council — asking an LLM to
  // analyze zero real data is how fabricated analyses are born.
  const allFeedsDown =
    marketSnapshot.status !== 'SUCCESS' &&
    macroSnapshot.status !== 'SUCCESS' &&
    newsSnapshot.status !== 'SUCCESS';
  const visionOffline = visionMeta.parse_state === 'OFFLINE';
  const visionFailed =
    visionMeta.detected_symbol === 'UNKNOWN' &&
    visionMeta.detected_current_price === null &&
    visionMeta.parse_confidence === 0;

  if (allFeedsDown && visionFailed) {
    const details = visionOffline
      ? `Every live data source (market, macro, news) failed AND the vision engine never reached a model (${visionMeta.parse_error_class}). ` +
        'Two independent outages: restore the LLM provider key/quota and the data feeds, then re-run. Nothing was fabricated in the meantime.'
      : 'All live data sources (market, macro, news) failed AND the screenshot could not be parsed. ' +
        'No analysis can be produced without real data — refusing to fabricate one. Retry when at least one source recovers.';
    record = { ...record, status: visionOffline ? 'PROVIDER_OUTAGE' : 'DATA_UNAVAILABLE', error: details };
    await upsertSession(record);

    const result: AnalysisApiResult = {
      success: false,
      status: visionOffline ? 'PROVIDER_OUTAGE' : 'DATA_UNAVAILABLE',
      details,
      sessionId,
      reusedFrozenSession: false,
      timeframeMismatchWarning: false,
      visionMetadata: visionMeta,
      voteDistribution: { buy: 0, sell: 0, noTrade: 0, offline: 0 },
      providerDiagnostics: {
        council_state: visionOffline ? 'OUTAGE' : 'HEALTHY',
        live_agents: 0,
        offline_agents: 0,
        dominant_error_class: visionOffline ? visionMeta.parse_error_class || 'UNKNOWN' : 'NONE',
        retry_after_ms: 0,
        providers_tried: visionOffline ? (visionMeta.parser_provider ? [visionMeta.parser_provider] : effectiveProviderOrder()) : [],
        skipped_agents: 10,
        remediation: visionOffline
          ? remediationFor((visionMeta.parse_error_class || 'UNKNOWN') as never, 0, [])
          : ['Restore at least one market feed (Twelve Data / FRED / News) or upload a legible chart, then re-run.'],
        run_budget_remaining_ms: Number.isFinite(budgetRemainingMs()) ? Math.round(budgetRemainingMs()) : -1,
        governor: governorSnapshot()
      },
      agentOutputs: [],
      debateResult: null,
      chiefJudgeVerdict: null,
      positionSizingResult: null,
      frozenMarketData: marketSnapshot,
      frozenMacroData: macroSnapshot,
      frozenNewsData: newsSnapshot,
      screenshotUrl
    };
    emit?.({ type: 'complete', result });
    return result;
  }

  const sessionPayload: SnapshotPayload = {
    sessionId,
    imageBufferBase64: imageBase64,
    imageMimeType: input.mimeType,
    visionMetadata: visionMeta,
    marketData: marketSnapshot,
    macroData: macroSnapshot,
    newsData: newsSnapshot,
    riskAmount: input.riskAmount,
    accountBalance: input.accountBalance,
    desiredProfit: input.desiredProfit,
    userSymbol: input.userSymbol,
    userTimeframe: input.userTimeframe
  };

  emit?.({ type: 'phase', phase: 2, label: 'Paced 10-agent independent analysis' });

  const batch = await executeAgentBatch(sessionPayload, (agentNumber, status, output) => {
    emit?.({ type: 'agent', agentNumber, status, output });
  });
  const agentOutputs = batch.outputs;
  const live = liveAgentCount(agentOutputs);
  const offline = offlineAgentCount(agentOutputs);
  const state = councilOutcome(agentOutputs.length, live);
  const remediation =
    state === 'HEALTHY' ? [] : remediationFor(batch.dominantErrorClass === 'NONE' ? 'UNKNOWN' : batch.dominantErrorClass, batch.retryAfterMs, batch.providersTried);

  const diagnostics: ProviderDiagnostics = {
    council_state: state,
    live_agents: live,
    offline_agents: offline,
    dominant_error_class: batch.dominantErrorClass,
    retry_after_ms: batch.retryAfterMs,
    providers_tried: batch.providersTried,
    skipped_agents: batch.skippedAgents,
    remediation,
    run_budget_remaining_ms: Number.isFinite(budgetRemainingMs()) ? Math.round(budgetRemainingMs()) : -1,
    governor: governorSnapshot()
  };
  emit?.({ type: 'providers', diagnostics });

  record = { ...record, agent_analyses: agentOutputs, provider_diagnostics: diagnostics };
  await upsertSession(record);

  // OUTAGE: no specialist reached a model. Debate and judge are still invoked —
  // both short-circuit locally without an API call — so the session records the
  // refusal explicitly instead of rendering a fake "final decision".
  emit?.({ type: 'phase', phase: 3, label: state === 'OUTAGE' ? 'Debate skipped — council offline' : 'Adversarial debate synthesis' });
  const debateResult = await runAdversarialDebate(agentOutputs, effectiveSymbol);
  emit?.({ type: 'debate', debate: debateResult });

  record = { ...record, debate: debateResult };
  await upsertSession(record);

  emit?.({ type: 'phase', phase: 4, label: 'Chief Judge decision engine' });
  const judgeOutput = await runChiefJudge(sessionPayload, agentOutputs, debateResult, {
    state,
    dominantErrorClass: batch.dominantErrorClass,
    retryAfterMs: batch.retryAfterMs,
    remediation
  });

  let positionSizingResult = null;
  const entryForSize = judgeOutput.entry.low ?? judgeOutput.entry.high;
  if (entryForSize && judgeOutput.stop_loss) {
    positionSizingResult = calculatePositionSize(
      effectiveSymbol,
      entryForSize,
      judgeOutput.stop_loss,
      input.riskAmount
    );
    if (positionSizingResult.positionSizeLots != null) {
      judgeOutput.position_size = positionSizingResult.positionSizeLots;
    }
  }

  if (judgeOutput.risk_reward == null) {
    const mid =
      judgeOutput.entry.low != null && judgeOutput.entry.high != null
        ? (judgeOutput.entry.low + judgeOutput.entry.high) / 2
        : entryForSize ?? null;
    judgeOutput.risk_reward = calculateRiskReward(mid, judgeOutput.stop_loss, judgeOutput.targets.tp1);
  }

  if (positionSizingResult?.warning) {
    judgeOutput.warnings = [...judgeOutput.warnings, positionSizingResult.warning];
  }

  emit?.({ type: 'judge', verdict: judgeOutput });

  const dataUnavailable =
    marketSnapshot.status === 'DATA_UNAVAILABLE' &&
    newsSnapshot.status === 'DATA_UNAVAILABLE' &&
    visionMeta.parse_confidence === 0;

  // Honest terminal state. An all-offline council is an infrastructure outage,
  // not a NO_TRADE verdict, and a partially answered council is a degraded one —
  // neither may be presented as a completed decision.
  const status: AnalysisApiResult['status'] = runStatusFor({ council: state, dataUnavailable });

  const details =
    status === 'PROVIDER_OUTAGE'
      ? `No LLM provider answered (${batch.dominantErrorClass}${batch.retryAfterMs ? `, backing off ~${Math.ceil(batch.retryAfterMs / 1000)}s` : ''}). ` +
        `${offline}/${agentOutputs.length} specialists never reached a model${batch.skippedAgents ? `, ${batch.skippedAgents} skipped without a request to protect the remaining quota` : ''}. ` +
        'No verdict was produced and none was fabricated. This session is not frozen — re-run the same screenshot once the provider recovers.'
      : status === 'PARTIAL'
        ? `Partial council: ${live}/${agentOutputs.length} specialists answered; ${offline} never reached a model. Verdict is weighted on live evidence only.`
        : undefined;

  const warnings = judgeOutput.warnings;
  judgeOutput.warnings = [...new Set([...warnings, ...batch.batchWarnings])];

  record = {
    ...record,
    final_decision: judgeOutput,
    position_sizing: positionSizingResult,
    provider_diagnostics: diagnostics,
    status: status === 'PARTIAL' ? 'PARTIAL' : status === 'PROVIDER_OUTAGE' ? 'PROVIDER_OUTAGE' : status === 'DATA_UNAVAILABLE' ? 'DATA_UNAVAILABLE' : 'COMPLETED',
    error: details
  };
  await upsertSession(record);

  const result: AnalysisApiResult = {
    success: status === 'COMPLETED' || status === 'PARTIAL',
    status,
    details,
    sessionId,
    reusedFrozenSession: false,
    timeframeMismatchWarning: timeframeMismatch,
    visionMetadata: visionMeta,
    voteDistribution: voteCountOf(agentOutputs),
    providerDiagnostics: diagnostics,
    agentOutputs,
    debateResult,
    chiefJudgeVerdict: judgeOutput,
    positionSizingResult,
    frozenMarketData: marketSnapshot,
    frozenMacroData: macroSnapshot,
    frozenNewsData: newsSnapshot,
    screenshotUrl
  };

  emit?.({ type: 'complete', result });
  return result;
}

export async function failSession(sessionId: string, message: string) {
  const { getSession } = await import('@/lib/db/store');
  const existing = await getSession(sessionId);
  if (!existing) return;
  existing.status = 'FAILED';
  existing.error = message;
  await upsertSession(existing);
}
