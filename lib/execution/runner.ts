import { AGENT_DEFINITIONS } from '@/lib/agents/definitions';
import { AgentOutputSchema, AgentOutput, VisionParserOutput } from '@/types/analysis';
import { chatJson, isCreditError, isPermanentLlmError, isRateLimitError } from '@/lib/llm/client';
import {
  asStringArray,
  clamp,
  normalizeDataQuality,
  normalizeDecision,
  numOrNull
} from '@/lib/llm/json';
import type { MarketDataSnapshot, MacroDataSnapshot, NewsDataSnapshot } from '@/lib/data/ingestion';

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
}

function insufficient(agentDef: (typeof AGENT_DEFINITIONS)[0], reason: string): AgentOutput {
  return {
    agent_number: agentDef.number,
    agent_name: agentDef.name,
    decision: 'NO_TRADE',
    confidence: 0,
    evidence: [reason],
    supporting_factors: [],
    contradicting_factors: ['API Rate Limit / Provider Error'],
    entry_zone: { low: null, high: null },
    stop_loss: null,
    take_profit_1: null,
    take_profit_2: null,
    take_profit_3: null,
    risk_reward: null,
    invalidation_conditions: ['Execution Failure'],
    data_quality: 'INSUFFICIENT',
    warnings: [`Agent ${agentDef.number} offline due to API error`]
  };
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
    warnings: asStringArray(raw.warnings)
  };
  return AgentOutputSchema.parse(candidate);
}

export async function executeAgentBatch(
  payload: SnapshotPayload,
  onProgress?: (agentNumber: number, status: string, output?: AgentOutput, meta?: AgentRunMeta) => void
): Promise<Array<AgentOutput & AgentRunMeta>> {
  const results: Array<AgentOutput & AgentRunMeta> = [];
  const BATCH_SIZE = 2;
  const DELAY_BETWEEN_BATCHES_MS = 6000;

  for (let i = 0; i < AGENT_DEFINITIONS.length; i += BATCH_SIZE) {
    const batch = AGENT_DEFINITIONS.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.all(
      batch.map(async (agentDef) => {
        if (onProgress) onProgress(agentDef.number, 'RUNNING');
        const { output, meta } = await callSingleAgentWithRetry(agentDef, payload);
        if (onProgress) onProgress(agentDef.number, 'COMPLETED', output, meta);
        return { ...output, ...meta };
      })
    );

    results.push(...batchResults);

    if (i + BATCH_SIZE < AGENT_DEFINITIONS.length) {
      await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_BATCHES_MS));
    }
  }

  return results;
}

function compactMarket(market: MarketDataSnapshot): MarketDataSnapshot {
  if (!market.candles || market.candles.length <= 12) return market;
  return { ...market, candles: market.candles.slice(0, 12) };
}

function compactNews(news: NewsDataSnapshot): NewsDataSnapshot {
  if (!news.articles || news.articles.length <= 5) return news;
  return { ...news, articles: news.articles.slice(0, 5) };
}

async function callSingleAgentWithRetry(
  agentDef: (typeof AGENT_DEFINITIONS)[0],
  payload: SnapshotPayload,
  retries = 2
): Promise<{ output: AgentOutput; meta: AgentRunMeta }> {
  let attempt = 0;
  let lastError = 'Unknown error';
  // Macro + news specialists work from frozen feeds; skip the screenshot to cut image-token spend.
  const attachChart = agentDef.number !== 8 && agentDef.number !== 9;

  while (attempt < retries) {
    try {
      const mime = payload.imageMimeType || 'image/png';
      const text = `ANALYSIS SNAPSHOT (IMMUTABLE):
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

      const userContent: Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      > = [{ type: 'text', text }];
      if (attachChart) {
        userContent.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${payload.imageBufferBase64}` } });
      }

      const { data, provider, model } = await chatJson<Record<string, unknown>>({
        prefer: ['openrouter', 'nvidia', 'gemini'],
        json: true,
        temperature: 0.15,
        timeoutMs: 55000,
        maxTokens: 4096,
        messages: [
          { role: 'system', content: agentDef.systemPrompt },
          { role: 'user', content: userContent }
        ]
      });

      return {
        output: coerceAgentOutput(data, agentDef),
        meta: { provider_used: provider, model_used: model }
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      attempt++;
      if (isCreditError(lastError) || (isPermanentLlmError(lastError) && !isRateLimitError(lastError))) {
        break;
      }
      const backoffMs = isRateLimitError(lastError) ? Math.pow(2, attempt) * 3000 : 2000;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }

  return {
    output: insufficient(agentDef, `Execution failed after ${retries} attempts: ${lastError}`),
    meta: { provider_used: 'none', model_used: 'fallback' }
  };
}
