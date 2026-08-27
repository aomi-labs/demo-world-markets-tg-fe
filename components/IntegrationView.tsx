'use client';

/**
 * What a World Markets engineer sees.
 *
 * Same state machine as the product view, labelled with the wire format:
 * `platform_account_ref`, `brief`, `mandate`, `allowTradingForAccount`.
 * Read it top to bottom and you have the integration — every field on screen
 * is a field you send.
 */

import { PayloadPreview } from './PayloadPreview';
import { QrPanel } from './QrPanel';
import { StepCard, type StepStatus } from './StepCard';
import {
  POLL_MS,
  VENUE_MARKETS,
  marketKey,
  type Handover,
  type Phase,
} from '@/lib/useHandover';

/** The aomi call a step makes, so each step names the thing you implement. */
function Endpoint({
  method,
  path,
  auth,
}: {
  method: string;
  path: string;
  auth: string;
}) {
  return (
    <p className="endpoint">
      <span className={`endpoint__verb endpoint__verb--${method.toLowerCase()}`}>
        {method}
      </span>
      <code className="endpoint__path">{path}</code>
      <span className="endpoint__auth">{auth}</span>
    </p>
  );
}

export function IntegrationView({ h }: { h: Handover }) {
  const stepStatus = (step: Phase[], done: Phase[]): StepStatus => {
    if (done.includes(h.phase)) return 'done';
    if (step.includes(h.phase)) return 'active';
    return 'idle';
  };

  return (
    <div className="flow">
      {h.error ? (
        <div className="banner banner--error" role="alert">
          {h.error}
        </div>
      ) : null}

      {/*
        Terminal, and not resumable: the QR ran out, the session expired, or the
        claim result was already collected. None of those have a "continue" —
        the only honest control is a restart, and leaving the flow rendered
        behind an error banner invites the reader to look for one that is not
        there.
      */}
      {h.phase === 'session-lost' ? (
        <div className="banner banner--error" role="status">
          <strong>This handover ended.</strong> Sessions are single-use and
          short-lived by design, and there is no re-auth path — issue a new
          handover to start again.{' '}
          <button className="btn" onClick={h.reset}>
            Start over
          </button>
        </div>
      ) : null}

      <StepCard
        index={1}
        title="Issue the handover"
        subtitle="The browser signs with the account owner's wallet. No server, no bearer."
        status={h.phase === 'setup' ? 'active' : 'done'}
      >
        <Endpoint
          method="POST"
          path="/api/platforms/:platform/telegram/handover/nonce"
          auth="public · ask aomi what to sign"
        />
        <Endpoint
          method="POST"
          path="/api/platforms/:platform/telegram/handover"
          auth="SIWE signature · from the browser"
        />
        <p className="hint">
          <strong>You do not need a backend for this.</strong> A platform bearer
          would authorize agent links for every user of the venue, so it could
          never reach a browser — but a wallet signature authorizes exactly one
          action on one handover, so it can. Ask <code>/nonce</code> what to
          sign, sign that string unchanged, send it with the issue call.
        </p>
        <p className="hint">
          aomi proves the account is yours before writing anything: it reads the
          venue registry in <strong>both</strong> directions and refuses if the
          wallet does not own exactly the account named.
        </p>

        <div className="fields">
          <label className="field">
            <span>
              platform_account_ref <em className="req">required</em>
            </span>
            <input
              value={h.accountId}
              onChange={(event) => h.setAccountId(event.target.value)}
              disabled={h.phase !== 'setup'}
            />
            <small>
              <strong>Your</strong> identifier for the account the agent will act
              on — any non-empty string, never parsed by aomi. It does two jobs:
              with the bot it forms the slot key (one live agent per account, so
              re-issuing supersedes an unfinished attempt and an{' '}
              <code>active</code> one returns <code>409</code>), and you carry it
              back to correlate the handover to your user. This demo also reuses
              it as <code>accountId</code> in the grant, which is why it must be
              a <code>uint64</code> <em>here</em>
              {' — '}that constraint is World Markets&apos;, not aomi&apos;s.
            </small>
          </label>

          <label className="field">
            <span>
              brief.objective <em className="opt">optional</em>
            </span>
            <textarea
              className="ta"
              rows={2}
              value={h.brief}
              onChange={(event) => h.setBrief(event.target.value)}
              disabled={h.phase !== 'setup'}
            />
            <small>
              The agent&apos;s standing job, not a one-off order. Sibling of{' '}
              <code>mandate</code>: <code>mandate</code> is what it may risk and is
              enforced; <code>brief</code> is what it is for and is guidance the
              model reads. Both persist for the life of the handover.
            </small>
          </label>

          <label className="field">
            <span>
              brief.alerts <em className="opt">optional</em>
            </span>
            <input value={h.alerts.join(', ') || '(none)'} readOnly disabled />
            <small>
              What the agent may raise unprompted. Each maps to live contract
              state the app already reads, so none of them need the venue to
              publish anything new. An empty list means it only ever answers.
            </small>
          </label>

          <div className="fields fields--row">
            <label className="field">
              <span>mandate.max_position_notional</span>
              <input
                value={h.maxNotional}
                onChange={(event) => h.setMaxNotional(event.target.value)}
                disabled={h.phase !== 'setup'}
                inputMode="numeric"
              />
            </label>
            <label className="field">
              <span>mandate.markets[0]</span>
              <select
                className="select"
                value={h.market}
                onChange={(event) => h.setMarket(event.target.value)}
                disabled={h.phase !== 'setup'}
              >
                {VENUE_MARKETS.map((m) => (
                  <option key={marketKey(m)} value={marketKey(m)}>
                    {marketKey(m)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>mandate.max_leverage</span>
              <input
                value={h.maxLeverage}
                onChange={(event) => h.setMaxLeverage(event.target.value)}
                disabled={h.phase !== 'setup'}
                inputMode="numeric"
              />
            </label>
            <label className="field">
              <span>mandate.min_risk_adjusted_portfolio_value</span>
              <input
                value={h.minPortfolioValue}
                onChange={(event) => h.setMinPortfolioValue(event.target.value)}
                disabled={h.phase !== 'setup'}
                inputMode="numeric"
              />
            </label>
          </div>
        </div>

        <p className="hint">
          <code>mandate</code> is <strong>yours to shape</strong>
          {' — '}aomi stores it verbatim and hands it to the agent&apos;s turn as{' '}
          <code>handover_mandate</code>; <strong>your app&apos;s tools enforce it</strong>{' '}
          at trade time. Writing a limit here does not enforce it. Every key above
          is deliberately a quantity World already has, so the app can check it
          against a contract read rather than a number it has to invent:{' '}
          <code>markets</code> is the (product, base, quote) triple{' '}
          <code>get_world_market</code> takes, and{' '}
          <code>min_risk_adjusted_portfolio_value</code> maps to{' '}
          <code>riskAdjustedPortfolioValue(uint64)</code>.
        </p>

        <p className="hint">
          <code>context</code> is <strong>display only, and short-lived</strong>. The
          backend reads <code>summary</code> (else <code>intent</code>) once to
          compose the Telegram greeting and then drops the whole object — nothing
          in <code>context</code> reaches a turn. Send it for the welcome message;
          never rely on it for behaviour.
          {h.ownerWallet ? null : (
            <>
              {' '}
              <strong>No wallet is connected here</strong>, so{' '}
              <code>context.world.owner_wallet</code> is <code>null</code> below.
            </>
          )}
        </p>

        <p className="hint hint--warn">
          <strong>Not delivered yet.</strong> Only <code>mandate</code> currently
          reaches the agent&apos;s turn — it rides on the handover binding and is
          flattened into the turn attributes as <code>handover_mandate</code>.{' '}
          <code>brief</code> and <code>context.world</code> are sent and stored but
          go nowhere, so the World Markets app cannot yet see the standing job or
          resolve which account it is acting on. Both need the same carriage{' '}
          <code>mandate</code> already has. This is the open backend gap, shown here
          rather than hidden so the payload and the reality match.
        </p>

        <PayloadPreview body={h.issueBody} />

        <p className="hint">
          Responds{' '}
          <code>{'{ handover_id, token, session, expires_at, bot_username }'}</code>.
          Both <code>token</code> and <code>session</code> come back{' '}
          <strong>once</strong> — aomi stores only their hashes, under separate
          type domains so neither can be presented as the other. Build{' '}
          <code>t.me/&lt;bot_username&gt;?start=&lt;token&gt;</code> and render it
          yourself. Keep <code>session</code> in memory, not storage.
        </p>

        {h.phase === 'setup' ? (
          <button className="btn btn--primary" onClick={h.issue} disabled={h.busy}>
            {h.busy ? 'issuing…' : 'Issue handover'}
          </button>
        ) : null}
      </StepCard>

      <StepCard
        index={2}
        title="Wait for the claim"
        subtitle="One-time token, short TTL, zero authority. Poll until it flips."
        status={stepStatus(['awaiting-scan'], ['claimed', 'granting', 'active', 'revoking', 'revoked'])}
      >
        <Endpoint
          method="POST"
          path="/api/platforms/:platform/telegram/handover/:bot/:id/status"
          auth="status session · X-Aomi-Handover-Session · poll every 2s"
        />
        <p className="hint">
          The session reads <em>this</em> handover&apos;s status and nothing
          else — it cannot activate, cannot revoke, and has no renewal path. The
          call that returns <code>agent_address</code> is the same call that
          spends it, so poll until the state leaves <code>pending</code> and then
          stop. A later refusal is the session having done its job, not a fault;
          a refusal before that means it expired, and the only way on is a fresh
          issue.
        </p>
        {h.deepLink && h.phase === 'awaiting-scan' ? (
          <>
            <QrPanel
              deepLink={h.deepLink}
              expiresAt={h.issued!.expires_at}
              onExpired={h.markExpired}
            />
            {h.expired ? (
              <div className="banner">
                Code expired — nothing was lost, just issue a new one.
                <button className="btn" onClick={h.reset}>
                  Start over
                </button>
              </div>
            ) : (
              <p className="hint">Waiting for a scan… polling every {POLL_MS / 1000}s.</p>
            )}
          </>
        ) : h.issued && !h.deepLink ? (
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
        status={stepStatus(['claimed', 'granting'], ['active', 'revoking', 'revoked'])}
      >
        <Endpoint
          method="TX"
          path="allowTradingForAccount(uint64 accountId, address agent)"
          auth="account owner's wallet · no aomi call"
        />
        {h.status?.state === 'claimed' || h.phase === 'granting' || h.phase === 'active' ? (
          <>
            <dl className="kv">
              <div>
                <dt>Claimed by</dt>
                <dd>{h.status?.claimed_handle ? `@${h.status.claimed_handle}` : '—'}</dd>
              </div>
              <div>
                <dt>Agent address</dt>
                <dd>
                  <code>{h.status?.agent_address ?? '—'}</code>
                </dd>
              </div>
            </dl>
            <p className="hint">
              This address did not exist when the QR was rendered. It is provisioned
              during the claim — which is exactly why a stolen QR grants nothing.
              Right now the key <strong>cannot sign</strong>; it is armed at
              activation, after you grant.
            </p>
            {h.grantTxHash ? (
              <p className="hint">
                Grant tx: <code>{h.grantTxHash}</code>
              </p>
            ) : (
              <button
                className="btn btn--primary"
                onClick={h.grantVenueAuthority}
                disabled={h.busy || h.phase === 'active'}
              >
                {h.busy ? 'confirm in wallet…' : 'allowTradingForAccount'}
              </button>
            )}
          </>
        ) : (
          <p className="hint">Available once a Telegram user claims the link.</p>
        )}
      </StepCard>

      <StepCard
        index={4}
        title="Activate — turn on signing"
        subtitle="Assert the grant landed. This is what arms the agent key."
        status={stepStatus([], ['active'])}
      >
        <Endpoint
          method="POST"
          path="/api/platforms/:platform/telegram/handover/:bot/:id/activate"
          auth="SIWE signature · second and last"
        />
        <p className="hint">
          aomi does not take your word for the grant. Before arming anything it
          checks four things, each a refusal on its own: neither address is
          zero, the signer is this handover&apos;s own owner, the registry agrees
          in both directions, and the agent is in the account&apos;s{' '}
          <strong>live</strong> trader set. So calling this early fails rather
          than arming a key the venue has not authorized.
        </p>
        {h.phase === 'active' ? (
          <>
            <div className="banner banner--ok">
              Agent is live — key armed for autonomous signing. It can trade this
              account within your mandate, and cannot withdraw.
            </div>
            <button className="btn btn--danger" onClick={h.revoke} disabled={h.busy}>
              Revoke
            </button>
          </>
        ) : h.grantTxHash ? (
          <button className="btn btn--primary" onClick={h.activate} disabled={h.busy}>
            {h.busy ? 'activating…' : 'Confirm grant & activate'}
          </button>
        ) : (
          <p className="hint">
            Send the grant first. Activating early arms the key against an account
            that has not authorized it — the agent gains nothing it can act on, but
            you have turned on signing ahead of consent. Keep the order.
          </p>
        )}
      </StepCard>

      {/*
        Revocation is a venue transaction, not an aomi call. There is no
        browser-side aomi revoke — that route keeps the platform bearer this app
        does not hold — and taking the authority back on chain is the stronger
        fence anyway: the agent key cannot trade for an account that no longer
        lists it, whatever aomi's own record says.
      */}
      {h.phase === 'revoking' ? (
        <div className="banner" role="status">
          <strong>Revocation submitted.</strong> <code>revokeTradingForAccount</code>{' '}
          is broadcast but not yet mined, and <strong>the agent keeps its
          authority until it is</strong>. Waiting for the receipt before calling
          it done — a hash is not a confirmation.
          {h.revokeTxHash ? (
            <p className="hint">
              Transaction <code>{h.revokeTxHash}</code>
            </p>
          ) : null}
        </div>
      ) : null}

      {h.phase === 'revoked' ? (
        <div className="banner">
          <strong>Revoked, confirmed on chain.</strong> The venue has removed the
          agent from this account&apos;s trader set, so it cannot place an order
          — no aomi call was involved, and none is needed.
          <button className="btn" onClick={h.reset}>
            Start over
          </button>
        </div>
      ) : null}
    </div>
  );
}
