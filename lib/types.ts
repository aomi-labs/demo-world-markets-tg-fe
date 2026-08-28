/**
 * The wire shapes of the aomi handover API.
 *
 * These mirror `aomi/bin/manager/src/platform/handover.rs` and
 * `handover_wallet.rs`. Everything the backend returns is listed here; there
 * are no hidden fields.
 */

/** The handover lifecycle. `expired` is derived from `expires_at`, not stored. */
export type HandoverState =
  | 'pending'
  | 'claimed'
  | 'active'
  | 'expired'
  | 'revoked';

/**
 * Response to a successful issue. `token` appears **exactly once, here** — the
 * backend stores only its hash and can never show it again. Lose it and the
 * only recovery is to issue a new handover.
 */
export interface IssuedHandover {
  handover_id: number;
  token: string;
  state: HandoverState;
  /** Unix seconds. The claim window; short by design. */
  expires_at: number;
  /** The bot to build the deep link against, e.g. `world_markets_bot`. */
  bot_username: string | null;
  /**
   * The status-only session, returned **exactly once, here**. Only its hash is
   * stored, under a different type domain from `token`, so neither can be
   * presented as the other.
   *
   * It reads this one handover's status and nothing else, and it is spent
   * server-side the moment the page collects the claim result. Absent on the
   * platform-bearer channel, which has no browser to hand it to.
   */
  session?: string;
  /** Unix seconds. Independent of `expires_at` — it has to outlast a trip to Telegram. */
  session_expires_at?: number | null;
}

/**
 * What the backend says to sign.
 *
 * `statement` is authoritative: the browser signs the server's own words rather
 * than composing its own, because the server rebuilds and compares this string
 * whole when the signature comes back.
 */
export interface MintedNonce {
  nonce: string;
  statement: string;
  domain: string;
  uri: string;
  chain_id: number;
  expires_at: number;
}

/** Response to status / activate / revoke. Never contains the token. */
export interface HandoverStatus {
  handover_id: number;
  state: HandoverState;
  /**
   * Set when the handover reached a terminal state without producing a result —
   * the QR ran out, or it was revoked.
   *
   * Distinct from a `401` on purpose. The session outlives the 90-second claim
   * window, so an expired QR is a perfectly valid session reporting bad news;
   * reading the status code alone cannot tell that from a session that actually
   * went bad, and the two need different copy.
   */
  restart_required?: boolean;
  /** Absent while the handover is still `pending` — there is nothing to report yet. */
  platform_account_ref?: string;
  /** Telegram @handle of whoever claimed, once `claimed`. */
  claimed_handle: string | null;
  /**
   * The agent address to grant venue authority to. Null until `claimed` —
   * the key is provisioned during the claim, not at issue time.
   */
  agent_address: string | null;
  expires_at: number;
  claimed_at: number | null;
  activated_at: number | null;
  revoked_at: number | null;
}

/** Every aomi platform endpoint fails in this envelope. */
export interface ApiError {
  ok: false;
  error: string;
  error_code?: string;
}

export interface IssueRequest {
  platform_account_ref: string;
  /** The EIP-4361 message, verbatim as signed. Never re-serialize it. */
  siwe_message?: string;
  siwe_signature?: string;
  /**
   * Opaque to the backend — never interpreted for a decision. By convention
   * `summary` (else `intent`) is rendered in the agent's first Telegram
   * message, which is what makes the greeting contextual.
   */
  context?: Record<string, unknown>;
  /**
   * Opaque to the backend. Enforced by the venue app's tools at trade time,
   * NOT by the handover layer. Writing a limit here does not enforce it.
   */
  mandate?: Record<string, unknown>;
  /** Defaults to 90s server-side, clamped to 600s. */
  ttl_seconds?: number;
}
