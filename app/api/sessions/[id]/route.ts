import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/db/store';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  return NextResponse.json({
    success: true,
    sessionId: session.id,
    reusedFrozenSession: true,
    timeframeMismatchWarning: session.timeframe_mismatch_warning,
    visionMetadata: session.vision_metadata,
    voteDistribution: session.debate?.voteSummary ?? { buy: 0, sell: 0, noTrade: 0 },
    agentOutputs: session.agent_analyses,
    debateResult: session.debate,
    chiefJudgeVerdict: session.final_decision,
    positionSizingResult: session.position_sizing,
    frozenMarketData: session.frozen_market_data,
    frozenMacroData: session.frozen_macro_data,
    frozenNewsData: session.frozen_news_data,
    screenshotUrl: session.screenshot_url,
    outcome: session.outcome,
    status: session.status,
    createdAt: session.created_at,
    userSymbol: session.user_symbol,
    userTimeframe: session.user_timeframe,
    riskAmount: session.risk_amount
  });
}
