import { VisionParserSchema, VisionParserOutput } from '@/types/analysis';
import { chatJson, isLlmUnavailable } from '@/lib/llm/client';
import { asStringArray, clamp, numOrNull } from '@/lib/llm/json';

const SYSTEM_PROMPT = `
You are a high-precision OCR and financial chart vision parsing engine.
Examine the uploaded chart screenshot (e.g., TradingView).

EXTRACT EXACTLY:
1. Symbol: Find top-left ticker (e.g., "XAUUSD", "Gold Spot", "EURUSD"). Normalize to standard format: "XAU/USD", "EUR/USD", etc.
2. Timeframe: Find active timeframe tag (e.g., "4h", "15m", "D", "1D"). Normalize to 1m, 5m, 15m, 30m, 1h, 4h, 1d, 1w.
3. Current Price: Find the horizontal price line or current price callout badge on the right Y-axis (e.g., 4602.370).
4. Candle OHLC text if visible on top header.
5. Visible indicators listed (e.g., "EMA 10", "Pivots", "Fibonacci").

If a field cannot be read, use null / UNKNOWN / empty array. NEVER invent a price.

Return ONLY valid JSON matching this structure:
{
  "detected_symbol": "XAU/USD",
  "detected_timeframe": "4h",
  "detected_current_price": 4602.37,
  "candle_ohlc": { "open": 4373.78, "high": 4397.06, "low": 4370.32, "close": 4386.01 },
  "visible_indicators": ["3 EMA", "Pivots Fibonacci Auto"],
  "chart_platform": "TradingView",
  "parse_confidence": 95,
  "raw_ocr_notes": "Extracted from header bar and price scale"
}
`;

function normalizeTimeframe(raw: unknown): string {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
  if (!s || s === 'unknown') return 'UNKNOWN';
  const map: Record<string, string> = {
    '1': '1m',
    '1m': '1m',
    '1min': '1m',
    '5': '5m',
    '5m': '5m',
    '5min': '5m',
    '15': '15m',
    '15m': '15m',
    '15min': '15m',
    '30': '30m',
    '30m': '30m',
    '30min': '30m',
    '60': '1h',
    '1h': '1h',
    h: '1h',
    '60m': '1h',
    '4h': '4h',
    '240': '4h',
    d: '1d',
    '1d': '1d',
    day: '1d',
    daily: '1d',
    w: '1w',
    '1w': '1w',
    week: '1w',
    weekly: '1w'
  };
  return map[s] || s;
}

function normalizeSymbol(raw: unknown): string {
  const s = String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  if (!s || s === 'UNKNOWN') return 'UNKNOWN';
  if (s.includes('GOLD') || s === 'XAUUSD' || s === 'XAU/USD') return 'XAU/USD';
  if (s.includes('/')) return s;
  if (/^[A-Z]{6}$/.test(s)) return `${s.slice(0, 3)}/${s.slice(3)}`;
  return s;
}

/**
 * Vision is the first LLM call of a run, so it is deliberately impatient
 * (one attempt, short wait): a rate-limited provider must be discovered in
 * seconds, before the council spends the remaining quota. The agent runner's
 * canary is the patient one.
 */
export async function parseChartScreenshot(base64Image: string, mimeType = 'image/png'): Promise<VisionParserOutput> {
  try {
    const { data, provider, model } = await chatJson<Record<string, unknown>>({
      json: true,
      timeoutMs: 45000,
      maxTokens: 2048,
      attemptsPerProvider: 1,
      patient: false,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Extract metadata from this chart screenshot. Return JSON only.' },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } }
          ]
        }
      ]
    });

    const candle = (data.candle_ohlc || {}) as Record<string, unknown>;
    const parsed = {
      detected_symbol: normalizeSymbol(data.detected_symbol),
      detected_timeframe: normalizeTimeframe(data.detected_timeframe),
      detected_current_price: numOrNull(data.detected_current_price),
      candle_ohlc: {
        open: numOrNull(candle.open),
        high: numOrNull(candle.high),
        low: numOrNull(candle.low),
        close: numOrNull(candle.close)
      },
      visible_indicators: asStringArray(data.visible_indicators),
      chart_platform: String(data.chart_platform || 'TradingView'),
      parse_confidence: clamp(Number(data.parse_confidence) || 0, 0, 100),
      raw_ocr_notes: String(data.raw_ocr_notes || ''),
      parse_state: 'LIVE',
      parse_error_class: 'NONE',
      parse_error: '',
      parser_provider: provider,
      parser_model: model
    };

    return VisionParserSchema.parse(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const outage = isLlmUnavailable(error) ? error : null;
    console.error('Vision Parsing Error:', message);
    return VisionParserSchema.parse({
      detected_symbol: 'UNKNOWN',
      detected_timeframe: 'UNKNOWN',
      detected_current_price: null,
      visible_indicators: [],
      chart_platform: 'TradingView',
      parse_confidence: 0,
      // Honest split: OFFLINE = no model answered; NO_TEXT = a model looked and
      // could not read the chart. The pipeline treats these completely differently.
      parse_state: outage ? 'OFFLINE' : 'NO_TEXT',
      parse_error_class: outage ? outage.errorClass : 'EMPTY',
      parse_error: message.slice(0, 600),
      raw_ocr_notes: outage
        ? `Vision engine offline: ${message}`.slice(0, 600)
        : `Chart produced no readable metadata: ${message}`.slice(0, 600),
      parser_provider: '',
      parser_model: ''
    });
  }
}
