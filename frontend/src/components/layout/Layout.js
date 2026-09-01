import React, { useState, useEffect, useRef, useCallback } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { networkAPI } from '../../utils/api';
import { useAuth } from '../../store/useAuth';
import { usePermissions } from '../../hooks/usePermissions';
import { NO_DOMAINS_MSG, NO_DOMAINS_TITLE, hasAssignedInventory } from '../../utils/permissions';
import BrandLogo from '../ui/BrandLogo';
import ToastStack from '../ui/ToastStack';
import CommandPalette from '../ui/CommandPalette';
import DataFreshness from '../ui/DataFreshness';
import { ConfirmDialogHost } from '../../hooks/useConfirmDialog';
import { rememberLastRoute } from '../../utils/lastRoute';
import { APP_TIMEZONE } from '../../utils/datetime';
import { buildFreshnessLabel } from '../../utils/dataFreshness';

const FOCUS_KEY = 'adnexus.focusMode';

const NAV_ITEMS = [
  { to: '/dashboard', label: 'Dashboard', short: 'D', page: 'dashboard' },
  { to: '/reporting', label: 'Reporting', short: 'R', page: 'reporting' },
  { to: '/roi', label: 'ROI', short: 'O', page: 'roi' },
  { to: '/presets', label: 'Presets', short: 'P', page: 'presets' },
  { to: '/admin', label: 'Admin', short: 'A', adminOnly: true },
  { to: '/domain-user', label: 'Domain User', short: 'U', page: 'domain-user' },
];

function statusLabel(isMock, authError) {
  if (isMock) return 'Mock';
  if (authError) return 'Offline';
  return 'Live';
}

function readFocusMode() {
  try {
    return localStorage.getItem(FOCUS_KEY) === '1';
  } catch {
    return false;
  }
}

