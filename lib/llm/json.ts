export function extractJsonObject(text: string): unknown {
  if (!text || typeof text !== 'string') {
    throw new Error('Empty model response');
  }

  let cleaned = text.trim();
  cleaned = cleaned.replace(/```json/gi, '```').replace(/```/g, '').trim();

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON object found in model response');
  }

  const slice = cleaned.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    const repaired = slice
      .replace(/,\s*}/g, '}')
      .replace(/,\s*]/g, ']')
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'");
    return JSON.parse(repaired);
  }
}

export function asStringArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item == null) return '';
        try {
          return typeof item === 'object' ? JSON.stringify(item) : String(item);
        } catch {
          return String(item);
        }
      })
      .filter(Boolean);
  }
  if (typeof value === 'string') return value ? [value] : [];
  return [String(value)];
}

export function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || value === 'N/A' || value === 'n/a') {
    return null;
  }
  const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export function normalizeDecision(value: unknown): 'BUY' | 'SELL' | 'NO_TRADE' {
  const raw = String(value ?? '')
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  if (raw.includes('BUY') || raw.includes('LONG')) return 'BUY';
  if (raw.includes('SELL') || raw.includes('SHORT')) return 'SELL';
  return 'NO_TRADE';
}

export function normalizeDataQuality(value: unknown): 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT' {
  const raw = String(value ?? '').toUpperCase();
  if (raw === 'HIGH' || raw === 'MEDIUM' || raw === 'LOW' || raw === 'INSUFFICIENT') return raw;
  if (raw.includes('INSUFF') || raw.includes('UNAVAIL') || raw.includes('MISSING')) return 'INSUFFICIENT';
  if (raw.includes('HIGH')) return 'HIGH';
  if (raw.includes('MED')) return 'MEDIUM';
  if (raw.includes('LOW')) return 'LOW';
  return 'INSUFFICIENT';
}
