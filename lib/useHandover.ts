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
import { createWalletClient, custom, type Address } from 'viem';

import {
  QUOTE_SYMBOL,
  VENUE_MARKETS,
  concordUserAbi,
  exchangeAddress,
  marketKey,
  megaeth,
} from '@/lib/venue';
import type { HandoverStatus, IssuedHandover } from '@/lib/types';

/** Poll cadence while waiting for a scan. Fast enough to feel live, slow enough to be polite. */
export const POLL_MS = 2000;

export type Phase =
  | 'setup'
  | 'awaiting-scan'
  | 'claimed'
  | 'granting'
  | 'active'
  | 'revoked';

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
        chain_id: megaeth.id,
        world: {
          account_id: Number(accountId.trim()) || null,
          owner_wallet: ownerWallet || null,
          exchange: exchangeAddress,
        },
      },
      mandate,
      ttl_seconds: 300,
    }),
    [accountId, brief, alerts, ownerWallet, mandate],
  );

  const startPolling = useCallback(
    (handoverId: number) => {
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
    },
    [botRegistrationId, stopPolling],
  );

  const issue = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/handover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(issueBody),
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
  }, [issueBody, startPolling]);

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
  }, [accountId, status?.agent_address]);

  const activate = useCallback(async () => {
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
  }, [botRegistrationId, grantTxHash, issued]);

  const revoke = useCallback(async () => {
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
  }, [botRegistrationId, issued]);

  const reset = useCallback(() => {
    stopPolling();
    setIssued(null);
    setStatus(null);
    setGrantTxHash(null);
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
