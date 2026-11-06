import { useEffect, useState } from 'react';
import { api, getToken, setToken, setUnauthorizedHandler } from './api.js';
import Login from './Login.jsx';
import FileManager from './FileManager.jsx';

const NAV = [
  { group: 'Ebooks', items: [{ id: 'ebooks', label: 'All Ebooks', icon: '📚' }] },
  {
    group: 'Personal Documents',
    items: [
      { id: 'rakesh', label: 'Rakesh', icon: '👤' },
      { id: 'priyanka', label: 'Priyanka', icon: '👤' },
      { id: 'ananya', label: 'Ananya', icon: '👤' },
    ],
  },
];

const ALL = NAV.flatMap((g) => g.items.map((i) => ({ ...i, group: g.group })));

export default function App() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(!!getToken());
  const [section, setSection] = useState(() => localStorage.getItem('mydoc_section') || 'ebooks');
  const [menuOpen, setMenuOpen] = useState(false);

  const logout = () => {
    setToken(null);
    setUser(null);
  };

  useEffect(() => {
    setUnauthorizedHandler(logout);
    if (!getToken()) return;
    api('/me')
      .then((d) => setUser(d.username))
      .catch(logout)
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => localStorage.setItem('mydoc_section', section), [section]);

  if (checking) return <div className="center muted">Loading…</div>;
  if (!user)
    return (
      <Login
        onLogin={(token, username) => {
          setToken(token);
          setUser(username);
        }}
      />
    );

  const current = ALL.find((s) => s.id === section) || ALL[0];

  return (
    <div className="layout">
      <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
        <div className="brand">📁 MyDoc Vault</div>
        <nav>
          {NAV.map((g) => (
            <div key={g.group} className="nav-group">
              <div className="nav-title">{g.group}</div>
              {g.items.map((item) => (
                <button
                  key={item.id}
                  className={`nav-item ${item.id === current.id ? 'active' : ''}`}
                  onClick={() => {
                    setSection(item.id);
                    setMenuOpen(false);
                  }}
                >
                  <span>{item.icon}</span> {item.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="muted">Signed in as {user}</span>
          <button className="btn ghost" onClick={logout}>
            Log out
          </button>
        </div>
      </aside>
      {menuOpen && <div className="backdrop" onClick={() => setMenuOpen(false)} />}
      <main className="main">
        <header className="topbar">
          <button className="btn ghost menu-btn" onClick={() => setMenuOpen(true)} aria-label="Open menu">
            ☰
          </button>
          <div>
            <div className="crumb">{current.group}</div>
            <h1>{current.id === 'ebooks' ? 'Ebooks' : current.label}</h1>
          </div>
        </header>
        <FileManager key={current.id} section={current.id} />
      </main>
    </div>
  );
}
