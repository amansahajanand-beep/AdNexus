import React, { useState, useEffect, useRef, useCallback } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useDispatch } from 'react-redux';
import { networkAPI, clientsAPI, setToken } from '../../utils/api';
import { useAuth } from '../../store/useAuth';
import { authSuccess } from '../../store/actions/authActions';
import { clearReportPages } from '../../store/slices/reportSlice';
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
import { applyTheme, isDarkTheme, readStoredTheme } from '../../utils/theme';
import { getUserFacingMessage, logErrorForDebug } from '../../utils/userFacingError';
import {
  NavIcon,
  Sun,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Menu,
  X,
  LogOut,
  Settings,
  UserRound,
  ShieldAlert,
} from '../ui/Icon';

const FOCUS_KEY = 'adnexus.focusMode';

const NAV_ITEMS = [
  { to: '/dashboard', label: 'Dashboard', page: 'dashboard' },
  { to: '/reporting', label: 'Reporting', page: 'reporting' },
  { to: '/roi', label: 'ROI', page: 'roi' },
  { to: '/my-ads', label: 'Google Ads', page: 'my-ads' },
  { to: '/presets', label: 'Presets', page: 'presets' },
  { to: '/admin', label: 'Admin', page: 'admin', adminOnly: true },
  { to: '/domain-user', label: 'Domain User', page: 'domain-user' },
  { to: '/help', label: 'Help', page: 'help', always: true },
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

function pickDefaultNetworkId(networks = [], preferredId = null) {
  const list = Array.isArray(networks) ? networks : [];
  if (!list.length) return null;
  if (preferredId && list.some((n) => n.id === preferredId)) return preferredId;
  const media = list.find((n) => /mediamonetix/i.test(String(n.name || n.slug || '')));
  return (media || list[0])?.id || null;
}

function networkOptionLabel(n) {
  if (!n) return '';
  const name = n.name || n.displayName || 'Network';
  return n.networkCode ? `${name} · ${n.networkCode}` : name;
}

export default function Layout() {
  const { user, isAdmin, logout } = useAuth();
  const { canPage, hasAnyPage } = usePermissions();
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const [networkInfo, setNetworkInfo] = useState(null);
  const [isMock, setIsMock] = useState(false);
  const [accountNetworks, setAccountNetworks] = useState([]);
  const [viewClientId, setViewClientId] = useState(null);
  const [switchingNetwork, setSwitchingNetwork] = useState(false);
  const [verDismissed, setVerDismissed] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(readFocusMode);
  const [darkMode, setDarkMode] = useState(() => readStoredTheme() === 'dark');
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

  const toggleDarkMode = useCallback(() => {
    const next = applyTheme(isDarkTheme() ? 'light' : 'dark');
    setDarkMode(next === 'dark');
  }, []);

  const refreshNetworkInfo = useCallback(async (clientId) => {
    try {
      const info = await networkAPI.getInfo(clientId || undefined);
      setNetworkInfo(info);
      setIsMock(!!info.isMock);
    } catch (err) {
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
    }
  }, []);

  // Load networks once per user. Domain users must stay on accessible-networks
  // (never fall back to /me which lists every account network).
  useEffect(() => {
    let cancelled = false;
    const applyList = (list, activeId) => {
      if (cancelled) return;
      const networks = (list || []).filter((n) => !n.isPending && n.networkCode && n.id);
      setAccountNetworks(networks);
      setViewClientId((prev) => {
        if (prev && networks.some((n) => n.id === prev)) return prev;
        const preferred = user?.clientId || activeId;
        if (preferred && networks.some((n) => n.id === preferred)) return preferred;
        return pickDefaultNetworkId(networks, preferred);
      });
    };

    (async () => {
      try {
        const d = await clientsAPI.accessibleNetworks();
        applyList(d?.networks, d?.activeClientId || user?.clientId);
        return;
      } catch (_) {
        /* fall through */
      }
      if (isAdmin) {
        try {
          const d = await clientsAPI.networks();
          applyList(d?.networks, d?.activeClientId || user?.clientId);
          return;
        } catch (_) { /* try me */ }
        try {
          const d = await clientsAPI.me();
          applyList(d?.networks, d?.activeClientId || d?.id);
          return;
        } catch (_) { /* empty */ }
      } else {
        // Domain user: only their linked client — never the full account list.
        try {
          const d = await clientsAPI.me();
          const self = d?.id || user?.clientId;
          const fromMe = (d?.networks || []).filter((n) => n.id === self);
          applyList(fromMe.length ? fromMe : (self ? [{
            id: self,
            name: d?.name || d?.displayName,
            networkCode: d?.networkCode,
          }] : []), self);
          return;
        } catch (_) { /* empty */ }
      }
      if (!cancelled) setAccountNetworks([]);
    })();

    return () => { cancelled = true; };
  }, [user?.id, isAdmin]);

  // Domain users: never switch session network — combined view uses headers only.
  useEffect(() => {
    if (!isAdmin) return undefined;
    const id = viewClientId || user?.clientId;
    if (!id) return undefined;
    refreshNetworkInfo(id);
    return undefined;
  }, [isAdmin, viewClientId, user?.clientId, refreshNetworkInfo]);

  // Domain / single-tenant: currency chip from linked primary client only.
  useEffect(() => {
    if (isAdmin) return undefined;
    const id = user?.clientId;
    if (!id) return undefined;
    refreshNetworkInfo(id);
    return undefined;
  }, [isAdmin, user?.clientId, refreshNetworkInfo]);

  const switchNetwork = useCallback(async (clientId) => {
    const nextId = String(clientId || '').trim();
    if (!nextId || nextId === String(viewClientId || '')) return;
    if (!accountNetworks.some((n) => n.id === nextId)) return;
    setSwitchingNetwork(true);
    // Update view immediately so Dashboard/Reporting follow the select even if
    // session persist fails (domain users may only have header override).
    setViewClientId(nextId);
    try {
      const data = await clientsAPI.setActiveNetwork(nextId);
      if (data?.activeClientId) setViewClientId(data.activeClientId);
      if (data?.token && data?.user) {
        setToken(data.token);
        dispatch(clearReportPages());
        dispatch(authSuccess(data.user));
      }
      await refreshNetworkInfo(data?.activeClientId || nextId);
    } catch (err) {
      logErrorForDebug(err, 'Switch network');
      // Keep local viewClientId — X-Gam-Client-Id still scopes API calls.
      try {
        await refreshNetworkInfo(nextId);
      } catch (_) { /* ignore */ }
    } finally {
      setSwitchingNetwork(false);
    }
  }, [accountNetworks, viewClientId, dispatch, refreshNetworkInfo]);

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
    if (i.always) return true;
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

  const canSwitchNetwork = isAdmin && accountNetworks.length > 1;
  // Domain users never see network chrome — they get a combined multi-network view.
  const showNetworkChrome = isAdmin && (networkInfo || accountNetworks.length > 0);
  const activeNetwork = accountNetworks.find((n) => n.id === viewClientId)
    || accountNetworks.find((n) => n.id === user?.clientId)
    || null;
  const networkLabelText = activeNetwork
    ? networkOptionLabel(activeNetwork)
    : (networkInfo
      ? `${networkInfo.displayName || 'Network'}${networkInfo.networkCode ? ` · ${networkInfo.networkCode}` : ''}`
      : '');

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
            {!focusMode && showNetworkChrome && (
              canSwitchNetwork ? (
                <label className="network-switch-wrap" title="Switch network for Dashboard & Reporting">
                  <span className="sr-only">Active network</span>
                  <select
                    className="network-label network-switch"
                    value={viewClientId || activeNetwork?.id || ''}
                    disabled={switchingNetwork}
                    onChange={(e) => switchNetwork(e.target.value)}
                    aria-label="Switch network"
                  >
                    {accountNetworks.map((n) => (
                      <option key={n.id} value={n.id}>{networkOptionLabel(n)}</option>
                    ))}
                  </select>
                </label>
              ) : (
                <span className="network-label" title={networkInfo?.networkCode ? `Network ${networkInfo.networkCode}` : undefined}>
                  {networkLabelText || (networkInfo?.displayName
                    ? `${networkInfo.displayName}${networkInfo.networkCode ? ` · ${networkInfo.networkCode}` : ''}`
                    : '')}
                </span>
              )
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
                <span className="nav-btn-icon" aria-hidden>
                  <NavIcon page={item.page} size={focusMode ? 20 : 18} />
                </span>
                <span className="nav-btn-label">{item.label}</span>
              </NavLink>
            ))}
          </nav>

          <div className="sidebar-foot">
            <button
              type="button"
              className="sidebar-focus-toggle"
              onClick={toggleDarkMode}
              title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
              aria-pressed={darkMode}
            >
              <span className="sidebar-toggle-icon" aria-hidden>
                {darkMode ? <Sun size={16} strokeWidth={1.75} /> : <Moon size={16} strokeWidth={1.75} />}
              </span>
              <span className="sidebar-focus-label">{darkMode ? 'Light' : 'Dark'}</span>
            </button>
            <button
              type="button"
              className="sidebar-focus-toggle"
              onClick={toggleFocusMode}
              title={focusMode ? 'Expand sidebar ([)' : 'Focus mode — more chart width ([)'}
              aria-pressed={focusMode}
            >
              <span className="sidebar-toggle-icon" aria-hidden>
                {focusMode
                  ? <PanelLeftOpen size={16} strokeWidth={1.75} />
                  : <PanelLeftClose size={16} strokeWidth={1.75} />}
              </span>
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
                    <button type="button" className="user-dd-item" onClick={() => go('/admin')}>
                      <Settings size={15} strokeWidth={1.75} aria-hidden />
                      Admin Settings
                    </button>
                  )}
                  {canPage('domain-user') && (
                    <button type="button" className="user-dd-item" onClick={() => go('/domain-user')}>
                      <UserRound size={15} strokeWidth={1.75} aria-hidden />
                      My Profile
                    </button>
                  )}
                  <button type="button" className="user-dd-item" onClick={handleLogout}>
                    <LogOut size={15} strokeWidth={1.75} aria-hidden />
                    Logout
                  </button>
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
              {menuOpen ? <X size={18} strokeWidth={1.75} /> : <Menu size={18} strokeWidth={1.75} />}
            </button>
            <BrandLogo />
            <button
              type="button"
              className="theme-toggle-mobile"
              onClick={toggleDarkMode}
              title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
              aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
              aria-pressed={darkMode}
            >
              {darkMode ? <Sun size={16} strokeWidth={1.75} /> : <Moon size={16} strokeWidth={1.75} />}
            </button>
            <span className="context-chip" title={`Currency ${currencyCode} · ${APP_TIMEZONE}`}>
              {currencyCode} · {tzShort}
            </span>
            <div className={liveClass}>
              <span className="dot-pulse" />
              {liveText}
            </div>
          </header>

          <main className="app-main">
            {noAccess && location.pathname !== '/help' ? (
              <div className="no-access-wrap">
                <div className="no-access-card">
                  <div className="no-access-icon" aria-hidden>
                    <ShieldAlert size={28} strokeWidth={1.75} />
                  </div>
                  <h2 className="no-access-title">{noInventoryAssigned ? NO_DOMAINS_TITLE : 'Access Restricted'}</h2>
                  <p className="no-access-msg">
                    {noInventoryAssigned
                      ? NO_DOMAINS_MSG
                      : "You don't have permission to access this resource. Please contact your administrator."}
                  </p>
                  <p className="no-access-msg" style={{ marginTop: 12 }}>
                    See <NavLink to="/help">Help</NavLink> for what to ask your admin and how filters work.
                  </p>
                </div>
              </div>
            ) : (
              <Outlet
                key={darkMode ? 'dark' : 'light'}
                context={{
                  networkInfo,
                  isMock,
                  // Admin: active sidebar network. Domain: null → pages merge all accessible networks.
                  viewClientId: isAdmin ? (viewClientId || user?.clientId || null) : null,
                  accountNetworks,
                  switchNetwork: isAdmin ? switchNetwork : undefined,
                  switchingNetwork: isAdmin ? switchingNetwork : false,
                  mergeNetworkIds: isAdmin
                    ? null
                    : accountNetworks.map((n) => n.id).filter(Boolean),
                }}
              />
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
