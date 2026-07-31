/**
 * POST /api/handover/:bot/:id/revoke — kill the agent.
 *
 * Stops aomi-side signing immediately by tightening the agent key to `denied`.
 * It does **not** touch on-chain authority: pair it with
 * `revokeTradingForAccount` so the owner keeps a unilateral fence that does
 * not depend on us being reachable.
 *
 * Retry-safe — revoking a terminal handover reports current state rather than
 * failing.
 */
import { NextResponse } from 'next/server';

import { AomiApiError, revokeHandover } from '@/lib/aomi';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ bot: string; id: string }> },
) {
  const { id } = await params;
  const handoverId = Number(id);
  if (!Number.isInteger(handoverId)) {
    return NextResponse.json({ error: 'invalid handover id' }, { status: 400 });
  }

  try {
    return NextResponse.json(await revokeHandover(handoverId));
  } catch (error) {
    if (error instanceof AomiApiError) {
      return NextResponse.json(
        { error: error.message, error_code: error.code },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'revoke failed' },
      { status: 500 },
    );
  }
}
