/**
 * The wire shapes of the aomi handover API.
 *
 * These mirror `bin/backend/src/endpoint/platform/handover.rs` in the aomi
 * backend. Everything the backend returns is listed here; there are no hidden
 * fields.
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
}

/** Response to status / activate / revoke. Never contains the token. */
export interface HandoverStatus {
  handover_id: number;
  state: HandoverState;
  external_account: string;
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
  external_account: string;
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
