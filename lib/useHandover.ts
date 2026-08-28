'use client';

/**
 * The handover state machine, with no opinion about how it looks.
 *
 * The ordering below is not a UI preference — it is the security model:
 *
 *   issue -> QR -> claim (in Telegram) -> grant on-chain -> activate
 *
 * The grant lands *after* the claim, against an agent address that did not
 * exist when the QR was rendered. That is what makes a leaked QR worthless.
 *
 * Activation is also the moment the agent key gains the ability to sign at
 * all: a claimed-but-not-activated agent holds a key that cannot sign
 * anything. So the last step is not bookkeeping — it is the switch, and it is
 * deliberately downstream of the owner's on-chain grant.
 *
 * Do not reorder these steps. Both views drive this one hook precisely so
 * there is no second copy of the order to get wrong.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPublicClient, createWalletClient, custom, http, type Address } from 'viem';

import {
  QUOTE_SYMBOL,
  VENUE_MARKETS,
  concordUserAbi,
  exchangeAddress,
  marketKey,
  venueChain,
} from '@/lib/venue';
import type { HandoverStatus, IssuedHandover } from '@/lib/types';
import {
  AomiApiError,
  activateHandover,
  connectWallet,
  getHandoverStatus,
  issueHandover,
} from '@/lib/aomi';

/** Poll cadence while waiting for a scan. Fast enough to feel live, slow enough to be polite. */
export const POLL_MS = 2000;

export type Phase =
  | 'setup'
  | 'awaiting-scan'
  | 'claimed'
  | 'granting'
  | 'active'
  /** Revocation is on chain but not yet mined. */
  | 'revoking'
  | 'revoked'
  /**
   * The session died before the page collected the claim result — it expired,
   * or the one delivery was lost to a dropped connection.
   *
   * A distinct phase because there is deliberately no way back: no re-auth, no
   * renewal. The only move is a fresh issue and a fresh QR, and the copy has to
   * say so plainly rather than leaving the user waiting on a QR that can no
   * longer report anything.
   */
  | 'session-lost';

// Re-exported so the views import venue facts from one place.
export { VENUE_MARKETS, QUOTE_SYMBOL, marketKey } from '@/lib/venue';

/**
 * The venue accounts this user holds, as a real product would list them.
 *
 * `id` is the venue's `uint64` — it becomes `platform_account_ref` on the wire and
 * `accountId` in the on-chain grant. `label` is the only part a user should
 * ever read. Picking from a list rather than typing the id also means the id
 * is always a valid `uint64`, so the grant's `BigInt()` cannot throw after the
 * user has already scanned.
 */
export const VENUE_ACCOUNTS = [
  { id: '8814729', label: 'Main trading account', balance: '$182,400' },
  { id: '8814733', label: 'Margin account', balance: '$46,120' },
] as const;

/**
 * What the user wants the agent *for* — the standing objective.
 *
 * This is not a one-shot task. The handover creates a bot that lives in the
 * user's Telegram indefinitely, so the thing collected at setup has to read
 * like a job description, not like the page they happened to be on. A user who
 * set this up in March should still recognise it in June.
 */
export const BRIEF_PRESETS = [
  {
    id: 'watch',
    label: 'Watch my positions',
    text: 'Keep an eye on my open positions and tell me when something needs my attention.',
  },
  {
    id: 'trade',
    label: 'Trade on my say-so',
    text: 'Let me open and close perp positions by chat. Confirm the size with me before you place anything.',
  },
  {
    id: 'defend',
    label: 'Keep me out of trouble',
    text: 'Protect my account. Warn me early if I am drifting toward liquidation, and tell me what it would take to fix it.',
  },
] as const;

/**
 * What the agent may interrupt the user about, unprompted.
 *
 * This is the half that actually makes it a 24/7 bot rather than a chat window
 * that happens to stay open. It is also a consent question in its own right —
 * a bot that can message you at 3am is a different product from one that
 * cannot — so it is chosen here, not assumed.
 *
 * Every trigger below is derived from live contract state the app already
 * reads, so none of them require the venue to publish anything new.
 */
