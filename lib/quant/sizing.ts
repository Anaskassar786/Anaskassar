export interface InstrumentSpec {
  symbol: string;
  contractSize: number;
  pipSize: number;
  pipValuePerLot: number;
}

export const INSTRUMENT_SPECS: Record<string, InstrumentSpec> = {
  'XAU/USD': { symbol: 'XAU/USD', contractSize: 100, pipSize: 0.01, pipValuePerLot: 1.0 },
  GOLD: { symbol: 'XAU/USD', contractSize: 100, pipSize: 0.01, pipValuePerLot: 1.0 },
  'EUR/USD': { symbol: 'EUR/USD', contractSize: 100000, pipSize: 0.0001, pipValuePerLot: 10.0 },
  'GBP/USD': { symbol: 'GBP/USD', contractSize: 100000, pipSize: 0.0001, pipValuePerLot: 10.0 },
  'AUD/USD': { symbol: 'AUD/USD', contractSize: 100000, pipSize: 0.0001, pipValuePerLot: 10.0 },
  'NZD/USD': { symbol: 'NZD/USD', contractSize: 100000, pipSize: 0.0001, pipValuePerLot: 10.0 },
  'USD/CAD': { symbol: 'USD/CAD', contractSize: 100000, pipSize: 0.0001, pipValuePerLot: 10.0 },
  'USD/CHF': { symbol: 'USD/CHF', contractSize: 100000, pipSize: 0.0001, pipValuePerLot: 10.0 },
  'USD/JPY': { symbol: 'USD/JPY', contractSize: 100000, pipSize: 0.01, pipValuePerLot: 6.7 },
  'EUR/JPY': { symbol: 'EUR/JPY', contractSize: 100000, pipSize: 0.01, pipValuePerLot: 6.7 },
  'GBP/JPY': { symbol: 'GBP/JPY', contractSize: 100000, pipSize: 0.01, pipValuePerLot: 6.7 }
};

export function normalizeInstrumentSymbol(symbol: string): string {
  const s = symbol.toUpperCase().replace(/\s+/g, '');
  if (s.includes('GOLD') || s === 'XAUUSD' || s === 'XAU/USD') return 'XAU/USD';
  if (s.includes('/')) return s;
  if (/^[A-Z]{6}$/.test(s)) return `${s.slice(0, 3)}/${s.slice(3)}`;
  return s;
}

export function calculatePositionSize(
  symbol: string,
  entryPrice: number,
  stopLossPrice: number,
  riskAmount: number
): { positionSizeLots: number | null; slDistancePips: number; warning?: string } {
  const normalizedSymbol = normalizeInstrumentSymbol(symbol);
  const spec = INSTRUMENT_SPECS[normalizedSymbol];

  if (!spec) {
    return {
      positionSizeLots: null,
      slDistancePips: 0,
      warning: `Unrecognized instrument spec for ${symbol}. Sizing unavailable.`
    };
  }

  const priceDistance = Math.abs(entryPrice - stopLossPrice);
  if (priceDistance === 0) {
    return { positionSizeLots: null, slDistancePips: 0, warning: 'Entry price and Stop Loss cannot be identical.' };
  }

  if (!Number.isFinite(riskAmount) || riskAmount <= 0) {
    return { positionSizeLots: null, slDistancePips: 0, warning: 'Risk amount must be a positive number.' };
  }

  const slDistancePips = priceDistance / spec.pipSize;
  const positionSizeLots = riskAmount / (slDistancePips * spec.pipValuePerLot);

  return {
    positionSizeLots: parseFloat(positionSizeLots.toFixed(2)),
    slDistancePips: parseFloat(slDistancePips.toFixed(1))
  };
}

export function calculateRiskReward(
  entry: number | null,
  stop: number | null,
  tp: number | null
): number | null {
  if (entry == null || stop == null || tp == null) return null;
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(tp - entry);
  if (risk === 0) return null;
  return parseFloat((reward / risk).toFixed(2));
}
