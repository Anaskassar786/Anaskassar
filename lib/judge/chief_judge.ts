import { AgentOutput, ChiefJudgeOutputSchema, ChiefJudgeOutput } from '@/types/analysis';
import { DebateResult } from '@/lib/debate/engine';
import { SnapshotPayload } from '@/lib/execution/runner';
import { chatJson, isLlmUnavailable } from '@/lib/llm/client';
import { isOfflineAgent, type CouncilOutcome } from '@/lib/execution/offline';
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

interface CouncilHealth {
  state: CouncilOutcome;
  live: number;
  offline: number;
}

function coerceJudge(
  raw: Record<string, unknown>,
  fallbackVotes: DebateResult['voteSummary'],
  riskAmount: number,
  council?: CouncilHealth
): ChiefJudgeOutput {
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
    data_quality: normalizeDataQuality(raw.data_quality),
    // Council health is decided locally; a model must never get to rate its own
    // infrastructure as "HIGH quality" just because it wrote confident prose.
    ...(council ? { council_state: council.state, live_agents: council.live, offline_agents: council.offline } : {})
  };

  return ChiefJudgeOutputSchema.parse(candidate);
}

export interface JudgeCouncilMeta {
  state: CouncilOutcome;
  dominantErrorClass?: string;
  retryAfterMs?: number;
  remediation?: string[];
}

