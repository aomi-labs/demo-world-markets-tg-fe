/**
 * GET /api/handover/:bot/:id — poll handover status.
 *
 * The `:bot` segment mirrors the aomi route shape so this demo reads like the
 * upstream contract. The server ignores it and uses its configured bot: the
 * bearer only authorizes bots your platform owns, and letting a client name
 * the bot adds an id to validate for no benefit.
 */
import { NextResponse } from 'next/server';

import { AomiApiError, getHandover } from '@/lib/aomi';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ bot: string; id: string }> },
) {
  const { id } = await params;
  const handoverId = Number(id);
  if (!Number.isInteger(handoverId)) {
    return NextResponse.json({ error: 'invalid handover id' }, { status: 400 });
  }

  try {
    return NextResponse.json(await getHandover(handoverId));
  } catch (error) {
    if (error instanceof AomiApiError) {
      // aomi answers 404 (not 403) for a handover you do not own, on purpose:
      // an unauthorized caller learns nothing about whether it exists. Do not
      // treat 404 as "bad id" in your UI copy.
      return NextResponse.json(
        { error: error.message, error_code: error.code },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'status failed' },
      { status: 500 },
    );
  }
}
