import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { screenshotDiskPath } from '@/lib/db/store';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ filename: string }> }) {
  const { filename } = await params;
  if (!filename || filename.includes('..') || filename.includes('/')) {
    return NextResponse.json({ error: 'Invalid filename' }, { status: 400 });
  }
  try {
    const buf = await fs.readFile(screenshotDiskPath(filename));
    const ext = filename.split('.').pop()?.toLowerCase();
    const mime =
      ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/png';
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'Content-Type': mime,
        'Cache-Control': 'public, max-age=31536000, immutable'
      }
    });
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
}
