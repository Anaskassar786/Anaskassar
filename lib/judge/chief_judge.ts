import { AgentOutput, ChiefJudgeOutputSchema, ChiefJudgeOutput } from '@/types/analysis';
import { DebateResult } from '@/lib/debate/engine';
import { SnapshotPayload } from '@/lib/execution/runner';
import { chatJson } from '@/lib/llm/client';
import {
  asStringArray,
  clamp,
  normalizeDataQuality,
  normalizeDecision,
  numOrNull
} from '@/lib/llm/json';

export interface JudgeRunMeta {
  chief_judge_model: string;
  provider_used: string;
}

function coerceJudge(raw: Record<string, unknown>, fallbackVotes: DebateResult['voteSummary'], riskAmount: number): ChiefJudgeOutput {
  const votes = (raw.vote_distribution as Record<string, unknown> | undefined) || {};
  const entry = (raw.entry as Record<string, unknown> | undefined) || {};
  const targets = (raw.targets as Record<string, unknown> | undefined) || {};

  const candidate = {
    final_decision: normalizeDecision(raw.final_decision),
    vote_distribution: {
      buy: Number(votes.buy ?? fallbackVotes.buy) || 0,
      sell: Number(votes.sell ?? fallbackVotes.sell) || 0,
      no_trade: Number(votes.no_trade ?? votes.noTrade ?? fallbackVotes.noTrade) || 0
    },
    final_confidence: clamp(Number(raw.final_confidence) || 0, 0, 100),
    entry: {
      low: numOrNull(entry.low ?? raw.entry_low),
      high: numOrNull(entry.high ?? raw.entry_high)
    },
    stop_loss: numOrNull(raw.stop_loss),
    targets: {
      tp1: numOrNull(targets.tp1 ?? raw.tp1),
      tp2: numOrNull(targets.tp2 ?? raw.tp2),
      tp3: numOrNull(targets.tp3 ?? raw.tp3)
    },
    risk_amount: numOrNull(raw.risk_amount) ?? riskAmount,
    position_size: numOrNull(raw.position_size),
    risk_reward: numOrNull(raw.risk_reward),
    decision_summary: String(raw.decision_summary || 'INSUFFICIENT DATA'),
    strongest_bullish_arguments: asStringArray(raw.strongest_bullish_arguments),
    strongest_bearish_arguments: asStringArray(raw.strongest_bearish_arguments),
    rejected_arguments: asStringArray(raw.rejected_arguments),
    invalidation_conditions: asStringArray(raw.invalidation_conditions),
    warnings: asStringArray(raw.warnings),
    data_quality: normalizeDataQuality(raw.data_quality)
  };

  return ChiefJudgeOutputSchema.parse(candidate);
}

