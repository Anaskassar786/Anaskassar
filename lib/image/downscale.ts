/**
 * Browser-side image pre-flight.
 *
 * A full-screen TradingView PNG is routinely 3–5 MB. Sent verbatim, that is
 * ~30k vision tokens per call × (1 vision + 8 chart-reading specialists) — the
 * single biggest driver of the free-tier 429 that can take the whole council
 * down. Downscaling to a chart-legible size costs nothing analytically (the
 * models read candles and text, not retina pixels) and it happens before upload,
 * so the server never has to decode anything.
 */

export interface DownscaleOptions {
  /** Longest edge kept, in CSS pixels. Default 1400 (safe for free-tier vision quotas). */
  maxEdge?: number;
  /** JPEG quality for the resized copy. Default 0.85. */
  quality?: number;
  /** If the encoded copy is not smaller than this, keep the original. */
  minBenefitBytes?: number;
}

export interface DownscaleResult {
  blob: Blob;
  name: string;
  type: string;
  originalBytes: number;
  finalBytes: number;
  scaled: boolean;
  note: string;
}

function pickName(name: string, type: string): string {
  const base = (name || 'chart').replace(/\.[^.]*$/, '');
  const ext = type.includes('webp') ? 'webp' : type.includes('png') ? 'png' : 'jpg';
  return `${base}.${ext}`;
}

async function loadBitmap(source: Blob): Promise<{ width: number; height: number; draw: CanvasImageSource } | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(source);
      return { width: bmp.width, height: bmp.height, draw: bmp };
    } catch {
      /* fall through to <img> decoding */
    }
  }
  if (typeof Image === 'undefined' || typeof URL === 'undefined') return null;
  const url = URL.createObjectURL(source);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('image decode failed'));
      el.src = url;
    });
    return { width: img.naturalWidth, height: img.naturalHeight, draw: img };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function encode(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), type, quality);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Returns a copy safe to hand to a vision model. Never throws: if the browser
 * cannot decode or encode, the original file is passed through untouched and
 * the `note` explains that no downscale happened.
 */
export async function downscaleImage(file: File | Blob, name = 'chart.png', opts: DownscaleOptions = {}): Promise<DownscaleResult> {
  const maxEdge = opts.maxEdge ?? 1600;
  const quality = opts.quality ?? 0.85;
  const minBenefit = opts.minBenefitBytes ?? 24_000;
  const originalBytes = file.size;
  const fallback: DownscaleResult = {
    blob: file,
    name: pickName(name, file.type || 'image/png'),
    type: file.type || 'image/png',
    originalBytes,
    finalBytes: originalBytes,
    scaled: false,
    note: 'Upload passed through unchanged (no browser image pipeline available).'
  };

  if (typeof document === 'undefined') return fallback;
  if (originalBytes <= 220_000) {
    // Already small enough to be cheap on tokens — do not re-encode.
    return { ...fallback, note: 'Screenshot already small enough for the token budget.' };
  }

  const decoded = await loadBitmap(file);
  if (!decoded || !decoded.width || !decoded.height) return fallback;

  const scale = Math.min(1, maxEdge / Math.max(decoded.width, decoded.height));
  const targetW = Math.max(1, Math.round(decoded.width * scale));
  const targetH = Math.max(1, Math.round(decoded.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return fallback;
  // JPEG has no alpha: paint white so transparent PNG screenshots do not go black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, targetW, targetH);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(decoded.draw, 0, 0, targetW, targetH);

  const outType = 'image/jpeg';
  const blob = await encode(canvas, outType, quality);
  if (!blob) return fallback;

  if (blob.size >= originalBytes - minBenefit) {
    return {
      blob: file,
      name: pickName(name, file.type || 'image/png'),
      type: file.type || 'image/png',
      originalBytes,
      finalBytes: originalBytes,
      scaled: false,
      note: `Re-encode did not help (${Math.round(originalBytes / 1024)}KB kept).`
    };
  }

  return {
    blob,
    name: pickName(name, outType),
    type: outType,
    originalBytes,
    finalBytes: blob.size,
    scaled: true,
    note: `Downscaled ${decoded.width}×${decoded.height} → ${targetW}×${targetH}, ${Math.round(originalBytes / 1024)}KB → ${Math.round(blob.size / 1024)}KB`
  };
}
