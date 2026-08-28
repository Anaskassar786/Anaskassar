import { NextRequest, NextResponse } from 'next/server';
import { failSession, runAnalysisPipeline } from '@/lib/pipeline/analyze';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

function envInt(name: string, fallback: number): number {
  const raw = (process.env[name] || '').trim();
  // An unset variable must fall back, not coerce to 0 — `Number('')` is 0, and a
  // silent 0 here once disabled every chart attachment and the upload guard.
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * A 4 MB TradingView PNG is ~5.4 MB of base64 and tens of thousands of vision
 * tokens per agent — that is what trips free-tier 429s before a single analysis
 * runs. Reject oversize uploads with an actionable message instead of silently
 * degrading the council.
 */
function uploadGuard(size: number, mime: string): string | null {
  const maxBytes = envInt('MAX_UPLOAD_BYTES', 12 * 1024 * 1024);
  if (size > maxBytes) {
    return `Screenshot is ${(size / 1024 / 1024).toFixed(1)}MB, over the ${(maxBytes / 1024 / 1024).toFixed(0)}MB limit. Export a smaller crop (or let the terminal downscale it) — oversized images are the most common cause of provider 429 rate limits.`;
  }
  if (mime && !mime.startsWith('image/')) {
    return `Expected an image upload, received "${mime}".`;
  }
  return null;
}

function parseNumber(value: FormDataEntryValue | null, fallback: number | null = null): number | null {
  if (value == null || value === '') return fallback;
  const n = parseFloat(String(value));
  return Number.isFinite(n) ? n : fallback;
}

export async function POST(req: NextRequest) {
  let sessionIdForFail: string | null = null;
  try {
    const formData = await req.formData();
    const imageFile = formData.get('screenshot') as File | null;
    const userSymbol = (formData.get('symbol') as string) || 'XAU/USD';
    const userTimeframe = (formData.get('timeframe') as string) || '4h';
    const riskAmount = parseNumber(formData.get('riskAmount'), 100) ?? 100;
    const accountBalance = parseNumber(formData.get('accountBalance'), null);
    const desiredProfit = parseNumber(formData.get('desiredProfit'), null);
    const reuseFrozen = String(formData.get('reuseFrozen') ?? 'true') !== 'false';
    const stream = String(formData.get('stream') ?? req.nextUrl.searchParams.get('stream') ?? '') === '1';

    if (!imageFile) {
      return NextResponse.json({ error: 'Screenshot file is required' }, { status: 400 });
    }

    const arrayBuffer = await imageFile.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mimeType = imageFile.type || 'image/png';

    const rejected = uploadGuard(buffer.byteLength, mimeType);
    if (rejected) {
      return NextResponse.json({ error: 'UPLOAD_REJECTED', details: rejected }, { status: 413 });
    }

    const input = {
      imageBuffer: buffer,
      mimeType,
      userSymbol,
      userTimeframe,
      riskAmount,
      accountBalance,
      desiredProfit,
      reuseFrozen
    };

    if (stream) {
      const encoder = new TextEncoder();
      const readable = new ReadableStream({
        async start(controller) {
          const send = (event: unknown) => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          };
          try {
            await runAnalysisPipeline(input, (event) => {
              if (event.type === 'session') sessionIdForFail = event.sessionId;
              send(event);
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown Server Error';
            send({ type: 'error', message });
            if (sessionIdForFail) await failSession(sessionIdForFail, message);
          } finally {
            controller.close();
          }
        }
      });

      return new Response(readable, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive'
        }
      });
    }

    const result = await runAnalysisPipeline(input, (event) => {
      if (event.type === 'session') sessionIdForFail = event.sessionId;
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error('Master Analysis Pipeline Error:', error);
    const message = error instanceof Error ? error.message : 'Unknown Server Error';
    if (sessionIdForFail) await failSession(sessionIdForFail, message);
    return NextResponse.json(
      {
        error: 'Analysis Execution Failed',
        details: message
      },
      { status: 500 }
    );
  }
}
