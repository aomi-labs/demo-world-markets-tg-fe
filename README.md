# World Markets → Telegram agent

Reference frontend for the aomi **partner handover**: scan a QR on a partner's
web app, and the user is talking to an agent that can trade their venue account
from Telegram.

This is a working integration, not a mockup. Point it at an aomi backend with a
registered Telegram bot and it runs the real flow. Read
[`components/HandoverFlow.tsx`](components/HandoverFlow.tsx) top to bottom and
you have the whole contract.

```bash
cp .env.example .env.local   # fill in AOMI_PLATFORM_TOKEN + AOMI_BOT_REGISTRATION_ID
npm install
npm run dev                  # http://localhost:3210
```

---

## The one idea

**The web is the custody surface. Telegram is the autonomy surface.**
Telegram never asks for a signature.

Everything else follows from that. The user grants trading authority in your web
app, where they already have a wallet and a session. The agent then operates
independently in Telegram, with no wallet ceremony, no Mini App, and no seed
phrase anywhere near a chat window.

## Why the QR is safe to leak

The token in the QR carries **zero authority**. Scanning it does one thing:
attach a Telegram identity to a handover. The agent address does not exist
until that claim happens, and the on-chain grant is signed afterwards, by the
account owner, in your web session.

So a screenshotted QR, a shoulder-surfed QR, a QR posted in a group chat — all
of them buy an attacker an **empty account with no trading authority**. That is
not defence in depth; it is the reason the ordering is what it is.

```
issue ──► QR ──► claim (Telegram) ──► grant on-chain ──► activate
                      │                     │
                      │                     └─ owner signs, in YOUR web session
                      └─ agent address is provisioned HERE, not before
```

**Do not reorder these steps.** Granting authority to an address before the
claim would hand out a live agent to whoever scans first.

---

## The four calls

All four are authorized by your **platform activation bearer**. It is a secret:
it can issue and revoke handovers for every bot your platform owns. This app
never lets it reach the browser — the React code calls this app's own route
handlers, and [`lib/aomi.ts`](lib/aomi.ts) (server-only) holds the bearer.
Copy that pattern.

### 1. Issue

```http
POST /api/platforms/:platform/telegram/handover
Authorization: Bearer <platform activation token>

{
  "bot_registration_id": "…",
  "external_account": "1",
  "context":  { "summary": "Short ETH perp, 2x, from the ETH-PERP page" },
  "mandate":  { "max_notional_usd": 25000, "can_withdraw": false },
  "ttl_seconds": 120
}
```

```json
{ "handover_id": 42, "token": "…", "state": "pending",
  "expires_at": 1769800000, "bot_username": "world_markets_bot" }
```

`token` is returned **exactly once** — only its hash is stored. Lose it and
your only recovery is to issue again.

Build the QR as `https://t.me/<bot_username>?start=<token>`.

> **409 Conflict** means an `active` handover already holds this account's slot.
> That is not retryable: replacing a live agent is an explicit revoke, never a
> side effect of issuing again. Show "this account already has an agent" and
> offer the revoke.

### 2. Poll

```http
GET /api/platforms/:platform/telegram/handover/:bot/:id
```

```json
{ "handover_id": 42, "state": "claimed", "external_account": "1",
  "claimed_handle": "alice", "agent_address": "0x…",
  "expires_at": …, "claimed_at": …, "activated_at": null, "revoked_at": null }
```

Wait for `state: "claimed"`. That response carries the `agent_address` you need
for the grant — it is `null` before the claim, because the key is provisioned
*during* the claim.

### 3. Grant (on-chain, your web session)

```solidity
allowTradingForAccount(uint64 accountId, address tradingAddress)
```

`accountId` is the same value you sent as `external_account`; `tradingAddress`
is `agent_address`. Trade-only, owner-revocable, cannot withdraw — that bound is
the venue's, and it is what makes the mandate a second line rather than the only
one.

### 4. Activate

```http
POST /api/platforms/:platform/telegram/handover/:bot/:id/activate
```

**Call this only after the grant transaction confirms.** aomi takes your word
for it — asserting early grants the agent no capability (it flips a row you
already own), but it makes your own status display lie. This demo requires the
tx hash as a discipline; production should verify the receipt, or read the
`TraderPermission` event, before calling through.

### Revoke

```http
POST /api/platforms/:platform/telegram/handover/:bot/:id/revoke
```

Stops aomi-side signing immediately by tightening the agent key to `denied`.
Retry-safe. It does **not** touch on-chain authority — pair it with
`revokeTradingForAccount` so the owner keeps a fence that does not depend on us
being reachable.

---

## Things that will bite you

| | |
| --- | --- |
| **TTL is short** | 90s default, 600s ceiling. The QR is on screen and being scanned *now*. Build a "code expired, get a new one" path — not an error toast. |
| **404 is not "wrong id"** | A handover you do not own returns **404, not 403**, on purpose: an unauthorized caller learns nothing about whether it exists. Do not write "handover not found" copy around it. |
| **One live handover per (bot, account)** | Enforced by a database index, not by convention. |
| **`mandate` is not enforced here** | It is opaque to the handover layer. **Your venue app's tools enforce it** at trade time. Writing `max_notional_usd` does not, by itself, cap anything. |
| **`context` is opaque too** | With one convention: `summary` (else `intent`) is rendered — display only, HTML-escaped — in the agent's first Telegram message. That is what makes the greeting contextual instead of generic. Nothing in `context` is ever interpreted for a decision. |
| **Derive `external_account` from the session** | This demo takes it from a form because it has no login. In production, deriving it from the request body would let any logged-in user mint an agent link for someone else's account. |

## Layout

```
app/api/handover/…     route handlers — the bearer lives on this side
lib/aomi.ts            server-only client for the four calls
lib/venue.ts           MegaETH chain + the two Concord calls
lib/types.ts           every field the API returns, documented
components/            the flow, step by step
```

## Configuration

See [`.env.example`](.env.example). `AOMI_PLATFORM_TOKEN` is server-only — if it
ever ends up behind a `NEXT_PUBLIC_` prefix, you have handed out the ability to
mint agent links for your entire user base.
