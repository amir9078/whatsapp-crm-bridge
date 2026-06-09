'use client';
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

export function QrScreen({ status, qr }: { status: string; qr?: string }) {
  const [dataUrl, setDataUrl] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    if (qr) {
      QRCode.toDataURL(qr, { margin: 1, width: 480 })
        .then((url) => {
          if (!cancelled) setDataUrl(url);
        })
        .catch(() => undefined);
    } else {
      setDataUrl(undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [qr]);

  const offline = status === 'server_offline';
  return (
    <div className="qr">
      <div className="qr__left">
        <div className="brandmark">
          <span className="logo">C</span>ChatBridge
        </div>
        <h1>
          Your WhatsApp inbox, <em>wired into your CRM.</em>
        </h1>
        <p className="qr__sub">
          Scan once to link your number. Every chat then syncs in real time and lands as a note on
          the right lead — automatically.
        </p>
        <div className="steps">
          <div className="step">
            <b>1</b> Open WhatsApp on your phone
          </div>
          <div className="step">
            <b>2</b> Tap Menu › Linked devices › Link a device
          </div>
          <div className="step">
            <b>3</b> Point your camera at this screen
          </div>
        </div>
      </div>
      <div className="qr__right">
        <div className="connect-card">
          <h2>{offline ? 'Server not reachable' : 'Link your WhatsApp'}</h2>
          <p>
            {offline
              ? 'Start the backend with: pnpm server:dev'
              : dataUrl
                ? 'Scan this code with your phone.'
                : 'Waiting for WhatsApp to issue a QR code…'}
          </p>
          <div className="qrbox">
            {dataUrl ? (
              <img src={dataUrl} alt="WhatsApp pairing QR code" />
            ) : (
              <div className="spinner" />
            )}
          </div>
          <div className="statuschip">
            <span className={`dot ${offline || status === 'disconnected' ? 'dot--warn' : ''}`} />
            {offline ? 'offline' : status}
          </div>
          <div className="connect-note">Session credentials are stored locally, encrypted.</div>
        </div>
      </div>
    </div>
  );
}
