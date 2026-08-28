/**
 * The canonical SIWE statement, mirrored from the backend.
 *
 * The wallet shows this line and the server verifies it — but the server does
 * not *parse* it. It rebuilds the expected string from its own record of the
 * nonce and compares the whole thing, byte for byte. So this file is one half
 * of a two-implementation contract, and the format is frozen.
 *
 * The Rust side lives at `aomi/crates/sign/src/handover_statement.rs` and has
 * the same golden strings in its tests. **Changing the wording, spacing, or
 * ordering here without changing it there produces signatures that verify
 * nowhere** — and the failure is a flat rejection, not a warning.
 *
 * Why one line: EIP-4361 gives the statement a single line before the field
 * block. A multi-line statement does not round-trip — the parser reads the
 * first line and the field block swallows the rest, dropping it silently.
 */

export type HandoverStatement =
  | { action: 'issue'; accountId: string }
  | { action: 'activate'; handoverId: number; agentAddress: string };

/** Matches `VENUE_LABEL` in the Rust module. Read by a human in a wallet popup. */
const VENUE_LABEL = 'Aomi World Markets';

/**
 * Render the statement exactly as the backend will rebuild it.
 *
 * The agent address is emitted verbatim. The server compares byte-exactly, so
 * normalising case here — and only here — would break every signature.
 */
export function renderStatement(statement: HandoverStatement): string {
  const head = `Authorize ${VENUE_LABEL} ${statement.action}:`;
  return statement.action === 'issue'
    ? `${head} account=${statement.accountId}`
    : `${head} handover=${statement.handoverId} agent=${statement.agentAddress}`;
}

/**
 * Build the EIP-4361 message the wallet signs.
 *
 * The field order and the blank lines are what the backend's parser expects:
 * the preamble line, the address, a blank line, the statement, a blank line,
 * then the fields. `Issued At` is ISO-8601 with a `Z`, which is what
 * `Date.toISOString()` produces and what the Rust parser reads.
 *
 * The returned string is what gets signed **and** what gets sent. It must not
 * be rebuilt on the way out: re-rendering could change a byte, and the
 * signature covers bytes, not intent.
 */
export function buildSiweMessage(params: {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  chainId: number;
  nonce: string;
  issuedAt?: Date;
}): string {
  const issuedAt = (params.issuedAt ?? new Date()).toISOString();
  return [
    `${params.domain} wants you to sign in with your Ethereum account:`,
    params.address,
    '',
    params.statement,
    '',
    `URI: ${params.uri}`,
    'Version: 1',
    `Chain ID: ${params.chainId}`,
    `Nonce: ${params.nonce}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');
}
