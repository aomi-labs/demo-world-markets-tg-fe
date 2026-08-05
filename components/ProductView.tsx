'use client';

/**
 * What a World Markets user sees.
 *
 * Same state machine as the integration view — every action here comes from
 * `useHandover`. The only difference is vocabulary: no `mandate`, no
 * `allowTradingForAccount`, no `platform_account_ref`. A user approving custody
 * should be reading a sentence about what the agent may do, not a function
 * signature.
 *
 * Two copy rules this screen is built around:
 *
 *   1. Ask for limits BEFORE the QR. The user should feel in control before
 *      anything technical happens.
 *   2. Say what it CANNOT do, next to what it can. "Can't withdraw" is the
 *      sentence that closes the sale.
 */

import { PayloadDisclosure } from './PayloadPreview';
import { QrPanel } from './QrPanel';
import {
  ALERT_TRIGGERS,
  BRIEF_PRESETS,
  VENUE_ACCOUNTS,
  VENUE_MARKETS,
  marketKey,
  type Handover,
} from '@/lib/useHandover';

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

function short(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** The human name for whichever venue account is selected. */
function accountLabel(id: string) {
  return VENUE_ACCOUNTS.find((account) => account.id === id)?.label ?? `Account #${id}`;
}

export function ProductView({ h }: { h: Handover }) {
  return (
    <div className="flow">
      {h.error ? (
        <div className="banner banner--error" role="alert">
          {h.error}
        </div>
      ) : null}

      {/* Entry point — lives on the trading page, near the account panel. */}
      {h.phase === 'setup' && !h.setupStarted ? (
        <section className="card">
          <h2 className="card__title">Your World Markets agent</h2>
          <p className="card__lede">
            A trading assistant that lives in your Telegram. It watches your
            account around the clock, trades only what you allow, and can never
            withdraw.
          </p>
          <button className="btn btn--primary" onClick={() => h.setSetupStarted(true)}>
            Set up agent
          </button>
        </section>
      ) : null}

      {/* Setup — purpose first, then the leash. Both before the QR. */}
      {h.phase === 'setup' && h.setupStarted ? (
        <section className="card">
          <h2 className="card__title">Set up your agent</h2>
          <p className="card__lede">
            Two things: what you want it doing, and how far it may go. Both stay
            in force until you change them.
          </p>

          <h3 className="grp">What should it do for you?</h3>

          <div className="fields">
            <label className="field">
              <span>Its standing job</span>
              <div className="chips">
                {BRIEF_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className={`chip ${h.brief === preset.text ? 'is-on' : ''}`}
                    onClick={() => h.setBrief(preset.text)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <textarea
                className="ta"
                rows={3}
                value={h.brief}
                onChange={(event) => h.setBrief(event.target.value)}
              />
              <small>
                Write it however you like — this is the job, not a one-off order.
                It holds until you change it.
              </small>
            </label>

            <fieldset className="field fieldset">
              <span>When may it message you first?</span>
              <div className="checks">
                {ALERT_TRIGGERS.map((trigger) => (
                  <label key={trigger.id} className="check">
                    <input
                      type="checkbox"
                      checked={h.alerts.includes(trigger.id)}
                      onChange={() => h.toggleAlert(trigger.id)}
                    />
                    <span>{trigger.label}</span>
                  </label>
                ))}
              </div>
              <small>
                Everything else, it waits for you to ask. Untick them all and it
                only ever answers.
              </small>
            </fieldset>
          </div>

          <h3 className="grp">How far may it go?</h3>
          <p className="card__lede card__lede--tight">
            It can never go past these, whatever you or it says later.
          </p>

          <div className="fields">
            <label className="field">
              <span>Which of your World Markets accounts can it trade?</span>
              <select
                className="select"
                value={h.accountId}
                onChange={(event) => h.setAccountId(event.target.value)}
              >
                {VENUE_ACCOUNTS.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.label} · {account.balance}
                  </option>
                ))}
              </select>
              <small>
                Your other accounts stay completely out of reach — the approval
                names this one only.
              </small>
            </label>

            <label className="field">
              <span>Biggest position it can open</span>
              <div className="adorn">
                <span className="adorn__pre">$</span>
                <input
                  value={h.maxNotional}
                  onChange={(event) => h.setMaxNotional(event.target.value)}
                  inputMode="numeric"
                />
              </div>
              <small>Across all open positions, not per trade.</small>
            </label>

            <label className="field">
              <span>Markets it can trade</span>
              <select
                className="select"
                value={h.market}
                onChange={(event) => h.setMarket(event.target.value)}
              >
                {VENUE_MARKETS.map((m) => (
                  <option key={marketKey(m)} value={marketKey(m)}>
                    {m.label}
                  </option>
                ))}
              </select>
              <small>It cannot touch anything you don&apos;t list here.</small>
            </label>

            <label className="field">
              <span>Most leverage it may use</span>
              <div className="adorn">
                <input
                  value={h.maxLeverage}
                  onChange={(event) => h.setMaxLeverage(event.target.value)}
                  inputMode="numeric"
                />
                <span className="adorn__post">x</span>
              </div>
              <small>Position size against your risk-adjusted portfolio value.</small>
            </label>

            <label className="field">
              <span>Stop trading if your account falls below</span>
              <div className="adorn">
                <span className="adorn__pre">$</span>
                <input
                  value={h.minPortfolioValue}
                  onChange={(event) => h.setMinPortfolioValue(event.target.value)}
                  inputMode="numeric"
                />
              </div>
              <small>
                Measured by World&apos;s own risk-adjusted portfolio value. The agent
                also stops on its own if your account becomes liquidatable.
              </small>
            </label>
          </div>

          <p className="hint">
            The agent can never withdraw, transfer, or move funds off World
            Markets — that isn&apos;t a setting, it&apos;s simply not something it
            can be granted.
          </p>

          <PayloadDisclosure body={h.issueBody} />

          <div className="row">
            <button className="btn btn--primary" onClick={h.issue} disabled={h.busy}>
              {h.busy ? 'preparing…' : 'Continue'}
            </button>
            <button className="btn" onClick={() => h.setSetupStarted(false)} disabled={h.busy}>
              Back
            </button>
          </div>
        </section>
      ) : null}

      {/* Step 2 — the QR. */}
      {h.phase === 'awaiting-scan' ? (
        <section className="card">
          <h2 className="card__title">Scan to link Telegram</h2>
          {h.deepLink && !h.expired ? (
            <>
              <QrPanel
                deepLink={h.deepLink}
                expiresAt={h.issued!.expires_at}
                onExpired={h.markExpired}
              />
              <p className="hint">
                Nothing is authorized yet. This code only opens the chat — the
                approval comes back here.
              </p>
            </>
          ) : h.expired ? (
            <div className="banner">
              This code expired. Nothing was authorized.
              <button className="btn" onClick={h.reset}>
                Get a new code
              </button>
            </div>
          ) : (
            <p className="hint">
              This bot has no username set, so no link can be built.
            </p>
          )}
        </section>
      ) : null}

      {/* Step 3 — the authorization. The screen that matters most. */}
      {h.phase === 'claimed' || h.phase === 'granting' ? (
        <section className="card">
          <h2 className="card__title">
            ✅ Linked to{' '}
            {h.status?.claimed_handle ? `@${h.status.claimed_handle}` : 'your Telegram'}
          </h2>
          <p className="card__lede">
            Your agent&apos;s address:{' '}
            <code>{h.status?.agent_address ? short(h.status.agent_address) : '—'}</code>
          </p>

          <dl className="approve">
            <div>
              <dt>What you&apos;re approving</dt>
              <dd>
                this address may place orders on your{' '}
                <strong>{accountLabel(h.accountId)}</strong>, up to{' '}
                {usd.format(Number(h.maxNotional) || 0)} in {h.selectedMarket.label}.
              </dd>
            </div>
            <div>
              <dt>What it can&apos;t do</dt>
              <dd>
                withdraw, transfer, or touch any of your other accounts.
              </dd>
            </div>
          </dl>
          <p className="hint">
            You can revoke any time — one transaction, no permission needed from
            anyone.
          </p>

          {h.grantTxHash ? (
            <div className="row">
              <button className="btn btn--primary" onClick={h.activate} disabled={h.busy}>
                {h.busy ? 'turning on…' : 'Turn on the agent'}
              </button>
              <span className="hint">Approved on-chain. One more tap to go live.</span>
            </div>
          ) : (
            <button
              className="btn btn--primary"
              onClick={h.grantVenueAuthority}
              disabled={h.busy}
            >
              {h.busy ? 'confirm in your wallet…' : 'Authorize agent'}
            </button>
          )}
        </section>
      ) : null}

      {/* Step 4 — live. */}
      {h.phase === 'active' ? (
        <section className="card card--ok">
          <h2 className="card__title">
            <span className="dot" aria-hidden /> Agent active
          </h2>
          <p className="card__lede">
            Living in {h.status?.claimed_handle ? `@${h.status.claimed_handle}` : 'your Telegram'},
            working your {accountLabel(h.accountId)}, up to{' '}
            {usd.format(Number(h.maxNotional) || 0)} in {h.selectedMarket.label}.
          </p>
          <dl className="approve">
            <div>
              <dt>Its job</dt>
              <dd>{h.brief}</dd>
            </div>
            <div>
              <dt>Speaks first when</dt>
              <dd>
                {h.alerts.length === 0
                  ? 'never — it only answers when you ask'
                  : ALERT_TRIGGERS.filter((t) => h.alerts.includes(t.id))
                      .map((t) => t.label.toLowerCase())
                      .join('; ')}
              </dd>
            </div>
          </dl>

          <div className="row">
            {h.chatLink ? (
              <a
                className="btn btn--primary"
                href={h.chatLink}
                target="_blank"
                rel="noreferrer"
              >
                Open chat
              </a>
            ) : null}
            {/*
              Deliberately inert. There is no mandate-update endpoint: the
              mandate is fixed at issue time, so "change limits" in production
              means revoke and re-issue. Shipping a button that silently did
              nothing to the live agent would be worse than showing the gap.
            */}
            <button className="btn" disabled title="Not available in this demo">
              Change limits
            </button>
            <button className="btn btn--danger" onClick={h.revoke} disabled={h.busy}>
              Revoke access
            </button>
          </div>
          <p className="hint">
            Changing limits means revoking and setting the agent up again — the
            mandate is fixed when the link is issued.
          </p>
        </section>
      ) : null}

      {h.phase === 'revoked' ? (
        <section className="card">
          <h2 className="card__title">Agent access revoked</h2>
          <p className="card__lede">
            It stopped trading immediately. Send{' '}
            <code>revokeTradingForAccount</code> on-chain too, so the fence
            doesn&apos;t depend on us being reachable.
          </p>
          <button className="btn" onClick={h.reset}>
            Set up a new agent
          </button>
        </section>
      ) : null}
    </div>
  );
}
