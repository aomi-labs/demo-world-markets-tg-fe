/**
 * World Markets venue binding — the custody half of the handover.
 *
 * This is the step that makes the whole design safe: the QR carries **zero
 * authority**. A claim only attaches a Telegram user. Trading authority is
 * granted here, on-chain, by the account owner in their own web session, after
 * the claim has produced an agent address. A screenshotted or stolen QR
 * therefore buys an attacker an empty account, not a funded one.
 *
 * `allowTradingForAccount` is trade-only and owner-revocable — it cannot
 * withdraw. That bound is the venue's, not ours.
 */
import { defineChain } from 'viem';

/**
 * MegaETH mainnet — chain 4326.
 *
 * The RPC must be `mainnet.megaeth.com`. `carrot.megaeth.com` is the **testnet**
 * (chain 6343) and the exchange has no code deployed there, so a grant sent
 * against it fails with a chain mismatch or hits an empty address. Verified
 * 2026-08-03 against both endpoints.
 */
export const megaeth = defineChain({
  id: 4326,
  name: 'MegaETH',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: {
      http: [process.env.NEXT_PUBLIC_MEGAETH_RPC_URL ?? 'https://mainnet.megaeth.com/rpc'],
    },
  },
});

/** The Concord exchange. Override per environment via NEXT_PUBLIC_VENUE_EXCHANGE_ADDRESS. */
export const exchangeAddress = (process.env.NEXT_PUBLIC_VENUE_EXCHANGE_ADDRESS ??
  '0x5e3Ae52EbA0F9740364Bd5dd39738e1336086A8b') as `0x${string}`;

/**
 * Only the two calls this flow needs, from `IConcordProtocolUser`.
 *
 * `accountId` is the venue's `uint64` user id — the same value you pass to
 * aomi as `platform_account_ref`. Keeping those identical is what lets the agent's
 * reads and the grant refer to the same account.
 */
export const concordUserAbi = [
  {
    type: 'function',
    name: 'allowTradingForAccount',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'accountId', type: 'uint64' },
      { name: 'tradingAddress', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'revokeTradingForAccount',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'accountId', type: 'uint64' },
      { name: 'tradingAddress', type: 'address' },
    ],
    outputs: [],
  },
  /**
   * Every address currently permissioned to trade this account.
   *
   * This is what turns "activate" from an assertion into a fact: instead of
   * trusting a client-supplied tx hash, read the account's trader set and
   * confirm the agent address is in it. See `agentIsPermissioned`.
   */
  {
    type: 'function',
    name: 'bulkTraders_5523718714',
    stateMutability: 'view',
    inputs: [{ name: 'accountId', type: 'uint64' }],
    outputs: [{ name: 'traders', type: 'address[]' }],
  },
  /** The venue's own wallet → account mapping. Returns 0 for a non-owner. */
  {
    type: 'function',
    name: 'getUserId',
    stateMutability: 'view',
    inputs: [{ name: 'userAddress', type: 'address' }],
    outputs: [{ name: 'userId', type: 'uint64' }],
  },
] as const;

/**
 * Live assets on the exchange, read from `bulkReadTokenConfigs` 2026-08-03.
 *
 * `USDm` is the numeraire — risk price 0%, which is what makes it the quote
 * side of every book. The `wl*` entries are World Loan Vault tokens and belong
 * to the lend product, not to spot/perp pairs.
 *
 * There is no `ETH-PERP` symbol at this venue. A market is a
 * (product, base, quote) triple, which is exactly what `get_world_market`
 * takes.
 */
export const QUOTE_SYMBOL = 'USDm';

export const VENUE_MARKETS = [
  { product: 'perp', base: 'WETH', quote: QUOTE_SYMBOL, label: 'ETH perpetual' },
  { product: 'perp', base: 'BTC.b', quote: QUOTE_SYMBOL, label: 'BTC perpetual' },
  { product: 'perp', base: 'SOL', quote: QUOTE_SYMBOL, label: 'SOL perpetual' },
  { product: 'spot', base: 'WETH', quote: QUOTE_SYMBOL, label: 'ETH spot' },
  { product: 'spot', base: 'BTC.b', quote: QUOTE_SYMBOL, label: 'BTC spot' },
] as const;

export type VenueMarket = (typeof VENUE_MARKETS)[number];

/** Stable key for a market, used as the select value. */
export function marketKey(market: {
  product: string;
  base: string;
  quote: string;
}): string {
  return `${market.product}:${market.base}/${market.quote}`;
}
