import React, { useState, useEffect, useRef, useCallback } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useDispatch } from 'react-redux';
import { networkAPI, clientsAPI, setToken, admobAPI, adsenseAPI } from '../../utils/api';
import { useAuth } from '../../store/useAuth';
import { authSuccess } from '../../store/actions/authActions';
import { clearReportPages } from '../../store/slices/reportSlice';
import { usePermissions } from '../../hooks/usePermissions';
import { NO_DOMAINS_MSG, NO_DOMAINS_TITLE, hasAssignedInventory } from '../../utils/permissions';
import BrandLogo from '../ui/BrandLogo';
import ToastStack from '../ui/ToastStack';
import CommandPalette from '../ui/CommandPalette';
import DataFreshness from '../ui/DataFreshness';
import ProductSwitcher from '../ui/ProductSwitcher';
import { ConfirmDialogHost } from '../../hooks/useConfirmDialog';
import { rememberLastRoute } from '../../utils/lastRoute';
import { APP_TIMEZONE } from '../../utils/datetime';
import { buildFreshnessLabel, buildPublisherFreshnessLabel, relativeFreshness } from '../../utils/dataFreshness';
import { applyTheme, isDarkTheme, readStoredTheme } from '../../utils/theme';
import { getUserFacingMessage, logErrorForDebug } from '../../utils/userFacingError';
import {
  resolveActiveProduct,
  writeStoredProduct,
  getProduct,
  navItemsForProduct,
} from '../../utils/productWorkspace';
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
const ADMOB_ACCOUNT_KEY = 'adnexus.admobViewAccountId';

function readStoredAdmobAccountId() {
  try {
    return localStorage.getItem(ADMOB_ACCOUNT_KEY) || null;
  } catch {
    return null;
  }
}

function writeStoredAdmobAccountId(id) {
  try {
    if (id) localStorage.setItem(ADMOB_ACCOUNT_KEY, id);
    else localStorage.removeItem(ADMOB_ACCOUNT_KEY);
  } catch {
    /* ignore */
  }
}

