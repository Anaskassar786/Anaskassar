import crypto from 'crypto';
import { parseChartScreenshot } from '@/lib/vision/processor';
import { fetchFredMacroData, fetchMarketNews, fetchTwelveData } from '@/lib/data/ingestion';
import { executeAgentBatch, SnapshotPayload } from '@/lib/execution/runner';
import { runAdversarialDebate } from '@/lib/debate/engine';
import { runChiefJudge } from '@/lib/judge/chief_judge';
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

export interface AnalysisApiResult {
  success: boolean;
  status?: 'COMPLETED' | 'DATA_UNAVAILABLE' | 'FAILED';
  details?: string;
  sessionId: string;
  reusedFrozenSession?: boolean;
  timeframeMismatchWarning: boolean;
  visionMetadata: SnapshotPayload['visionMetadata'];
  voteDistribution: { buy: number; sell: number; noTrade: number };
  agentOutputs: unknown;
  debateResult: unknown;
  chiefJudgeVerdict: unknown;
  positionSizingResult: unknown;
  frozenMarketData: unknown;
  frozenMacroData: unknown;
  frozenNewsData: unknown;
  screenshotUrl: string;
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
  const screenshotHash = crypto.createHash('sha256').update(input.imageBuffer).digest('hex');

  if (input.reuseFrozen !== false) {
    const existing = await findCompletedByHash(screenshotHash);
    if (existing && existing.final_decision && existing.debate) {
      const result: AnalysisApiResult = {
        success: true,
        sessionId: existing.id,
        reusedFrozenSession: true,
        timeframeMismatchWarning: existing.timeframe_mismatch_warning,
        visionMetadata: existing.vision_metadata,
        voteDistribution: existing.debate.voteSummary,
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
  const visionFailed =
    visionMeta.detected_symbol === 'UNKNOWN' &&
    visionMeta.detected_current_price === null &&
    visionMeta.parse_confidence === 0;

  if (allFeedsDown && visionFailed) {
    const details =
      'All live data sources (market, macro, news) failed AND the screenshot could not be parsed. ' +
      'No analysis can be produced without real data — refusing to fabricate one. Retry when at least one source recovers.';
    record = { ...record, status: 'DATA_UNAVAILABLE', error: details };
    await upsertSession(record);

    const result: AnalysisApiResult = {
      success: false,
      status: 'DATA_UNAVAILABLE',
      details,
      sessionId,
      reusedFrozenSession: false,
      timeframeMismatchWarning: false,
      visionMetadata: visionMeta,
      voteDistribution: { buy: 0, sell: 0, noTrade: 0 },
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

  emit?.({ type: 'phase', phase: 2, label: 'Staggered 10-agent independent analysis' });

  const agentOutputs = await executeAgentBatch(sessionPayload, (agentNumber, status, output) => {
    emit?.({ type: 'agent', agentNumber, status, output });
  });

  record = { ...record, agent_analyses: agentOutputs };
  await upsertSession(record);

  emit?.({ type: 'phase', phase: 3, label: 'Adversarial debate synthesis' });
  const debateResult = await runAdversarialDebate(agentOutputs, effectiveSymbol);
  emit?.({ type: 'debate', debate: debateResult });

  record = { ...record, debate: debateResult };
  await upsertSession(record);

  emit?.({ type: 'phase', phase: 4, label: 'Chief Judge decision engine' });
  const judgeOutput = await runChiefJudge(sessionPayload, agentOutputs, debateResult);

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

  record = {
    ...record,
    final_decision: judgeOutput,
    position_sizing: positionSizingResult,
    status: dataUnavailable ? 'DATA_UNAVAILABLE' : 'COMPLETED'
  };
  await upsertSession(record);

  const result: AnalysisApiResult = {
    success: true,
    status: 'COMPLETED',
    sessionId,
    reusedFrozenSession: false,
    timeframeMismatchWarning: timeframeMismatch,
    visionMetadata: visionMeta,
    voteDistribution: debateResult.voteSummary,
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
