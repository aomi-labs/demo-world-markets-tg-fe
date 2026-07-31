'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/**
 * The QR itself.
 *
 * The encoded value is just `t.me/<bot>?start=<token>` — Telegram's standard
 * deep link. Nothing sensitive is in it: the token is opaque, one-time, and
 * short-lived, and it carries no authority even while valid. That is the
 * design constraint the whole flow is built around, so the QR needs no special
 * handling beyond not leaving it on screen after it expires.
 */
export function QrPanel({
  deepLink,
  expiresAt,
  onExpired,
}: {
  deepLink: string;
  expiresAt: number;
  onExpired: () => void;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(() =>
    Math.max(0, expiresAt - Math.floor(Date.now() / 1000)),
  );

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(deepLink, { width: 420, margin: 1 })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [deepLink]);

  useEffect(() => {
    const tick = setInterval(() => {
      const left = Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
      setSecondsLeft(left);
      if (left === 0) onExpired();
    }, 1000);
    return () => clearInterval(tick);
  }, [expiresAt, onExpired]);

  return (
    <div className="qr">
      {dataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={dataUrl} alt="Telegram deep link QR code" className="qr__img" />
      ) : (
        <div className="qr__img qr__img--empty">generating…</div>
      )}
      <div className="qr__meta">
        <p className={`qr__countdown ${secondsLeft <= 15 ? 'qr__countdown--urgent' : ''}`}>
          {secondsLeft > 0 ? `expires in ${secondsLeft}s` : 'expired'}
        </p>
        <a className="qr__link" href={deepLink} target="_blank" rel="noreferrer">
          open in Telegram
        </a>
        <code className="qr__raw">{deepLink}</code>
      </div>
    </div>
  );
}