function admobAccountLabel(a) {
  if (!a) return 'AdMob';
  const name = a.descriptiveName || a.accountId || 'AdMob account';
  if (a.accountId && a.descriptiveName && a.descriptiveName !== a.accountId) {
    return `${a.descriptiveName} · ${a.accountId}`;
  }
  return name;
}

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
  const { canPage, hasAnyPage, visibility } = usePermissions();
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
  const [publisherFreshness, setPublisherFreshness] = useState(null);
  const [publisherAccountLabel, setPublisherAccountLabel] = useState(null);
  const [admobAccounts, setAdmobAccounts] = useState([]);
  const [viewAdmobAccountId, setViewAdmobAccountId] = useState(() => (
    isAdmin ? readStoredAdmobAccountId() : null
  ));
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

  useEffect(() => {
    const id = viewClientId || user?.clientId;
    if (!id) return undefined;
    refreshNetworkInfo(id);
    return undefined;
  }, [viewClientId, user?.clientId, refreshNetworkInfo]);

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

  const activeProduct = resolveActiveProduct(location.pathname);
  const productMeta = getProduct(activeProduct);

  const allowedProducts = React.useMemo(() => {
    const ids = [];
    const pages = visibility?.pages || {};
    if (isAdmin || pages.dashboard || pages.reporting || pages.roi || pages.myAds || pages.domainUser) {
      ids.push('gam');
    }
    if (isAdmin || pages.admob !== false) ids.push('admob');
    if (isAdmin || pages.adsense !== false) ids.push('adsense');
    return ids.length ? ids : ['gam'];
  }, [visibility, isAdmin]);

  const handleProductChange = useCallback((nextId) => {
    writeStoredProduct(nextId);
    const home = getProduct(nextId).home;
    navigate(home);
    setMenuOpen(false);
  }, [navigate]);

  useEffect(() => {
    writeStoredProduct(activeProduct);
    document.documentElement.setAttribute('data-product', activeProduct);
    return () => {
      document.documentElement.removeAttribute('data-product');
    };
  }, [activeProduct]);

  useEffect(() => {
    if (activeProduct !== 'admob' && activeProduct !== 'adsense') {
      setPublisherFreshness(null);
      setPublisherAccountLabel(null);
      return undefined;
    }
    let cancelled = false;
    const api = activeProduct === 'admob' ? admobAPI : adsenseAPI;
    const freshParams = activeProduct === 'admob' && isAdmin && viewAdmobAccountId
      ? { accountId: viewAdmobAccountId }
      : undefined;
    (async () => {
      try {
        const fresh = await api.freshness(freshParams).catch(() => null);
        if (cancelled) return;
        setPublisherFreshness(fresh);
        if (activeProduct === 'admob' && isAdmin && admobAccounts.length) {
          const selected = admobAccounts.find((a) => a.id === viewAdmobAccountId) || admobAccounts[0];
          setPublisherAccountLabel(admobAccountLabel(selected) || fresh?.accountLabel || 'AdMob');
        } else {
          setPublisherAccountLabel(
            fresh?.accountLabel
            || (fresh?.accountCount
              ? `${fresh.accountCount} account${fresh.accountCount === 1 ? '' : 's'}`
              : (activeProduct === 'admob' ? 'No AdMob account' : 'No AdSense account'))
          );
        }
      } catch {
        if (!cancelled) {
          setPublisherFreshness(null);
          setPublisherAccountLabel(null);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [activeProduct, isAdmin, viewAdmobAccountId, admobAccounts]);

  // Admin: load AdMob accounts for switcher (scoped to current GAM client).
  useEffect(() => {
    if (!isAdmin || activeProduct !== 'admob') {
      if (activeProduct !== 'admob') setAdmobAccounts([]);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await admobAPI.listAccounts();
        if (cancelled) return;
        const list = (res?.accounts || []).filter((a) => a.hasRefreshToken && a.isActive !== false);
        setAdmobAccounts(list);
        setViewAdmobAccountId((prev) => {
          const stored = prev || readStoredAdmobAccountId();
          if (stored && list.some((a) => a.id === stored)) {
            writeStoredAdmobAccountId(stored);
            return stored;
          }
          const next = list[0]?.id || null;
          writeStoredAdmobAccountId(next);
          return next;
        });
      } catch (err) {
        logErrorForDebug(err, 'admob accounts');
        if (!cancelled) setAdmobAccounts([]);
      }
    })();
    return () => { cancelled = true; };
  }, [isAdmin, activeProduct, viewClientId]);

  const switchAdmobAccount = useCallback((accountId) => {
    if (!accountId) return;
    setViewAdmobAccountId(accountId);
    writeStoredAdmobAccountId(accountId);
    const selected = admobAccounts.find((a) => a.id === accountId);
    if (selected) setPublisherAccountLabel(admobAccountLabel(selected));
  }, [admobAccounts]);

  const initial = (user?.username || 'U').charAt(0).toUpperCase();
  const navItems = navItemsForProduct(activeProduct).filter((i) => {
    if (i.adminOnly) return isAdmin;
    if (i.always) return true;
    if (i.page) return canPage(i.page);
    return true;
  });

  const noInventoryAssigned = !!user && user.role !== 'admin' && !hasAssignedInventory(user)
    && activeProduct === 'gam';
  const noAccess = !!user && !isAdmin && (!hasAnyPage || noInventoryAssigned);
  const authError = activeProduct === 'gam' && !isMock && networkInfo?.authError;
  const liveText = statusLabel(isMock, authError);
  const liveClass = `live-dot header-live${isMock ? ' is-mock' : ''}${authError ? ' is-auth-error' : ''}`;
  const currencyCode = networkInfo?.currencyCode || 'USD';
  const tzShort = APP_TIMEZONE === 'Asia/Singapore' ? 'SGT' : APP_TIMEZONE;
  const publisherSyncAt = publisherFreshness?.lastSyncAt || null;
  const freshnessTitle = activeProduct === 'gam'
    ? (buildFreshnessLabel(networkInfo, { tzLabel: tzShort }) || liveText)
    : (buildPublisherFreshnessLabel(publisherSyncAt, {
      productLabel: productMeta.label,
      tzLabel: tzShort,
    }) || liveText);

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

  const canSwitchNetwork = accountNetworks.length > 1;
  const canSwitchAdmobAccount = isAdmin && admobAccounts.length > 1;
  const activeAdmobAccount = admobAccounts.find((a) => a.id === viewAdmobAccountId) || admobAccounts[0] || null;
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
        <aside className={`app-sidebar app-sidebar--${activeProduct} ${menuOpen ? 'open' : ''}${focusMode ? ' is-collapsed' : ''}`}>
          <div className="sidebar-top">
            <BrandLogo showTitle={!focusMode} markSize={focusMode ? 26 : 28} />
            <ProductSwitcher
              productId={activeProduct}
              onChange={handleProductChange}
              compact={focusMode}
              allowedProductIds={allowedProducts}
            />
            {!focusMode && activeProduct === 'gam' && (networkInfo || accountNetworks.length > 0) && (
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
            {!focusMode && activeProduct === 'admob' && (
              canSwitchAdmobAccount ? (
                <label className="network-switch-wrap" title="Switch AdMob account (admin)">
                  <span className="sr-only">Active AdMob account</span>
                  <select
                    className="network-label network-switch"
                    value={viewAdmobAccountId || activeAdmobAccount?.id || ''}
                    onChange={(e) => switchAdmobAccount(e.target.value)}
                    aria-label="Switch AdMob account"
                  >
                    {admobAccounts.map((a) => (
                      <option key={a.id} value={a.id}>{admobAccountLabel(a)}</option>
                    ))}
                  </select>
                </label>
              ) : (
                <span className="network-label" title="AdMob account">
                  {admobAccountLabel(activeAdmobAccount) || publisherAccountLabel || 'AdMob'}
                </span>
              )
            )}
            {!focusMode && activeProduct === 'adsense' && (
              <span className="network-label" title="AdSense account">
                {publisherAccountLabel || 'AdSense'}
              </span>
            )}
            {!focusMode && (
              <span className="context-chip context-chip--sidebar" title={`${productMeta.fullLabel} · ${currencyCode} · ${APP_TIMEZONE}`}>
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
              {!focusMode && !authError && activeProduct === 'gam' && networkInfo
                && (networkInfo.gamLastSyncedAt || networkInfo.adsLastSyncedAt) && (
                <DataFreshness networkInfo={networkInfo} tzLabel={tzShort} compact className="live-dot-fresh" />
              )}
              {!focusMode && !authError && (activeProduct === 'admob' || activeProduct === 'adsense')
                && publisherSyncAt && (
                <span
                  className="data-freshness data-freshness--compact live-dot-fresh"
                  title={new Date(publisherSyncAt).toLocaleString()}
                >
                  Synced {relativeFreshness(publisherSyncAt) || '—'}
                </span>
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
                  viewClientId: viewClientId || user?.clientId || null,
                  accountNetworks,
                  switchNetwork,
                  switchingNetwork,
                  activeProduct,
                  viewAdmobAccountId: isAdmin ? (viewAdmobAccountId || null) : null,
                  admobAccounts,
                  switchAdmobAccount,
                  canSwitchAdmobAccount,
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
