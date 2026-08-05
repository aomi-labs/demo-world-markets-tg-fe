/**
 * POST /api/handover — issue a handover.
 *
 * Your origin, your session. In a real app this is where you authenticate the
 * user and derive `platform_account_ref` from *their* session — never from the
 * request body, or any logged-in user could mint an agent link for someone
 * else's account. The demo takes it from the body because it has no login.
 */
import { NextResponse } from 'next/server';

import { AomiApiError, issueHandover } from '@/lib/aomi';
import type { IssueRequest } from '@/lib/types';

export async function POST(request: Request) {
  let body: IssueRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  if (!body.platform_account_ref?.trim()) {
    return NextResponse.json(
      { error: 'platform_account_ref is required' },
      { status: 422 },
    );
  }

  try {
    const issued = await issueHandover({
      platform_account_ref: body.platform_account_ref.trim(),
      context: body.context,
      mandate: body.mandate,
      ttl_seconds: body.ttl_seconds,
    });
    return NextResponse.json(issued);
  } catch (error) {
    if (error instanceof AomiApiError) {
      // 409 means an active handover holds this account's slot. Pass the
      // status through so the UI can offer "revoke the existing agent"
      // rather than showing a generic failure and inviting a pointless retry.
      return NextResponse.json(
        { error: error.message, error_code: error.code },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'issue failed' },
      { status: 500 },
    );
  }
}
