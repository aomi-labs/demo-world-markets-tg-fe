/**
 * POST /api/handover/:bot/:id/activate — assert the venue grant landed.
 *
 * The client sends the grant transaction hash. The demo requires it as a
 * discipline: activate is *partner-asserted*, so the only thing stopping you
 * from activating before the grant confirms is your own code. A production
 * integration should go further and verify the receipt (or read
 * `TraderPermission`) server-side before calling through.
 */
import { NextResponse } from 'next/server';

import { AomiApiError, activateHandover } from '@/lib/aomi';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ bot: string; id: string }> },
) {
  const { id } = await params;
  const handoverId = Number(id);
  if (!Number.isInteger(handoverId)) {
    return NextResponse.json({ error: 'invalid handover id' }, { status: 400 });
  }

  let grantTxHash: unknown;
  try {
    ({ grantTxHash } = await request.json());
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  if (typeof grantTxHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(grantTxHash)) {
    return NextResponse.json(
      { error: 'grantTxHash (the confirmed allowTradingForAccount tx) is required' },
      { status: 422 },
    );
  }

  try {
    return NextResponse.json(await activateHandover(handoverId));
  } catch (error) {
    if (error instanceof AomiApiError) {
      // 409 = not in `claimed` state. Already-`active` is treated as success
      // upstream (activate is retry-safe), so a 409 here means the handover
      // expired or was revoked before you got the grant confirmed.
      return NextResponse.json(
        { error: error.message, error_code: error.code },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'activate failed' },
      { status: 500 },
    );
  }
}
