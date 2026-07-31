'use client';

/**
 * The whole handover, end to end.
 *
 * Read this top to bottom and you have the integration. The ordering is not a
 * UI preference — it is the security model:
 *
 *   issue -> QR -> claim (in Telegram) -> grant on-chain -> activate
 *
 * The grant lands *after* the claim, against an agent address that did not
 * exist when the QR was rendered. That is what makes a leaked QR worthless.
 * Do not reorder these steps.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createWalletClient, custom, type Address } from 'viem';

import { QrPanel } from './QrPanel';
import { StepCard, type StepStatus } from './StepCard';
import { concordUserAbi, exchangeAddress, megaeth } from '@/lib/venue';
import type { HandoverStatus, IssuedHandover } from '@/lib/types';

/** Poll cadence while waiting for a scan. Fast enough to feel live, slow enough to be polite. */
const POLL_MS = 2000;

type Phase = 'setup' | 'awaiting-scan' | 'claimed' | 'granting' | 'active' | 'revoked';

export function HandoverFlow({ botRegistrationId }: { botRegistrationId: string }) {
  const [accountId, setAccountId] = useState('1');
  const [summary, setSummary] = useState('Short ETH perp, 2x, from the ETH-PERP page');
  const [maxNotional, setMaxNotional] = useState('25000');

  const [phase, setPhase] = useState<Phase>('setup');
  const [issued, setIssued] = useState<IssuedHandover | null>(null);
  const [status, setStatus] = useState<HandoverStatus | null>(null);
  const [grantTxHash, setGrantTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  async function issue() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/handover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          external_account: accountId.trim(),
          // `summary` is the one context key with a convention attached: the
          // agent reads it (display only) for its first message. Everything
          // else here is yours to shape.
          context: {
            summary,
            venue: 'world-markets',
            chain_id: megaeth.id,
          },
          // Opaque to aomi. Your venue app's tools enforce it at trade time —
          // writing a number here does not, by itself, cap anything.
          mandate: {
            max_notional_usd: Number(maxNotional) || 0,
            instruments: ['ETH-PERP'],
            can_withdraw: false,
          },
          ttl_seconds: 120,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? `HTTP ${response.status}`);
      }
      setIssued(payload);
      setStatus(null);
      setPhase('awaiting-scan');
      startPolling(payload.handover_id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'issue failed');
    } finally {
      setBusy(false);
    }
  }

  function startPolling(handoverId: number) {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const response = await fetch(
          `/api/handover/${botRegistrationId}/${handoverId}`,
          { cache: 'no-store' },
        );
        if (!response.ok) return;
        const next: HandoverStatus = await response.json();
        setStatus(next);
        if (next.state === 'claimed') {
          stopPolling();
          setPhase('claimed');
        } else if (next.state === 'expired' || next.state === 'revoked') {
          stopPolling();
        }
      } catch {
        // Transient — keep polling. A dropped request is not a failed handover.
      }
    }, POLL_MS);
  }

  /**
   * The custody step. Signed by the account owner in this browser session,
   * never by the agent and never in Telegram.
   */
  async function grantVenueAuthority() {
    if (!status?.agent_address) return;
    setBusy(true);
    setError(null);
    setPhase('granting');
    try {
      const ethereum = (globalThis as { ethereum?: unknown }).ethereum;
      if (!ethereum) throw new Error('no injected wallet found');

      const wallet = createWalletClient({
        chain: megaeth,
        transport: custom(ethereum as Parameters<typeof custom>[0]),
      });
      const [account] = await wallet.requestAddresses();

      const hash = await wallet.writeContract({
        account,
        address: exchangeAddress,
        abi: concordUserAbi,
        functionName: 'allowTradingForAccount',
        args: [BigInt(accountId), status.agent_address as Address],
      });
      setGrantTxHash(hash);
      // Deliberately NOT auto-activating: activate is an assertion that this
      // transaction confirmed. Confirm it, then assert it.
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'grant failed');
      setPhase('claimed');
    } finally {
      setBusy(false);
    }
  }

  async function activate() {
    if (!issued || !grantTxHash) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/handover/${botRegistrationId}/${issued.handover_id}/activate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ grantTxHash }),
        },
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setStatus(payload);
      setPhase('active');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'activate failed');
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!issued) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/handover/${botRegistrationId}/${issued.handover_id}/revoke`,
        { method: 'POST' },
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setStatus(payload);
      setPhase('revoked');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'revoke failed');
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    stopPolling();
    setIssued(null);
    setStatus(null);
    setGrantTxHash(null);
    setError(null);
    setPhase('setup');
  }

  const expired = status?.state === 'expired';
  const deepLink =
    issued && issued.bot_username
      ? `https://t.me/${issued.bot_username}?start=${issued.token}`
      : null;

  const stepStatus = (step: Phase[], done: Phase[]): StepStatus => {
    if (done.includes(phase)) return 'done';
    if (step.includes(phase)) return 'active';
    return 'idle';
  };

  return (
    <div className="flow">
      {error ? (
        <div className="banner banner--error" role="alert">
          {error}
        </div>
      ) : null}

      <StepCard
        index={1}
        title="Describe the intent"
        subtitle="What the user was looking at when they reached for the agent."
        status={phase === 'setup' ? 'active' : 'done'}
      >
        <div className="fields">
          <label className="field">
            <span>Venue account id</span>
            <input
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              disabled={phase !== 'setup'}
              inputMode="numeric"
            />
            <small>
              The venue&apos;s <code>uint64</code> account. Sent to aomi as{' '}
              <code>external_account</code> and used as <code>accountId</code> in the
              grant — keep them identical.
            </small>
          </label>

          <label className="field">
            <span>context.summary</span>
            <input
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              disabled={phase !== 'setup'}
            />
            <small>
              Display only. The agent reads it for its opening message; nothing in{' '}
              <code>context</code> is ever interpreted for a decision.
            </small>
          </label>

          <label className="field">
            <span>mandate.max_notional_usd</span>
            <input
              value={maxNotional}
              onChange={(event) => setMaxNotional(event.target.value)}
              disabled={phase !== 'setup'}
              inputMode="numeric"
            />
            <small>
              Opaque to aomi. <strong>Your venue app enforces this</strong> at trade
              time — the handover layer does not.
            </small>
          </label>
        </div>

        {phase === 'setup' ? (
          <button className="btn btn--primary" onClick={issue} disabled={busy}>
            {busy ? 'issuing…' : 'Issue handover'}
          </button>
        ) : null}
      </StepCard>

      <StepCard
        index={2}
        title="Scan to connect"
        subtitle="One-time token, short TTL, zero authority."
        status={stepStatus(['awaiting-scan'], ['claimed', 'granting', 'active', 'revoked'])}
      >
        {deepLink && phase === 'awaiting-scan' ? (
          <>
            <QrPanel
              deepLink={deepLink}
              expiresAt={issued!.expires_at}
              onExpired={() => setStatus((s) => (s ? { ...s, state: 'expired' } : s))}
            />
            {expired ? (
              <div className="banner">
                Code expired — nothing was lost, just issue a new one.
                <button className="btn" onClick={reset}>
                  Start over
                </button>
              </div>
            ) : (
              <p className="hint">Waiting for a scan… polling every {POLL_MS / 1000}s.</p>
            )}
          </>
        ) : issued && !deepLink ? (
          <p className="hint">
            The bot registration has no <code>platform_username</code>, so no deep link
            can be built. Set the bot&apos;s username in its registration.
          </p>
        ) : (
          <p className="hint">Issue a handover to render the QR.</p>
        )}
      </StepCard>

      <StepCard
        index={3}
        title="Grant trading authority"
        subtitle="The custody step. Signed here, in the web session — never in Telegram."
        status={stepStatus(['claimed', 'granting'], ['active', 'revoked'])}
      >
        {status?.state === 'claimed' || phase === 'granting' || phase === 'active' ? (
          <>
            <dl className="kv">
              <div>
                <dt>Claimed by</dt>
                <dd>{status?.claimed_handle ? `@${status.claimed_handle}` : '—'}</dd>
              </div>
              <div>
                <dt>Agent address</dt>
                <dd>
                  <code>{status?.agent_address ?? '—'}</code>
                </dd>
              </div>
            </dl>
            <p className="hint">
              This address did not exist when the QR was rendered. It is provisioned
              during the claim — which is exactly why a stolen QR grants nothing.
            </p>
            {grantTxHash ? (
              <p className="hint">
                Grant tx: <code>{grantTxHash}</code>
              </p>
            ) : (
              <button
                className="btn btn--primary"
                onClick={grantVenueAuthority}
                disabled={busy || phase === 'active'}
              >
                {busy ? 'confirm in wallet…' : 'allowTradingForAccount'}
              </button>
            )}
          </>
        ) : (
          <p className="hint">Available once a Telegram user claims the link.</p>
        )}
      </StepCard>

      <StepCard
        index={4}
        title="Activate"
        subtitle="Assert the grant landed. aomi takes your word for it."
        status={stepStatus([], ['active'])}
      >
        {phase === 'active' ? (
          <>
            <div className="banner banner--ok">
              Agent is live. It can trade this account within your mandate, and cannot
              withdraw.
            </div>
            <button className="btn btn--danger" onClick={revoke} disabled={busy}>
              Revoke
            </button>
          </>
        ) : grantTxHash ? (
          <button className="btn btn--primary" onClick={activate} disabled={busy}>
            {busy ? 'activating…' : 'Confirm grant & activate'}
          </button>
        ) : (
          <p className="hint">
            Send the grant first. Activating before it confirms does not grant the agent
            anything — it only makes this page lie.
          </p>
        )}
      </StepCard>

      {phase === 'revoked' ? (
        <div className="banner">
          Revoked. aomi-side signing stopped immediately — but call{' '}
          <code>revokeTradingForAccount</code> too, so the fence does not depend on us
          being reachable.
          <button className="btn" onClick={reset}>
            Start over
          </button>
        </div>
      ) : null}
    </div>
  );
}
