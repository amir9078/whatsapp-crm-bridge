'use client';
// Single-user login (M7): password → bearer token, then the socket reconnects with it.
import { useState } from 'react';
import { postJson } from '../lib/api';
import { setToken } from '../lib/auth';
import { resetSocket } from '../lib/socket';

export function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { token } = await postJson<{ token: string }>('/api/v1/auth/login', { password });
      setToken(token);
      resetSocket(); // reconnect with the fresh token
      onSuccess();
    } catch {
      setError('Wrong password — try again.');
      setBusy(false);
    }
  };

  return (
    <div className="qr">
      <div className="qr__left">
        <div className="brandmark">
          <div className="logo">C</div>
          ChatBridge
        </div>
        <h1>
          Your chats, <em>locked</em> behind your password.
        </h1>
        <p className="qr__sub">
          This instance requires a password (set via <code>AUTH_PASSWORD</code> on the server).
        </p>
      </div>
      <div className="qr__right">
        <div className="connect-card">
          <h2>Log in</h2>
          <p>Enter the instance password to open your inbox.</p>
          <div className="login-form">
            <input
              type="password"
              placeholder="Password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
            />
            <button className="crm-btn" disabled={busy || !password} onClick={() => void submit()}>
              {busy ? 'Checking…' : 'Log in'}
            </button>
          </div>
          {error && <div className="crm-flash login-flash">{error}</div>}
        </div>
      </div>
    </div>
  );
}