export default function Layout() {
  const { user, isAdmin, logout } = useAuth();
  const { canPage, hasAnyPage } = usePermissions();
  const navigate = useNavigate();
  const location = useLocation();
  const [networkInfo, setNetworkInfo] = useState(null);
  const [isMock, setIsMock] = useState(false);
  const [verDismissed, setVerDismissed] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(readFocusMode);
  const userRef = useRef(null);

  const toggleFocusMode = useCallback(() => {
    setFocusMode((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(FOCUS_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  useEffect(() => {
    networkAPI.getInfo()
      .then(info => { setNetworkInfo(info); setIsMock(!!info.isMock); })
      .catch((err) => {
        const data = err?.response?.data;
        setIsMock(!!data?.isMock);
        if (data?.error) {
          setNetworkInfo({
            displayName: 'Connection issue',
            isMock: false,
            authError: data.error,
            authCode: data.code,
          });
        }
      });
  }, []);

  useEffect(() => {
    const onClick = (e) => {
      if (userRef.current && !userRef.current.contains(e.target)) setUserOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  useEffect(() => { setMenuOpen(false); }, [location.pathname]);

  useEffect(() => {
    rememberLastRoute(location.pathname);
  }, [location.pathname]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('sidebar-open');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('sidebar-open');
    };
  }, [menuOpen]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
      if (e.key === '[') {
        e.preventDefault();
        toggleFocusMode();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [toggleFocusMode]);

  const handleLogout = () => {
    logout();
    setUserOpen(false);
    navigate('/login', { replace: true, state: { resetKey: Date.now() } });
  };
  const go = (to) => { navigate(to); setUserOpen(false); };
  const profileRoute = isAdmin ? '/admin' : (canPage('domain-user') ? '/domain-user' : null);
  const goProfile = () => {
    if (profileRoute) go(profileRoute);
  };

  const initial = (user?.username || 'U').charAt(0).toUpperCase();
  const navItems = NAV_ITEMS.filter((i) => {
    if (i.adminOnly) return isAdmin;
    if (i.page) return canPage(i.page);
    return true;
  });

  const noInventoryAssigned = !!user && user.role !== 'admin' && !hasAssignedInventory(user);
  const noAccess = !!user && !isAdmin && (!hasAnyPage || noInventoryAssigned);
  const authError = !isMock && networkInfo?.authError;
  const liveText = statusLabel(isMock, authError);
  const liveClass = `live-dot header-live${isMock ? ' is-mock' : ''}${authError ? ' is-auth-error' : ''}`;
  const currencyCode = networkInfo?.currencyCode || 'USD';
  const tzShort = APP_TIMEZONE === 'Asia/Singapore' ? 'SGT' : APP_TIMEZONE;
  const freshnessTitle = buildFreshnessLabel(networkInfo, { tzLabel: tzShort })
    || liveText;

  const gv = networkInfo?.gamVersion;
  const verStatus = gv?.status;
  const showVerWarn = isAdmin && !verDismissed
    && (verStatus === 'approaching' || verStatus === 'deprecated' || verStatus === 'sunset');
  const verMessage = (() => {
    if (!gv) return '';
    if (verStatus === 'sunset')
      return `Ad network API ${gv.version} is no longer supported (sunset ${gv.sunsetDate}). Live data may stop working — update GAM_API_VERSION in .env to the latest version.`;
    if (verStatus === 'deprecated')
      return `Ad network API ${gv.version} is deprecated and will stop working in ${gv.sunsetDate}. Update GAM_API_VERSION in .env soon.`;
    return `Heads up: Ad network API ${gv.version} will be deprecated in ${gv.deprecationDate} and stop working in ${gv.sunsetDate}. Plan to update GAM_API_VERSION in .env.`;
  })();

  return (
    <div className={`app app-shell${focusMode ? ' is-focus-mode' : ''}`}>
      {isMock && (
        <div className="status-banner status-banner--mock" role="status">
          <strong>Mock mode</strong>
          <span>Showing sample data. Add live ad network credentials and restart the backend to load real metrics.</span>
        </div>
      )}

      {authError && (
        <div className="status-banner status-banner--auth" role="alert">
          <strong>Connection issue</strong>
          <span className="status-banner-text">{networkInfo.authError}</span>
          {isAdmin && (
            <button
              type="button"
              className="status-banner-action"
              onClick={() => go('/admin?oauth=1')}
            >
              Open Client settings
            </button>
          )}
        </div>
      )}

      {showVerWarn && (
        <div className={`status-banner status-banner--version${verStatus === 'sunset' ? ' is-critical' : ''}`} role="status">
          <span className="status-banner-text">{verMessage}</span>
          <button type="button" className="status-banner-close" onClick={() => setVerDismissed(true)} aria-label="Dismiss">✕</button>
        </div>
      )}

      {menuOpen && (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="Close menu"
          onClick={() => setMenuOpen(false)}
        />
      )}

      <div className="app-shell-body">
        <aside className={`app-sidebar ${menuOpen ? 'open' : ''}${focusMode ? ' is-collapsed' : ''}`}>
          <div className="sidebar-top">
            <BrandLogo showTitle={!focusMode} markSize={focusMode ? 26 : 28} />
            {!focusMode && networkInfo && (
              <span className="network-label">{networkInfo.displayName}</span>
            )}
            {!focusMode && (
              <span className="context-chip context-chip--sidebar" title={`Currency ${currencyCode} · ${APP_TIMEZONE}`}>
                {currencyCode} · {tzShort}
              </span>
            )}
          </div>

          <nav className="sidebar-nav">
            {navItems.map(item => (
              <NavLink
                key={item.to}
                to={item.to}
                title={item.label}
                className={({ isActive }) => `nav-btn ${isActive ? 'active' : ''}`}
                onClick={() => setMenuOpen(false)}
              >
                <span className="nav-btn-short" aria-hidden>{item.short}</span>
                <span className="nav-btn-label">{item.label}</span>
              </NavLink>
            ))}
          </nav>

          <div className="sidebar-foot">
            <button
              type="button"
              className="sidebar-focus-toggle"
              onClick={toggleFocusMode}
              title={focusMode ? 'Expand sidebar ([)' : 'Focus mode — more chart width ([)'}
              aria-pressed={focusMode}
            >
              {focusMode ? '»' : '«'}
              <span className="sidebar-focus-label">{focusMode ? 'Expand' : 'Focus'}</span>
            </button>
            <div className={liveClass} title={freshnessTitle}>
              <span className="dot-pulse" />
              <span className="live-dot-label">{liveText}</span>
              {!focusMode && !authError && networkInfo && (networkInfo.gamLastSyncedAt || networkInfo.adsLastSyncedAt) && (
                <DataFreshness networkInfo={networkInfo} tzLabel={tzShort} compact className="live-dot-fresh" />
              )}
            </div>
            <div className="user-menu" ref={userRef}>
              <button type="button" className="user-btn" onClick={() => setUserOpen(o => !o)} title={user?.username}>
                <span className="user-avatar">{initial}</span>
                <span className="user-name">{user?.username}</span>
                <span className="user-caret">▾</span>
              </button>
              {userOpen && (
                <div className="user-dropdown user-dropdown-sidebar">
                  <button
                    type="button"
                    className="user-dd-head user-dd-head-btn"
                    onClick={goProfile}
                    disabled={!profileRoute}
                    title={profileRoute ? 'Open profile' : undefined}
                  >
                    <span className="user-avatar lg">{initial}</span>
                    <div>
                      <div className="user-dd-name">{user?.username}</div>
                      <div className="user-dd-role">{isAdmin ? 'Administrator' : 'Domain User'}</div>
                    </div>
                  </button>
                  {isAdmin && (
                    <button type="button" className="user-dd-item" onClick={() => go('/admin')}>Admin Settings</button>
                  )}
                  {canPage('domain-user') && (
                    <button type="button" className="user-dd-item" onClick={() => go('/domain-user')}>My Profile</button>
                  )}
                  <button type="button" className="user-dd-item" onClick={handleLogout}>Logout</button>
                </div>
              )}
            </div>
          </div>
        </aside>

        <div className="app-content">
          <header className="app-mobile-bar">
            <button
              type="button"
              className="nav-toggle"
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(o => !o)}
            >
              {menuOpen ? '✕' : '☰'}
            </button>
            <BrandLogo />
            <span className="context-chip" title={`Currency ${currencyCode} · ${APP_TIMEZONE}`}>
              {currencyCode} · {tzShort}
            </span>
            <div className={liveClass}>
              <span className="dot-pulse" />
              {liveText}
            </div>
          </header>

          <main className="app-main">
            {noAccess ? (
              <div className="no-access-wrap">
                <div className="no-access-card">
                  <div className="no-access-icon" aria-hidden>!</div>
                  <h2 className="no-access-title">{noInventoryAssigned ? NO_DOMAINS_TITLE : 'Access Restricted'}</h2>
                  <p className="no-access-msg">
                    {noInventoryAssigned
                      ? NO_DOMAINS_MSG
                      : "You don't have permission to access this resource. Please contact your administrator."}
                  </p>
                </div>
              </div>
            ) : (
              <Outlet context={{ networkInfo, isMock }} />
            )}
          </main>
          <ToastStack />
          <ConfirmDialogHost />
          <CommandPalette />
        </div>
      </div>
    </div>
  );
}
