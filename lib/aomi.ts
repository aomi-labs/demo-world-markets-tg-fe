/**
 * Browser-direct client for the aomi handover API.
 *
 * ## Why there is no server in this file any more
 *
 * The previous version routed everything through Next route handlers so the
 * platform activation bearer could stay server-side. That bearer is a
 * **platform-wide** credential — whoever holds it can mint and revoke agent
 * links for every user of the venue — so hiding it was not optional.
 *
 * This app is open source and has no server to hide it in. So the credential
 * changed instead of the hiding place: each request now carries a signature
 * from the account owner's own wallet. That is strictly narrower than the
 * bearer ever was. A leaked signature authorizes one action on one handover;
 * a leaked bearer authorized everything.
 *
 * ## What the browser holds
 *
 * One thing, and only between issue and claim: a **status-only session**,
 * minted by aomi in the issue response. It reads this one handover's status and
 * nothing else — it cannot activate, cannot revoke, and has no renewal path.
 * The moment the page collects the claim result the session is spent
 * server-side; if it expires first, the user re-issues and re-scans.
 *
 * Keep it in memory. `sessionStorage` would survive a refresh, which is a
 * convenience and not a security property — anything that can read one can read
 * the other.
 */

import { buildSiweMessage, renderStatement, type HandoverStatement } from '@/lib/statement';
import { venueChain, venueOrigin } from '@/lib/venue';
import type { HandoverStatus, IssuedHandover, MintedNonce } from '@/lib/types';

/** Where the aomi API lives. Public: it is an address, not a secret. */
const BASE = (process.env.NEXT_PUBLIC_AOMI_BACKEND_URL ?? 'https://api.aomi.dev').replace(
  /\/$/,
  '',
);

/** The platform, as it appears in `/api/platforms/:name/...`. */
const PLATFORM = process.env.NEXT_PUBLIC_AOMI_PLATFORM_NAME ?? 'world-market-apps';

/** The header the status session travels on. Deliberately not `Authorization`. */
const SESSION_HEADER = 'X-Aomi-Handover-Session';

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
  options: { body?: unknown; session?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body) headers['Content-Type'] = 'application/json';
  if (options.session) headers[SESSION_HEADER] = options.session;

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: 'no-store',
  });

  const text = await response.text();
  // Most aomi failures arrive as `{ ok: false, error, error_code }`. A body
  // rejected by the HTTP layer before aomi sees it comes back as plain text,
  // and parsing that unguarded throws a JSON error that buries the real reason.
  let payload: { error?: string; error_code?: string } | null = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    throw new AomiApiError(
      response.status,
      payload?.error ?? text.trim() ?? `HTTP ${response.status}`,
      payload?.error_code,
    );
  }
  return (payload ?? {}) as T;
}

/** The injected provider, or a readable failure. */
function provider(): { request: (args: unknown) => Promise<unknown> } {
  const ethereum = (globalThis as { ethereum?: { request?: (a: unknown) => Promise<unknown> } })
    .ethereum;
  if (!ethereum?.request) throw new Error('No wallet found. Install or unlock one to continue.');
  return ethereum as { request: (args: unknown) => Promise<unknown> };
}

/**
 * Ask aomi what to sign, then sign exactly that.
 *
 * The statement comes back from the server rather than being composed here.
 * Both sides can render it — see `lib/statement.ts` — but only one of them gets
 * to decide, and it is the side that will verify. Signing the server's own
 * words removes a class of "the page and the backend disagreed" bug that would
 * otherwise surface as an unexplained rejection.
 *
 * The message string is signed and sent unchanged. Rebuilding it on the way out
 * could alter a byte, and the signature covers bytes.
 */