export async function runChiefJudge(
  sessionPayload: SnapshotPayload,
  agentOutputs: AgentOutput[],
  debateResult: DebateResult
): Promise<ChiefJudgeOutput & JudgeRunMeta> {
  const judgeSystemPrompt = `
You are the 11th Chief Judge AI of Trading AI AK.
Your task is to review all 10 independent agent reports, the adversarial debate, and frozen market snapshot to render the FINAL TRADING VERDICT.

STRICT JUDGMENT RULES:
1. Do NOT simply count votes. Evaluate evidence quality, timeframe alignment, and risk/reward.
2. NO_TRADE is a first-class decision. If structure is ambiguous, news risk is high, or R:R < 1:2, SELECT NO_TRADE.
3. Vote distribution percentage represents AGENT VOTE COUNT ONLY — NEVER present it as probability of winning.
4. Stop Loss must be derived from market structure invalidation (swing high/low, OB level). NEVER use arbitrary percentages.
5. NEVER fabricate prices, candles, indicators, API responses, backtests, win rates, or news. If data is missing, say DATA_UNAVAILABLE / INSUFFICIENT DATA.
6. This system is decision-support only. It is NOT a broker and has NO execution capability.

Return ONLY valid JSON:
{
  "final_decision": "BUY" | "SELL" | "NO_TRADE",
  "vote_distribution": { "buy": number, "sell": number, "no_trade": number },
  "final_confidence": 0-100,
  "entry": { "low": number|null, "high": number|null },
  "stop_loss": number|null,
  "targets": { "tp1": number|null, "tp2": number|null, "tp3": number|null },
  "risk_amount": number,
  "position_size": number|null,
  "risk_reward": number|null,
  "decision_summary": "string",
  "strongest_bullish_arguments": ["..."],
  "strongest_bearish_arguments": ["..."],
  "rejected_arguments": ["..."],
  "invalidation_conditions": ["..."],
  "warnings": ["..."],
  "data_quality": "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT"
}`;

  const directional = agentOutputs.filter((a) => a.decision === 'BUY' || a.decision === 'SELL');
  const allInsufficient = agentOutputs.length > 0 && agentOutputs.every((a) => a.data_quality === 'INSUFFICIENT');
  if (allInsufficient && directional.length === 0) {
    const fallback = coerceJudge(
      {
        final_decision: 'NO_TRADE',
        vote_distribution: {
          buy: debateResult.voteSummary.buy,
          sell: debateResult.voteSummary.sell,
          no_trade: debateResult.voteSummary.noTrade
        },
        final_confidence: 0,
        entry: { low: null, high: null },
        stop_loss: null,
        targets: { tp1: null, tp2: null, tp3: null },
        risk_amount: sessionPayload.riskAmount,
        position_size: null,
        risk_reward: null,
        decision_summary:
          'NO_TRADE — every specialist returned INSUFFICIENT DATA and there is no directional case to judge. The terminal will not fabricate levels, conviction, or a trade.',
        strongest_bullish_arguments: [],
        strongest_bearish_arguments: [],
        rejected_arguments: ['No Round 1 evidence quality sufficient to support BUY or SELL'],
        invalidation_conditions: ['Restore at least one live LLM provider and re-run (uncheck frozen replay if a prior failed session was stored)'],
        warnings: ['INSUFFICIENT DATA: council offline or feeds empty — judge did not invent a setup'],
        data_quality: 'INSUFFICIENT'
      },
      debateResult.voteSummary,
      sessionPayload.riskAmount
    );
    return { ...fallback, chief_judge_model: 'local-guard', provider_used: 'none' };
  }

  const userPayload = {
    vision_metadata: sessionPayload.visionMetadata,
    frozen_market_data: sessionPayload.marketData,
    frozen_macro_data: sessionPayload.macroData,
    frozen_news_data: sessionPayload.newsData,
    user_risk_amount: sessionPayload.riskAmount,
    account_balance: sessionPayload.accountBalance ?? null,
    agent_round1_analyses: agentOutputs,
    debate_synthesis: debateResult
  };

  try {
    const { data, provider, model } = await chatJson<Record<string, unknown>>({
      json: true,
      temperature: 0.2,
      timeoutMs: 70000,
      maxTokens: 4096,
      messages: [
        { role: 'system', content: judgeSystemPrompt },
        { role: 'user', content: JSON.stringify(userPayload) }
      ]
    });

    const judged = coerceJudge(data, debateResult.voteSummary, sessionPayload.riskAmount);
    return { ...judged, chief_judge_model: model, provider_used: provider };
  } catch (error) {
    const fallback = coerceJudge(
      {
        final_decision: 'NO_TRADE',
        vote_distribution: debateResult.voteSummary,
        final_confidence: 0,
        entry: { low: null, high: null },
        stop_loss: null,
        targets: { tp1: null, tp2: null, tp3: null },
        risk_amount: sessionPayload.riskAmount,
        position_size: null,
        risk_reward: null,
        decision_summary: `Chief Judge execution failed: ${error instanceof Error ? error.message : 'Unknown error'}. INSUFFICIENT DATA.`,
        strongest_bullish_arguments: [],
        strongest_bearish_arguments: [],
        rejected_arguments: ['Judge provider error'],
        invalidation_conditions: ['Judge unavailable'],
        warnings: ['DATA_UNAVAILABLE: Chief Judge LLM call failed'],
        data_quality: 'INSUFFICIENT'
      },
      debateResult.voteSummary,
      sessionPayload.riskAmount
    );
    return { ...fallback, chief_judge_model: 'fallback', provider_used: 'none' };
  }
}
