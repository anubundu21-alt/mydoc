import { useState } from 'react';
import { api } from './api.js';
import Icon from './Icon.jsx';

export default function Login({ onLogin, isDark, toggleTheme }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { token, username: u } = await api('/login', { method: 'POST', body: { username, password } });
      onLogin(token, u);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <section className="login-hero">
        <div className="hero-glow" />
        <div className="brand light">
          <div className="logo">
            <Icon name="folder" size={18} strokeWidth={2.2} />
          </div>
          <div className="brand-name">MyDoc Vault</div>
        </div>
        <div className="hero-copy">
          <h1>
            Your family's library,
            <br />
            safe in one place.
          </h1>
          <p>Ebooks and personal documents for Rakesh, Priyanka and Ananya — ready to download whenever you need them.</p>
          <ul className="hero-points">
            <li>
              <span>
                <Icon name="shield" size={16} />
              </span>
              Private storage with expiring download links
            </li>
            <li>
              <span>
                <Icon name="zap" size={16} />
              </span>
              Original quality — files are never compressed
            </li>
            <li>
              <span>
                <Icon name="cloud" size={16} />
              </span>
              Drag &amp; drop uploads from any device
            </li>
          </ul>
        </div>
        <div className="hero-foot">© {new Date().getFullYear()} MyDoc Vault</div>
      </section>

      <section className="login-side">
        <button className="icon-btn theme-corner" onClick={toggleTheme} aria-label="Toggle theme">
          <Icon name={isDark ? 'sun' : 'moon'} />
        </button>
        <form className="login-form" onSubmit={submit}>
          <div className="login-mark">
            <Icon name="lock" size={22} />
          </div>
          <h2>Welcome back</h2>
          <p className="muted">Sign in to open your vault.</p>

          <label className="field">
            <span>Username</span>
            <div className="input-wrap">
              <Icon name="user" size={17} />
              <input
                className="input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                placeholder="Enter your username"
                autoFocus
                required
              />
            </div>
          </label>

          <label className="field">
            <span>Password</span>
            <div className="input-wrap">
              <Icon name="lock" size={17} />
              <input
                className="input"
                type={show ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                placeholder="Enter your password"
                required
              />
              <button
                type="button"
                className="input-action"
                onClick={() => setShow((s) => !s)}
                aria-label={show ? 'Hide password' : 'Show password'}
              >
                <Icon name={show ? 'eyeOff' : 'eye'} size={17} />
              </button>
            </div>
          </label>

          {error && (
            <div className="alert-box">
              <Icon name="alert" size={16} /> {error}
            </div>
          )}

          <button className="btn btn-primary btn-block btn-lg" disabled={busy}>
            {busy ? <span className="spinner sm" /> : null}
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </section>
    </div>
  );
}