async function signForAomi(
  owner: string,
  request: { action: 'issue'; accountId: string } | { action: 'activate'; handoverId: number },
): Promise<{ siwe_message: string; siwe_signature: string }> {
  const nonce = await call<MintedNonce>(
    'POST',
    `/api/platforms/${PLATFORM}/telegram/handover/nonce`,
    {
      body:
        request.action === 'issue'
          ? { action: 'issue', owner_address: owner, account_id: request.accountId }
          : { action: 'activate', handover_id: request.handoverId },
    },
  );

  const message = buildSiweMessage({
    domain: nonce.domain,
    address: owner,
    statement: nonce.statement,
    uri: nonce.uri,
    chainId: nonce.chain_id,
    nonce: nonce.nonce,
  });

  const signature = (await provider().request({
    method: 'personal_sign',
    params: [message, owner],
  })) as string;

  return { siwe_message: message, siwe_signature: signature };
}

/** Render locally — for showing the user what they are about to approve. */
export function previewStatement(statement: HandoverStatement): string {
  return renderStatement(statement);
}

/** The wallet currently connected, prompting if necessary. */
export async function connectWallet(): Promise<string> {
  const accounts = (await provider().request({ method: 'eth_requestAccounts' })) as string[];
  const account = accounts?.[0];
  if (!account) throw new Error('Wallet returned no account.');
  return account;
}

/**
 * Mint a handover. **Signature one of two.**
 *
 * Fails with 409 when an `active` handover already holds this account's slot —
 * not retryable: replacing a live agent is an explicit revoke, never a side
 * effect of issuing again.
 *
 * The `platform_account_ref` sent here is proved on chain before anything is
 * written: aomi reads the venue registry in both directions and refuses if the
 * wallet does not own exactly that account.
 */
export async function issueHandover(
  owner: string,
  body: Record<string, unknown> & { platform_account_ref: string },
): Promise<IssuedHandover> {
  const signed = await signForAomi(owner, {
    action: 'issue',
    accountId: body.platform_account_ref,
  });
  return call<IssuedHandover>('POST', `/api/platforms/${PLATFORM}/telegram/handover`, {
    body: { ...body, ...signed },
  });
}

/**
 * Poll one handover with the status session.
 *
 * Two shapes, and the difference is the design:
 *
 * * while `pending`, this returns state and nothing else, as often as asked;
 * * on the **first call after Telegram claims**, it returns the claimed handle
 *   and the agent address — and spends the session doing it.
 *
 * So a `401` after a successful read is not a bug; it is the session having
 * done its job. A `401` *before* one means the session expired, and the only
 * way forward is a fresh issue — there is no re-auth.
 */
export function getHandoverStatus(
  botRegistrationId: string,
  handoverId: number,
  session: string,
): Promise<HandoverStatus> {
  return call<HandoverStatus>(
    'POST',
    `/api/platforms/${PLATFORM}/telegram/handover/${botRegistrationId}/${handoverId}/status`,
    { session },
  );
}

/**
 * Arm the agent key. **Signature two of two.**
 *
 * Call it only after the venue grant transaction has confirmed. aomi will not
 * take the page's word for it — it reads the account's live trader set and
 * refuses if the agent is not in it — so activating early fails rather than
 * arming something the venue has not authorized.
 */
export async function activateHandover(
  owner: string,
  botRegistrationId: string,
  handoverId: number,
): Promise<HandoverStatus> {
  const signed = await signForAomi(owner, { action: 'activate', handoverId });
  return call<HandoverStatus>(
    'POST',
    `/api/platforms/${PLATFORM}/telegram/handover/${botRegistrationId}/${handoverId}/activate`,
    { body: signed },
  );
}

/**
 * The bot handovers hang off.
 *
 * Public, and safe to be: it is an identifier, not a credential. The backend
 * pins the bot from its own venue config regardless of what a request names, so
 * a wrong value here is refused rather than honoured.
 */
export function botRegistrationId(): string {
  const bot = process.env.NEXT_PUBLIC_AOMI_BOT_REGISTRATION_ID;
  if (!bot) {
    throw new Error(
      'missing NEXT_PUBLIC_AOMI_BOT_REGISTRATION_ID — copy .env.example to .env.local',
    );
  }
  return bot;
}

/** The chain the venue lives on, for callers building the grant transaction. */
export const venueChainId = venueChain.id;
/** The origin the backend pins signatures to. Exported for the preview panel. */
export const siweOrigin = venueOrigin;
