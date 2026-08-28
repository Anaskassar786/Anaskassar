export interface MarketDataSnapshot {
  provider: string;
  symbol: string;
  timeframe: string;
  status: 'SUCCESS' | 'DATA_UNAVAILABLE';
  price?: number;
  candles?: Array<{ datetime: string; open: string; high: string; low: string; close: string; volume: string }>;
  error?: string;
}

export interface MacroDataSnapshot {
  provider: string;
  status: 'SUCCESS' | 'DATA_UNAVAILABLE';
  seriesId: string;
  latestValue?: string;
  latestDate?: string;
  error?: string;
}

export interface NewsDataSnapshot {
  provider: string;
  status: 'SUCCESS' | 'DATA_UNAVAILABLE';
  articles: Array<{ title: string; source: string; publishedAt: string; url: string }>;
  error?: string;
}

function env(name: string, fallback = ''): string {
  return process.env[name] || fallback;
}

export async function fetchTwelveData(symbol: string, timeframe: string): Promise<MarketDataSnapshot> {
  const apiKey = env('TWELVE_DATA_API_KEY');
  if (!apiKey) {
    return { provider: 'Twelve Data', symbol, timeframe, status: 'DATA_UNAVAILABLE', error: 'API_KEY_MISSING' };
  }

  const formattedSymbol = symbol.includes('/')
    ? symbol
    : symbol.toUpperCase().replace('XAUUSD', 'XAU/USD').replace(/^([A-Z]{3})([A-Z]{3})$/, '$1/$2');
  const intervalMap: Record<string, string> = {
    '1m': '1min',
    '5m': '5min',
    '15m': '15min',
    '30m': '30min',
    '1h': '1h',
    '4h': '4h',
    '1d': '1day',
    '1w': '1week'
  };
  const interval = intervalMap[timeframe.toLowerCase()] || '4h';

  try {
    const url = `${env('TWELVE_DATA_BASE_URL', 'https://api.twelvedata.com')}/time_series?symbol=${encodeURIComponent(formattedSymbol)}&interval=${interval}&outputsize=30&apikey=${apiKey}`;
    const res = await fetch(url, { cache: 'no-store' });
    const data = (await res.json()) as {
      status?: string;
      message?: string;
      values?: Array<{ datetime: string; open: string; high: string; low: string; close: string; volume: string }>;
    };

    if (data.status === 'error' || !data.values) {
      return {
        provider: 'Twelve Data',
        symbol: formattedSymbol,
        timeframe,
        status: 'DATA_UNAVAILABLE',
        error: data.message || 'Symbol not supported'
      };
    }

    const latestPrice = parseFloat(data.values[0].close);
    return {
      provider: 'Twelve Data',
      symbol: formattedSymbol,
      timeframe,
      status: 'SUCCESS',
      price: Number.isFinite(latestPrice) ? latestPrice : undefined,
      candles: data.values
    };
  } catch (err) {
    return {
      provider: 'Twelve Data',
      symbol: formattedSymbol,
      timeframe,
      status: 'DATA_UNAVAILABLE',
      error: err instanceof Error ? err.message : 'Network error'
    };
  }
}

export async function fetchFredMacroData(seriesId = 'FEDFUNDS'): Promise<MacroDataSnapshot> {
  const apiKey = env('FRED_API_KEY');
  if (!apiKey) {
    return { provider: 'FRED', seriesId, status: 'DATA_UNAVAILABLE', error: 'API_KEY_MISSING' };
  }

  try {
    const url = `${env('FRED_BASE_URL', 'https://api.stlouisfed.org/fred')}/series/observations?series_id=${encodeURIComponent(seriesId)}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=5`;
    const res = await fetch(url, { cache: 'no-store' });
    const data = (await res.json()) as {
      observations?: Array<{ value: string; date: string }>;
      error_message?: string;
    };

    if (!data.observations || data.observations.length === 0) {
      return {
        provider: 'FRED',
        seriesId,
        status: 'DATA_UNAVAILABLE',
        error: data.error_message || 'No observations found'
      };
    }

    return {
      provider: 'FRED',
      seriesId,
      status: 'SUCCESS',
      latestValue: data.observations[0].value,
      latestDate: data.observations[0].date
    };
  } catch (err) {
    return {
      provider: 'FRED',
      seriesId,
      status: 'DATA_UNAVAILABLE',
      error: err instanceof Error ? err.message : 'Network error'
    };
  }
}

export async function fetchMarketNews(query = 'gold price inflation Fed'): Promise<NewsDataSnapshot> {
  const apiKey = env('NEWS_API_KEY');
  if (!apiKey) {
    return { provider: 'News API', status: 'DATA_UNAVAILABLE', articles: [], error: 'API_KEY_MISSING' };
  }

  try {
    const url = `${env('NEWS_API_BASE_URL', 'https://newsapi.org')}/v2/everything?q=${encodeURIComponent(query)}&sortBy=publishedAt&pageSize=5&language=en&apiKey=${apiKey}`;
    const res = await fetch(url, { cache: 'no-store' });
    const data = (await res.json()) as {
      status?: string;
      message?: string;
      articles?: Array<{ title: string; source?: { name?: string }; publishedAt: string; url: string }>;
    };

    if (data.status !== 'ok' || !data.articles) {
      return {
        provider: 'News API',
        status: 'DATA_UNAVAILABLE',
        articles: [],
        error: data.message || 'News fetch failed'
      };
    }

    return {
      provider: 'News API',
      status: 'SUCCESS',
      articles: data.articles.map((a) => ({
        title: a.title,
        source: a.source?.name || 'Unknown',
        publishedAt: a.publishedAt,
        url: a.url
      }))
    };
  } catch (err) {
    return {
      provider: 'News API',
      status: 'DATA_UNAVAILABLE',
      articles: [],
      error: err instanceof Error ? err.message : 'Network error'
    };
  }
}

export async function probeProvider(
  name: string,
  url: string
): Promise<{ provider_name: string; endpoint_tested: string; status: 'PASS' | 'FAIL'; latency_ms: number; error_message?: string }> {
  const started = Date.now();
  try {
    const res = await fetch(url, { cache: 'no-store' });
    const latency = Date.now() - started;
    if (!res.ok) {
      return {
        provider_name: name,
        endpoint_tested: url.replace(/api[_-]?key=[^&]+/gi, 'apikey=REDACTED'),
        status: 'FAIL',
        latency_ms: latency,
        error_message: `HTTP ${res.status}`
      };
    }
    return {
      provider_name: name,
      endpoint_tested: url.replace(/api[_-]?key=[^&]+/gi, 'apikey=REDACTED'),
      status: 'PASS',
      latency_ms: latency
    };
  } catch (err) {
    return {
      provider_name: name,
      endpoint_tested: url.replace(/api[_-]?key=[^&]+/gi, 'apikey=REDACTED'),
      status: 'FAIL',
      latency_ms: Date.now() - started,
      error_message: err instanceof Error ? err.message : 'Network error'
    };
  }
}
