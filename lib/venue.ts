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
 * The venue's dev chain — Puffer UniFi testnet, chain 2092151908.
 *
 * **The partner runs three deployments and two of them are live with the same
 * ABI**, so pointing at the wrong one fails silently rather than loudly:
 *
 * | Their URL         | Chain                     | Registry      |
 * | ----------------- | ------------------------- | ------------- |
 * | `dev.wcm.inc`     | 2092151908 (Puffer UniFi) | `0xf6b54e03…` |
 * | `staging.wcm.inc` | 4326 (MegaETH)            | `0x5e3Ae52E…` |
 * | `world.inc`       | production                | not yet known |
 *
 * This app targets **dev**. Confirmed with the partner 2026-08-25 and measured
 * against the live RPC: `getUserAddress(18)` there returns the test account,
 * which the MegaETH deployment knows nothing about.
 */
export const venueChain = defineChain({
  id: 2_092_151_908,
  name: 'Puffer UniFi Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: {
      http: [
        process.env.NEXT_PUBLIC_VENUE_RPC_URL ?? 'https://testnet-unifi-rpc.puffer.fi/',
      ],
    },
  },
});

/** The Concord exchange on dev. Override per environment. */
export const exchangeAddress = (process.env.NEXT_PUBLIC_VENUE_EXCHANGE_ADDRESS ??
  '0xf6b54e033bb45a583aa642924bcef78b804588ae') as `0x${string}`;

/**
 * The origin the backend pins SIWE messages to.
 *
 * Sent as both `domain` and `uri` in the signed message and compared
 * byte-exactly server-side, so this must be the origin the page is actually
 * served from — no trailing slash, matching `window.location.origin`.
 */
export const venueOrigin =
  process.env.NEXT_PUBLIC_VENUE_ORIGIN ?? 'https://dev.wcm.inc';

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