export async function runChiefJudge(
  sessionPayload: SnapshotPayload,
  agentOutputs: AgentOutput[],
  debateResult: DebateResult,
  councilMeta: JudgeCouncilMeta = { state: 'HEALTHY' }
): Promise<ChiefJudgeOutput & JudgeRunMeta> {
  const liveCount = agentOutputs.filter((a) => !isOfflineAgent(a)).length;
  const offlineCount = agentOutputs.length - liveCount;
  const council: CouncilHealth = {
    state: agentOutputs.length === 0 ? 'OUTAGE' : councilMeta.state,
    live: liveCount,
    offline: offlineCount
  };
  const remediation = councilMeta.remediation || [];
  const judgeSystemPrompt = `
You are the 11th Chief Judge AI of Trading AI AK.
Your task is to review all 10 independent agent reports, the adversarial debate, and frozen market snapshot to render the FINAL TRADING VERDICT.

STRICT JUDGMENT RULES:
1. Do NOT simply count votes. Evaluate evidence quality, timeframe alignment, and risk/reward.
2. NO_TRADE is a first-class decision. If structure is ambiguous, news risk is high, or R:R < 1:2, SELECT NO_TRADE.
3. Vote distribution percentage represents AGENT VOTE COUNT ONLY — NEVER present it as probability of winning.
4. Stop Loss must be derived from market structure invalidation (swing high/low, OB level). NEVER use arbitrary percentages.
5. NEVER fabricate prices, candles, indicators, API responses, backtests, win rates, or news. If data is missing, say DATA_UNAVAILABLE / INSUFFICIENT DATA.
6. council_health.offline_agents counts specialists that never reached a model. They are NOT NO_TRADE votes and must never be cited as evidence in either direction. When coverage is reduced, lower final_confidence and say so in decision_summary.
7. This system is decision-support only. It is NOT a broker and has NO execution capability.

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

  // HARD GUARD — council offline. Asking a rate-limited model to "judge" zero
  // live opinions is how a 429 turned into a confident-looking NO_TRADE. The
  // verdict below is produced locally, no provider is called, and it is labelled
  // OUTAGE so nobody can read it as a trading decision.
  if (agentOutputs.length > 0 && liveCount === 0) {
    const outage = coerceJudge(
      {
        final_decision: 'NO_TRADE',
        vote_distribution: { buy: 0, sell: 0, no_trade: 0 },
        final_confidence: 0,
        entry: { low: null, high: null },
        stop_loss: null,
        targets: { tp1: null, tp2: null, tp3: null },
        risk_amount: sessionPayload.riskAmount,
        position_size: null,
        risk_reward: null,
        decision_summary:
          `COUNCIL OFFLINE — ${offlineCount}/${agentOutputs.length} specialists never reached a model` +
          (councilMeta.dominantErrorClass ? ` (${councilMeta.dominantErrorClass})` : '') +
          '. This is NOT a NO_TRADE verdict: there was no analysis to judge. The terminal refuses to fabricate levels, conviction, or a trade.',
        strongest_bullish_arguments: [],
        strongest_bearish_arguments: [],
        rejected_arguments: ['No Round 1 evidence exists — every specialist call failed before a model answered'],
        invalidation_conditions: ['Re-run after the LLM provider answers; this session is never frozen for replay'],
        warnings: [
          'PROVIDER_OUTAGE: no verdict was produced. Fix the provider, then re-run the same screenshot.',
          councilMeta.retryAfterMs ? `Provider asked for a backoff of ~${Math.ceil(councilMeta.retryAfterMs / 1000)}s.` : ''
        ].filter(Boolean),
        remediation,
        data_quality: 'INSUFFICIENT'
      },
      debateResult.voteSummary,
      sessionPayload.riskAmount,
      council
    );
    return {
      ...outage,
      provider_error_class: councilMeta.dominantErrorClass || 'UNKNOWN',
      retry_after_ms: councilMeta.retryAfterMs || 0,
      chief_judge_model: 'local-guard',
      provider_used: 'none'
    };
  }

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
        warnings: ['INSUFFICIENT DATA: council answered but every specialist reported an empty evidence base — judge did not invent a setup'],
        remediation,
        data_quality: 'INSUFFICIENT'
      },
      debateResult.voteSummary,
      sessionPayload.riskAmount,
      council
    );
    return {
      ...fallback,
      provider_error_class: councilMeta.dominantErrorClass || 'NONE',
      retry_after_ms: councilMeta.retryAfterMs || 0,
      chief_judge_model: 'local-guard',
      provider_used: 'none'
    };
  }

  const userPayload = {
    council_health: {
      state: council.state,
      live_agents: council.live,
      offline_agents: council.offline,
      note:
        council.offline > 0
          ? `${council.offline} specialist(s) never reached a model and are excluded. Judge only the ${council.live} live report(s); do not treat missing agents as NO_TRADE votes; flag reduced coverage.`
          : 'All 10 specialists answered.'
    },
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
      // The judge is the last call of the run: waiting out a short 429 window
      // beats recording a fallback verdict (the run budget still bounds it).
      patient: true,
      messages: [
        { role: 'system', content: judgeSystemPrompt },
        { role: 'user', content: JSON.stringify(userPayload) }
      ]
    });

    const judged = coerceJudge(data, debateResult.voteSummary, sessionPayload.riskAmount, council);
    const withCoverage =
      council.offline > 0
        ? {
            ...judged,
            warnings: [
              ...judged.warnings,
              `REDUCED COVERAGE: only ${council.live}/${agentOutputs.length} specialists answered; the verdict is weighted on live evidence alone.`
            ]
          }
        : judged;
    return { ...withCoverage, chief_judge_model: model, provider_used: provider };
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
        warnings: [
          isLlmUnavailable(error)
            ? 'PROVIDER_OUTAGE: Chief Judge could not reach any LLM provider — verdict is the local refusal, not a model decision'
            : 'DATA_UNAVAILABLE: Chief Judge LLM call failed'
        ],
        remediation,
        data_quality: 'INSUFFICIENT'
      },
      debateResult.voteSummary,
      sessionPayload.riskAmount,
      council
    );
    return {
      ...fallback,
      provider_error_class: isLlmUnavailable(error) ? error.errorClass : 'UNKNOWN',
      retry_after_ms: isLlmUnavailable(error) ? error.retryAfterMs : 0,
      chief_judge_model: 'fallback',
      provider_used: 'none'
    };
  }
}
