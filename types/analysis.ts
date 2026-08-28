import { z } from 'zod';

export type TradingDecision = 'BUY' | 'SELL' | 'NO_TRADE';
export type DataQualityLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT';

export const VisionParserSchema = z.object({
  detected_symbol: z.string().describe('Canonical symbol e.g., XAU/USD, EUR/USD'),
  detected_timeframe: z.string().describe('e.g., 1m, 5m, 15m, 30m, 1h, 4h, 1d, 1w'),
  detected_current_price: z.number().nullable().describe('Current live price tag on right Y-axis'),
  candle_ohlc: z
    .object({
      open: z.number().nullable(),
      high: z.number().nullable(),
      low: z.number().nullable(),
      close: z.number().nullable()
    })
    .optional(),
  visible_indicators: z.array(z.string()),
  chart_platform: z.string().default('TradingView'),
  parse_confidence: z.number().min(0).max(100),
  raw_ocr_notes: z.string()
});
export type VisionParserOutput = z.infer<typeof VisionParserSchema>;

export const AgentOutputSchema = z.object({
  agent_number: z.number().min(1).max(10),
  agent_name: z.string(),
  decision: z.enum(['BUY', 'SELL', 'NO_TRADE']),
  confidence: z.number().min(0).max(100),
  evidence: z.array(z.string()),
  supporting_factors: z.array(z.string()),
  contradicting_factors: z.array(z.string()),
  entry_zone: z.object({
    low: z.number().nullable(),
    high: z.number().nullable()
  }),
  stop_loss: z.number().nullable(),
  take_profit_1: z.number().nullable(),
  take_profit_2: z.number().nullable(),
  take_profit_3: z.number().nullable(),
  risk_reward: z.number().nullable(),
  invalidation_conditions: z.array(z.string()),
  data_quality: z.enum(['HIGH', 'MEDIUM', 'LOW', 'INSUFFICIENT']),
  warnings: z.array(z.string())
});
export type AgentOutput = z.infer<typeof AgentOutputSchema>;

export const ChiefJudgeOutputSchema = z.object({
  final_decision: z.enum(['BUY', 'SELL', 'NO_TRADE']),
  vote_distribution: z.object({
    buy: z.number(),
    sell: z.number(),
    no_trade: z.number()
  }),
  final_confidence: z.number().min(0).max(100),
  entry: z.object({
    low: z.number().nullable(),
    high: z.number().nullable()
  }),
  stop_loss: z.number().nullable(),
  targets: z.object({
    tp1: z.number().nullable(),
    tp2: z.number().nullable(),
    tp3: z.number().nullable()
  }),
  risk_amount: z.number(),
  position_size: z.number().nullable(),
  risk_reward: z.number().nullable(),
  decision_summary: z.string(),
  strongest_bullish_arguments: z.array(z.string()),
  strongest_bearish_arguments: z.array(z.string()),
  rejected_arguments: z.array(z.string()),
  invalidation_conditions: z.array(z.string()),
  warnings: z.array(z.string()),
  data_quality: z.enum(['HIGH', 'MEDIUM', 'LOW', 'INSUFFICIENT'])
});
export type ChiefJudgeOutput = z.infer<typeof ChiefJudgeOutputSchema>;

export const TradeOutcomeSchema = z.object({
  outcome: z.enum(['WIN', 'LOSS', 'BREAKEVEN', 'SKIPPED']),
  actual_entry: z.number().nullable().optional(),
  actual_exit: z.number().nullable().optional(),
  actual_pnl: z.number().nullable().optional(),
  notes: z.string().optional(),
  post_analysis_review: z.string().optional()
});
export type TradeOutcome = z.infer<typeof TradeOutcomeSchema>;
