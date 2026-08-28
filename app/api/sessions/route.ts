import { NextResponse } from 'next/server';
import { listSessions } from '@/lib/db/store';

export const dynamic = 'force-dynamic';

export async function GET() {
  const sessions = await listSessions();
  return NextResponse.json({ sessions });
}
