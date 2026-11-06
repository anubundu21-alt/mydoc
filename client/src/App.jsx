import { useCallback, useEffect, useState } from 'react';
import { api, getToken, setToken, setUnauthorizedHandler } from './api.js';
import Login from './Login.jsx';
import FileManager from './FileManager.jsx';
import Icon from './Icon.jsx';
import { formatSize } from './ui.jsx';

export const SECTIONS = [
  {
    id: 'ebooks',
    group: 'Library',
    label: 'Ebooks',
    title: 'Ebooks',
    subtitle: 'Your digital library — books, guides and reading material.',
    icon: 'book',
    tone: 'indigo',
  },
  {
    id: 'rakesh',
    group: 'Personal Documents',
    label: 'Rakesh',
    title: "Rakesh's Documents",
    subtitle: 'IDs, certificates, records and other personal files.',
    initials: 'R',
    tone: 'blue',
  },
  {
    id: 'priyanka',
    group: 'Personal Documents',
    label: 'Priyanka',
    title: "Priyanka's Documents",
    subtitle: 'IDs, certificates, records and other personal files.',
    initials: 'P',
    tone: 'rose',
  },
  {
    id: 'ananya',
    group: 'Personal Documents',
    label: 'Ananya',
    title: "Ananya's Documents",
    subtitle: 'School records, certificates and other personal files.',
    initials: 'A',
    tone: 'amber',
  },
];
const GROUPS = [...new Set(SECTIONS.map((s) => s.group))];

function useTheme() {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('mydoc_theme') || '';
    } catch {
      return '';
    }
  });
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    try {
      localStorage.setItem('mydoc_theme', theme);
    } catch {}
  }, [theme]);
  const isDark = theme ? theme === 'dark' : window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  return [isDark, () => setTheme(isDark ? 'light' : 'dark')];
}

export default function App() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(!!getToken());
  const [section, setSection] = useState(() => localStorage.getItem('mydoc_section') || 'ebooks');
  const [menuOpen, setMenuOpen] = useState(false);
  const [stats, setStats] = useState({});
  const [isDark, toggleTheme] = useTheme();

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    if (!getToken()) return;
    api('/me')
      .then((d) => setUser(d.username))
      .catch(logout)
      .finally(() => setChecking(false));
  }, [logout]);

  const loadStats = useCallback(() => {
    api('/stats').then(setStats).catch(() => {});
  }, []);

  useEffect(() => {
    if (user) loadStats();
  }, [user, loadStats]);

  useEffect(() => localStorage.setItem('mydoc_section', section), [section]);

  if (checking)
    return (
      <div className="splash">
        <div className="spinner" />
      </div>
    );

  if (!user)
    return (
      <Login
        isDark={isDark}
        toggleTheme={toggleTheme}
        onLogin={(token, username) => {
          setToken(token);
          setUser(username);
        }}
      />
    );

  const current = SECTIONS.find((s) => s.id === section) || SECTIONS[0];
  const totalFiles = Object.values(stats).reduce((n, s) => n + s.count, 0);
  const totalSize = Object.values(stats).reduce((n, s) => n + s.size, 0);

  return (
    <div className="layout">
      <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
        <div className="brand">
          <div className="logo">
            <Icon name="folder" size={18} strokeWidth={2.2} />
          </div>
          <div>
            <div className="brand-name">MyDoc Vault</div>
            <div className="brand-sub">Private family library</div>
          </div>
        </div>

        <nav className="nav">
          {GROUPS.map((g) => (
            <div key={g} className="nav-group">
              <div className="nav-title">{g}</div>
              {SECTIONS.filter((s) => s.group === g).map((s) => (
                <button
                  key={s.id}
                  className={`nav-item ${s.id === current.id ? 'active' : ''}`}
                  onClick={() => {
                    setSection(s.id);
                    setMenuOpen(false);
                  }}
                >
                  {s.icon ? (
                    <span className={`nav-icon tone-${s.tone}`}>
                      <Icon name={s.icon} size={16} />
                    </span>
                  ) : (
                    <span className={`avatar tone-${s.tone}`}>{s.initials}</span>
                  )}
                  <span className="nav-label">{s.label}</span>
                  <span className="nav-count">{stats[s.id]?.count ?? '·'}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="storage-card">
          <div className="storage-row">
            <Icon name="database" size={16} />
            <span>Storage used</span>
          </div>
          <div className="storage-value">{formatSize(totalSize)}</div>
          <div className="storage-sub">
            {totalFiles} file{totalFiles === 1 ? '' : 's'} across {SECTIONS.length} folders
          </div>
        </div>

        <div className="sidebar-footer">
          <div className="me">
            <span className="avatar tone-slate">{user[0]?.toUpperCase()}</span>
            <div className="me-text">
              <div className="me-name">{user}</div>
              <div className="me-sub">Administrator</div>
            </div>
          </div>
          <div className="footer-actions">
            <button className="icon-btn" onClick={toggleTheme} title={isDark ? 'Light mode' : 'Dark mode'}>
              <Icon name={isDark ? 'sun' : 'moon'} />
            </button>
            <button className="icon-btn" onClick={logout} title="Log out">
              <Icon name="logout" />
            </button>
          </div>
        </div>
      </aside>
      {menuOpen && <div className="backdrop" onClick={() => setMenuOpen(false)} />}

      <main className="main">
        <div className="mobile-bar">
          <button className="icon-btn" onClick={() => setMenuOpen(true)} aria-label="Open menu">
            <Icon name="menu" />
          </button>
          <span className="brand-name">MyDoc Vault</span>
          <button className="icon-btn" onClick={toggleTheme} aria-label="Toggle theme">
            <Icon name={isDark ? 'sun' : 'moon'} />
          </button>
        </div>
        <FileManager key={current.id} section={current} stats={stats[current.id]} onChanged={loadStats} />
      </main>
    </div>
  );
}
