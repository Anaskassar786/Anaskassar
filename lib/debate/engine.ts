import { AgentOutput } from '@/types/analysis';
import { chatJson, isLlmUnavailable } from '@/lib/llm/client';
import { isOfflineAgent, type VoteCounts } from '@/lib/execution/offline';

export interface DebateResult {
  voteSummary: VoteCounts;
  liveAgents: number;
  offlineAgents: number;
  topBullishClaim: { agent: string; claim: string };
  topBearishClaim: { agent: string; claim: string };
  bullCounterargument: string;
  bearCounterargument: string;
  synthesisConclusion: string;
}

function strongest(agents: AgentOutput[]): AgentOutput | undefined {
  return [...agents].sort((a, b) => b.confidence - a.confidence)[0];
}

export async function runAdversarialDebate(agentOutputs: AgentOutput[], symbol: string): Promise<DebateResult> {
  // Offline specialists hold no opinion; they must not be counted as NO_TRADE.
  const live = agentOutputs.filter((a) => !isOfflineAgent(a));
  const offlineAgents = agentOutputs.length - live.length;
  const buyVotes = live.filter((a) => a.decision === 'BUY');
  const sellVotes = live.filter((a) => a.decision === 'SELL');
  const noTradeVotes = live.filter((a) => a.decision === 'NO_TRADE');

  const voteSummary = {
    buy: buyVotes.length,
    sell: sellVotes.length,
    noTrade: noTradeVotes.length,
    offline: offlineAgents
  };

  const topBull = strongest(buyVotes) || { agent_name: 'None', evidence: ['No bullish agent'] };
  const topBear = strongest(sellVotes) || { agent_name: 'None', evidence: ['No bearish agent'] };

  const allInsufficient = live.length === 0 || live.every((a) => a.data_quality === 'INSUFFICIENT');
  if (voteSummary.buy === 0 && voteSummary.sell === 0) {
    return {
      voteSummary,
      liveAgents: live.length,
      offlineAgents,
      topBullishClaim: { agent: topBull.agent_name, claim: topBull.evidence?.[0] || 'No bullish agent' },
      topBearishClaim: { agent: topBear.agent_name, claim: topBear.evidence?.[0] || 'No bearish agent' },
      bullCounterargument:
        live.length === 0
          ? `Debate not held — ${offlineAgents} of ${agentOutputs.length} specialists never reached a model.`
          : 'Debate skipped — no bullish specialist produced a BUY case.',
      bearCounterargument:
        live.length === 0
          ? 'No bearish case exists because no specialist ran. Nothing was invented to fill the gap.'
          : 'Debate skipped — no bearish specialist produced a SELL case.',
      synthesisConclusion:
        live.length === 0
          ? `Council offline (${offlineAgents}/${agentOutputs.length} agents OFFLINE). There is no Round 1 to debate and the Chief Judge must refuse rather than improvise.`
          : allInsufficient
            ? 'All live Round 1 specialists returned INSUFFICIENT DATA. Chief Judge must evaluate Round 1 directly. No fabricated debate arguments.'
            : 'Round 1 has no directional votes. Chief Judge must evaluate NO_TRADE evidence directly. Debate skipped to avoid fabricating arguments.'
    };
  }

  const prompt = `
You are the Debate Controller for Trading AI AK.
Symbol: ${symbol}

ROUND 1 VOTE DISTRIBUTION (agent counts ONLY — never treat as win probability):
- BUY: ${voteSummary.buy} agents
- SELL: ${voteSummary.sell} agents
- NO_TRADE: ${voteSummary.noTrade} agents
- OFFLINE (never reached a model, NOT counted as votes): ${offlineAgents} agents

TOP BULLISH CASE (${topBull.agent_name}):
${JSON.stringify('evidence' in topBull ? topBull.evidence : [])}

TOP BEARISH CASE (${topBear.agent_name}):
${JSON.stringify('evidence' in topBear ? topBear.evidence : [])}

FULL ROUND-1 BRIEF (live decisions only):
${live.map((a) => `${a.agent_number}. ${a.agent_name}: ${a.decision} conf=${a.confidence} dq=${a.data_quality}`).join('\n') || '(no live specialists)'}

TASK:
1. Construct the Bull's rebuttal against the Bearish argument.
2. Construct the Bear's counter-rebuttal against the Bullish argument.
3. Provide a neutral synthesis of the key structural conflict.

Return JSON strictly:
{
  "bullCounterargument": "...",
  "bearCounterargument": "...",
  "synthesisConclusion": "..."
}
`;

  try {
    const { data } = await chatJson<{
      bullCounterargument?: string;
      bearCounterargument?: string;
      synthesisConclusion?: string;
    }>({
      json: true,
      temperature: 0.3,
      timeoutMs: 45000,
      maxTokens: 2048,
      patient: true,
      messages: [{ role: 'user', content: prompt }]
    });

    return {
      voteSummary,
      liveAgents: live.length,
      offlineAgents,
      topBullishClaim: { agent: topBull.agent_name, claim: topBull.evidence?.[0] || 'N/A' },
      topBearishClaim: { agent: topBear.agent_name, claim: topBear.evidence?.[0] || 'N/A' },
      bullCounterargument: String(data.bullCounterargument || 'Debate unavailable'),
      bearCounterargument: String(data.bearCounterargument || 'Debate unavailable'),
      synthesisConclusion: String(data.synthesisConclusion || 'Chief Judge must evaluate Round 1 directly.')
    };
  } catch (error) {
    const note = isLlmUnavailable(error)
      ? 'Debate synthesis skipped — no LLM provider answered (council state preserved, nothing invented).'
      : 'Debate synthesis failed';
    return {
      voteSummary,
      liveAgents: live.length,
      offlineAgents,
      topBullishClaim: { agent: topBull.agent_name, claim: topBull.evidence?.[0] || note },
      topBearishClaim: { agent: topBear.agent_name, claim: topBear.evidence?.[0] || 'Debate synthesis failed' },
      bullCounterargument: 'Debate unavailable',
      bearCounterargument: 'Debate unavailable',
      synthesisConclusion: 'Chief Judge must evaluate Round 1 directly.'
    };
  }
}
