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

/** MegaETH mainnet. */
export const megaeth = defineChain({
  id: 4326,
  name: 'MegaETH',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: {
      http: [process.env.NEXT_PUBLIC_MEGAETH_RPC_URL ?? 'https://carrot.megaeth.com/rpc'],
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
 * aomi as `external_account`. Keeping those identical is what lets the agent's
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
] as const;