export const ALERT_TRIGGERS = [
  {
    id: 'liquidation_risk',
    label: 'I’m drifting toward liquidation',
    source: 'riskAdjustedPortfolioValue + liquidation flag',
    defaultOn: true,
  },
  {
    id: 'funding_cost',
    label: 'Funding turns against a position',
    source: 'perp position funding accrual',
    defaultOn: true,
  },
  {
    id: 'position_move',
    label: 'A position moves sharply',
    source: 'getMarkPrice vs entry price',
    defaultOn: false,
  },
  {
    id: 'daily_digest',
    label: 'A once-a-day summary',
    source: 'account read on a schedule',
    defaultOn: false,
  },
] as const;

export type Handover = ReturnType<typeof useHandover>;

export function useHandover(botRegistrationId: string) {
  // Seeded from the account list so the Product picker and the Integration
  // view's raw field never start out disagreeing — they are one value.
  const [accountId, setAccountId] = useState<string>(VENUE_ACCOUNTS[0].id);
  const [brief, setBrief] = useState<string>(BRIEF_PRESETS[0].text);
  const [alerts, setAlerts] = useState<string[]>(
    ALERT_TRIGGERS.filter((a) => a.defaultOn).map((a) => a.id),
  );

  const toggleAlert = useCallback((id: string) => {
    setAlerts((current) =>
      current.includes(id) ? current.filter((a) => a !== id) : [...current, id],
    );
  }, []);
  const [maxNotional, setMaxNotional] = useState('25000');
  const [market, setMarket] = useState<string>(marketKey(VENUE_MARKETS[0]));
  const [maxLeverage, setMaxLeverage] = useState('3');
  const [minPortfolioValue, setMinPortfolioValue] = useState('5000');

  /**
   * The account owner's wallet, read silently at mount.
   *
   * `eth_accounts` (unlike `eth_requestAccounts`) never prompts — it returns
   * what is already connected, or nothing. That matters because this value has
   * to be in the issue payload, and popping a wallet dialog before the user has
   * even seen the QR would be the wrong moment to ask.
   *
   * It must be the *owner's* address, not the agent's: the app's account
   * resolution rejects a wallet that is not the account owner, and the agent is
   * only a delegated trader.
   */
  const [ownerWallet, setOwnerWallet] = useState<string | null>(null);

  useEffect(() => {
    const ethereum = (globalThis as { ethereum?: { request?: (a: unknown) => Promise<unknown> } })
      .ethereum;
    if (!ethereum?.request) return;
    let cancelled = false;
    ethereum
      .request({ method: 'eth_accounts' })
      .then((accounts) => {
        const first = Array.isArray(accounts) ? (accounts[0] as string | undefined) : undefined;
        if (!cancelled && first) setOwnerWallet(first);
      })
      .catch(() => {
        // No wallet, or the provider refused to answer without a prompt.
        // Not fatal — surfaced in the UI as "connect to include the owner".
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Product view only: the entry point and the limits form are two screens.
   * It lives here rather than in the view so toggling Product/Integration
   * does not silently rewind the user to the entry card.
   */
  const [setupStarted, setSetupStarted] = useState(false);

  const [phase, setPhase] = useState<Phase>('setup');
  const [issued, setIssued] = useState<IssuedHandover | null>(null);
  const [status, setStatus] = useState<HandoverStatus | null>(null);
  const [grantTxHash, setGrantTxHash] = useState<string | null>(null);
  const [revokeTxHash, setRevokeTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /**
   * The status session. A ref rather than state because it is a credential:
   * state ends up in DevTools, in error payloads, and in anything that
   * serializes this hook's return value. Nothing renders it, so nothing needs
   * a re-render when it changes.
   */
  const sessionRef = useRef<string | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const selectedMarket = useMemo(
    () => VENUE_MARKETS.find((m) => marketKey(m) === market) ?? VENUE_MARKETS[0],
    [market],
  );

  /**
   * Opaque to aomi — the backend stores it verbatim and hands it to the agent's
   * turn. The venue app's tools are what enforce it at trade time; writing a
   * number here does not, by itself, cap anything.
   *
   * Every limit below is expressed in a primitive World actually has, so the
   * app can evaluate it against a live contract read rather than a made-up
   * quantity:
   *
   *   markets                        -> (product, base, quote), the triple
   *                                     `get_world_market` already takes
   *   max_position_notional          -> quantity x `getMarkPrice`, quoted in
   *                                     USDm (the 0%-risk-price numeraire)
   *   max_leverage                   -> notional over
   *                                     `riskAdjustedPortfolioValue`
   *   min_risk_adjusted_portfolio_value
   *                                  -> `riskAdjustedPortfolioValue(uint64)`
   *                                     directly, an int64 the contract returns
   *   halt_if_eligible_for_liquidation
   *                                  -> the account's own liquidation flag
   *
   * `can_withdraw` is stated for the reader's benefit and is not a toggle:
   * `allowTradingForAccount` delegates "trading rights (but not
   * deposit/withdraw)", so withdrawal is structurally ungrantable.
   */
  const mandate = useMemo(
    () => ({
      version: 1,
      markets: [
        {
          product: selectedMarket.product,
          base: selectedMarket.base,
          quote: selectedMarket.quote,
        },
      ],
      max_position_notional: {
        amount: maxNotional.trim(),
        quote: QUOTE_SYMBOL,
      },
      max_leverage: maxLeverage.trim(),
      min_risk_adjusted_portfolio_value: {
        amount: minPortfolioValue.trim(),
        quote: QUOTE_SYMBOL,
      },
      halt_if_eligible_for_liquidation: true,
      can_withdraw: false,
    }),
    [selectedMarket, maxNotional, maxLeverage, minPortfolioValue],
  );

  /**
   * The exact issue payload, shared by `issue()` and the Integration view's
   * preview. One source so the documented body cannot drift from the sent one
   * — a request preview that lies is worse than no preview.
   */
  const issueBody = useMemo(
    () => ({
      // The backend pins this identifier to the venue configuration, but it
      // is still required on the wire so both channels share one request
      // shape. Keeping it in this object also makes the Integration preview
      // exactly match the request that `issue()` sends.
      bot_registration_id: botRegistrationId,
      platform_account_ref: accountId.trim(),

      /**
       * What the agent is *for*, and what it may raise on its own.
       *
       * Deliberately top-level rather than a `context` key. `context` is
       * documented as display-only and never interpreted — and it really is:
       * the backend reads `summary`/`intent` once to compose the Telegram
       * greeting, then drops the whole object. Nothing in `context` reaches a
       * turn. A field that shapes how the agent behaves for the next three
       * months cannot live somewhere with that contract.
       *
       * `brief` therefore sits beside `mandate`, and needs the same delivery
       * `mandate` already has (carried on `HandoverBinding`, flattened into the
       * turn's attributes). Until the backend carries it, this field is
       * declared-but-not-delivered — see the Integration view, which says so.
       *
       * The pairing is the point:
       *   mandate — what it may risk, enforced by the app
       *   brief   — what it is for, guidance the model reads
       */
      brief: {
        objective: brief.trim(),
        alerts,
      },

      // Display-only, exactly as documented. `summary` is the one key with a
      // convention attached: it becomes the first line of the Telegram
      // greeting. Derived from the brief so the welcome message and the
      // standing objective can never disagree.
      context: {
        summary: brief.trim(),
        venue: 'world-markets',
        chain_id: venueChain.id,
        world: {
          account_id: Number(accountId.trim()) || null,
          owner_wallet: ownerWallet || null,
          exchange: exchangeAddress,
        },
      },
      mandate,
      ttl_seconds: 300,
    }),
    [botRegistrationId, accountId, brief, alerts, ownerWallet, mandate],
  );

  /**
   * Poll with the status session until the claim result arrives.
   *
   * The read that returns `agent_address` is the same read that spends the
   * session, so this stops on the first non-pending answer — asking again would
   * get a refusal, and that refusal is not an error worth showing.
   *
   * A `401` is the one response that ends the flow rather than pausing it: the
   * session is gone, and nothing renews it. Other failures are treated as
   * transient, because a dropped request is not a failed handover.
   */
  const startPolling = useCallback(
    (handoverId: number, session: string) => {
      stopPolling();
      pollRef.current = setInterval(async () => {
        try {
          const next = await getHandoverStatus(botRegistrationId, handoverId, session);
          setStatus(next);
          if (next.restart_required) {
            // The handover is over and produced nothing — the QR ran out, or it
            // was revoked. The session is still fine, which is exactly why the
            // backend says so in the body rather than by refusing: a 401 here
            // would read as "your credential broke" and send the user looking
            // in the wrong place.
            stopPolling();
            setPhase('session-lost');
            setError(
              next.state === 'revoked'
                ? 'This handover was revoked. Generate a new QR code to start again.'
                : 'The QR code expired before it was scanned. Generate a new one.',
            );
            return;
          }
          if (next.state !== 'pending') {
            // Claimed: this response carried the agent address and consumed the
            // session with it. Nothing left to poll for.
            stopPolling();
            setPhase('claimed');
          }
        } catch (caught) {
          if (caught instanceof AomiApiError && caught.status === 401) {
            // Now unambiguous: the backend reports a dead handover in the body,
            // so a refusal here means the *session* is gone — it timed out, or
            // it was already spent collecting the result.
            stopPolling();
            setPhase('session-lost');
            setError(
              'This connection expired. Generate a new QR code and scan it again.',
            );
          }
          // Anything else: keep polling.
        }
      }, POLL_MS);
    },
    [botRegistrationId, stopPolling],
  );

  /**
   * Signature one of two.
   *
   * Prompts for a wallet if none is connected — this is the first point where
   * one is genuinely required, and asking earlier (before the user has seen
   * what they are setting up) would be the wrong moment.
   *
   * The session lives in a ref, not in state: it is a credential, and putting
   * it in state invites it into React DevTools, error boundaries and any future
   * `JSON.stringify` of the hook's return value.
   */
  const issue = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const owner = ownerWallet ?? (await connectWallet());
      setOwnerWallet(owner);

      const payload = await issueHandover(owner, issueBody);
      if (!payload.session) {
        throw new Error('aomi issued no session — cannot follow this handover.');
      }
      sessionRef.current = payload.session;
      setIssued(payload);
      setStatus(null);
      setPhase('awaiting-scan');
      startPolling(payload.handover_id, payload.session);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'issue failed');
    } finally {
      setBusy(false);
    }
  }, [issueBody, ownerWallet, startPolling]);

  /**
   * The custody step. Signed by the account owner in this browser session,
   * never by the agent and never in Telegram.
   */
  const grantVenueAuthority = useCallback(async () => {
    if (!status?.agent_address) return;
    setBusy(true);
    setError(null);
    setPhase('granting');
    try {
      const ethereum = (globalThis as { ethereum?: unknown }).ethereum;
      if (!ethereum) throw new Error('no injected wallet found');

      const wallet = createWalletClient({
        chain: venueChain,
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
  }, [accountId, status?.agent_address]);

  /**
   * Signature two of two — the moment the agent key gains the ability to sign.
   *
   * aomi does not take the grant transaction on trust. It reads the account's
   * live trader set and refuses if the agent is not in it, so a 409 here
   * usually means the grant has not confirmed yet rather than that anything is
   * wrong. Say so, and let the user try again.
   */
  const activate = useCallback(async () => {
    if (!issued || !grantTxHash || !ownerWallet) return;
    setBusy(true);
    setError(null);
    try {
      const payload = await activateHandover(
        ownerWallet,
        botRegistrationId,
        issued.handover_id,
      );
      setStatus(payload);
      setPhase('active');
    } catch (caught) {
      const message =
        caught instanceof AomiApiError && caught.status === 409
          ? 'The venue has not registered your authorization yet. Wait for the transaction to confirm, then try again.'
          : caught instanceof Error
            ? caught.message
            : 'activate failed';
      setError(message);
    } finally {
      setBusy(false);
    }
  }, [botRegistrationId, grantTxHash, issued, ownerWallet]);

  /**
   * Stop the agent, on chain.
   *
   * There is no browser revoke against aomi: that route stays on the platform
   * bearer, which this app does not hold. What the owner *can* do unilaterally
   * is take the authority back at the venue, which is the stronger of the two
   * fences anyway — aomi's key cannot trade for an account that no longer lists
   * it as a trader, whatever aomi's own record says.
   */
  const revoke = useCallback(async () => {
    if (!status?.agent_address) return;
    setBusy(true);
    setError(null);
    try {
      const ethereum = (globalThis as { ethereum?: unknown }).ethereum;
      if (!ethereum) throw new Error('no injected wallet found');
      const wallet = createWalletClient({
        chain: venueChain,
        transport: custom(ethereum as Parameters<typeof custom>[0]),
      });
      const [account] = await wallet.requestAddresses();
      const hash = await wallet.writeContract({
        account,
        address: exchangeAddress,
        abi: concordUserAbi,
        functionName: 'revokeTradingForAccount',
        args: [BigInt(accountId), status.agent_address as Address],
      });
      setRevokeTxHash(hash);

      // `writeContract` returns as soon as the transaction is *broadcast*. The
      // agent keeps its authority until this is mined, so telling the user
      // "access revoked" here would be a lie in the one place a lie is most
      // expensive — someone deciding whether they still need to act.
      setPhase('revoking');
      const receipt = await createPublicClient({
        chain: venueChain,
        transport: http(),
      }).waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        throw new Error('The revocation transaction reverted. The agent still has access.');
      }
      setPhase('revoked');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'revoke failed');
      // Back to active: whatever went wrong, the agent still holds its
      // authority, and the UI must keep offering the way to take it back.
      setPhase('active');
    } finally {
      setBusy(false);
    }
  }, [accountId, status?.agent_address]);

  const reset = useCallback(() => {
    stopPolling();
    sessionRef.current = null;
    setIssued(null);
    setStatus(null);
    setGrantTxHash(null);
    setRevokeTxHash(null);
    setError(null);
    setPhase('setup');
    setSetupStarted(false);
  }, [stopPolling]);

  const markExpired = useCallback(
    () => setStatus((s) => (s ? { ...s, state: 'expired' } : s)),
    [],
  );

  const deepLink =
    issued?.bot_username
      ? `https://t.me/${issued.bot_username}?start=${issued.token}`
      : null;
  const chatLink = issued?.bot_username ? `https://t.me/${issued.bot_username}` : null;

  return {
    // inputs
    accountId,
    setAccountId,
    brief,
    setBrief,
    alerts,
    toggleAlert,
    maxNotional,
    setMaxNotional,
    market,
    setMarket,
    selectedMarket,
    maxLeverage,
    setMaxLeverage,
    minPortfolioValue,
    setMinPortfolioValue,
    ownerWallet,
    mandate,
    issueBody,
    setupStarted,
    setSetupStarted,
    // machine
    phase,
    issued,
    status,
    grantTxHash,
    revokeTxHash,
    error,
    busy,
    expired: status?.state === 'expired',
    deepLink,
    chatLink,
    // actions
    issue,
    grantVenueAuthority,
    activate,
    revoke,
    reset,
    markExpired,
  };
}
