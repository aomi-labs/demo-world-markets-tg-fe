/**
 * Server-only client for the aomi handover API.
 *
 * ## Why this file exists at all
 *
 * The platform activation bearer is a **secret**. It authorizes issuing and
 * revoking handovers for every bot your platform owns, so it must never reach
 * a browser. That is the whole reason this demo has server route handlers
 * instead of calling aomi directly from React: the browser talks to *your*
 * origin, and your origin holds the bearer.
 *
 * Copy this pattern. A partner that ships the bearer to the client has handed
 * out the ability to mint agent links for their entire user base.
 */
import 'server-only';

import type { HandoverStatus, IssueRequest, IssuedHandover } from './types';

/** Reads config at call time, not module load, so a missing var is a clear error. */
function config() {
  const base = process.env.AOMI_BACKEND_URL;
  const platform = process.env.AOMI_PLATFORM_NAME;
  const bearer = process.env.AOMI_PLATFORM_TOKEN;
  const bot = process.env.AOMI_BOT_REGISTRATION_ID;

  const missing = [
    ['AOMI_BACKEND_URL', base],
    ['AOMI_PLATFORM_NAME', platform],
    ['AOMI_PLATFORM_TOKEN', bearer],
    ['AOMI_BOT_REGISTRATION_ID', bot],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `missing env: ${missing.join(', ')} — copy .env.example to .env.local`,
    );
  }
  return {
    base: base!.replace(/\/$/, ''),
    platform: platform!,
    bearer: bearer!,
    bot: bot!,
  };
}

/** The bot registration this demo issues against. Safe to expose — it is an id, not a credential. */
export function botRegistrationId(): string {
  return config().bot;
}

export class AomiApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'AomiApiError';
  }
}

async function call<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const { base, bearer } = config();
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${bearer}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new AomiApiError(
      response.status,
      payload?.error ?? `HTTP ${response.status}`,
      payload?.error_code,
    );
  }
  return payload as T;
}

/**
 * Mint a handover and get the one-time token back.
 *
 * Fails with **409** when an `active` handover already holds this account's
 * slot. That is not a retryable error: replacing a live agent is an explicit
 * revoke, never a side effect of issuing again. Surface it as "this account
 * already has an agent" and offer the revoke.
 */
export function issueHandover(request: IssueRequest): Promise<IssuedHandover> {
  const { platform, bot } = config();
  return call<IssuedHandover>('POST', `/api/platforms/${platform}/telegram/handover`, {
    bot_registration_id: bot,
    ...request,
  });
}

export function getHandover(id: number): Promise<HandoverStatus> {
  const { platform, bot } = config();
  return call<HandoverStatus>(
    'GET',
    `/api/platforms/${platform}/telegram/handover/${bot}/${id}`,
  );
}

/**
 * Flip a claimed handover live.
 *
 * **Call this only after the venue grant transaction has confirmed.** The
 * backend takes your word for it — asserting it early grants no signing
 * capability (it only flips a row you already own), but it makes your own
 * status display lie about whether the agent can actually trade.
 */
export function activateHandover(id: number): Promise<HandoverStatus> {
  const { platform, bot } = config();
  return call<HandoverStatus>(
    'POST',
    `/api/platforms/${platform}/telegram/handover/${bot}/${id}/activate`,
  );
}

/**
 * Terminate a handover and tighten the agent key back to `denied`.
 *
 * Retry-safe: revoking an already-terminal handover reports current state
 * rather than failing. This stops aomi-side signing immediately; it does NOT
 * revoke on-chain authority — pair it with `revokeTradingForAccount` for the
 * unilateral fence.
 */
export function revokeHandover(id: number): Promise<HandoverStatus> {
  const { platform, bot } = config();
  return call<HandoverStatus>(
    'POST',
    `/api/platforms/${platform}/telegram/handover/${bot}/${id}/revoke`,
  );
}
