import { NextRequest, NextResponse } from 'next/server';
import { TradeOutcomeSchema } from '@/types/analysis';
import { recordOutcome } from '@/lib/db/store';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = TradeOutcomeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid outcome payload', details: parsed.error.flatten() }, { status: 400 });
  }

  const session = await recordOutcome(id, parsed.data);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  return NextResponse.json({ success: true, outcome: session.outcome });
}
