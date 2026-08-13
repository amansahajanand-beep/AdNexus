import React, { useState, useEffect, useRef } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { networkAPI } from '../../utils/api';
import { useAuth } from '../../store/useAuth';
import { usePermissions } from '../../hooks/usePermissions';
import { NO_DOMAINS_MSG, NO_DOMAINS_TITLE, hasAssignedInventory } from '../../utils/permissions';
import BrandLogo from '../ui/BrandLogo';

const NAV_ITEMS = [
  { to: '/dashboard', label: 'Dashboard', page: 'dashboard' },
  { to: '/reporting', label: 'Reporting', page: 'reporting' },
  { to: '/admin', label: 'Admin', adminOnly: true },
  { to: '/domain-user', label: 'Domain User', page: 'domain-user' },
];

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
  const userRef = useRef(null);

  useEffect(() => {
    networkAPI.getInfo()
      .then(info => { setNetworkInfo(info); setIsMock(!!info.isMock); })
      .catch(() => setIsMock(true));
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
    if (!menuOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('sidebar-open');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('sidebar-open');
    };
  }, [menuOpen]);

  const handleLogout = () => {
    logout();
    setUserOpen(false);
    navigate('/login', { replace: true, state: { resetKey: Date.now() } });
  };
  const go = (to) => { navigate(to); setUserOpen(false); };
  const profileRoute = canPage('domain-user') ? '/domain-user' : (isAdmin ? '/admin' : null);
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
    <div className="app app-shell">
      {isMock && (
        <div className="mock-banner">
          Mock Mode — Showing sample data. To load real data, add your ad network credentials to <code>.env</code> and restart the backend.
        </div>
      )}

      {showVerWarn && (
        <div className={`version-banner ${verStatus === 'sunset' ? 'critical' : ''}`}>
          <span className="version-banner-text">{verMessage}</span>
          <button className="version-banner-close" onClick={() => setVerDismissed(true)} aria-label="Dismiss">✕</button>
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
      <aside className={`app-sidebar ${menuOpen ? 'open' : ''}`}>
        <div className="sidebar-top">
          <BrandLogo />
          {networkInfo && <span className="network-label">{networkInfo.displayName}</span>}
        </div>

        <nav className="sidebar-nav">
          {navItems.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `nav-btn ${isActive ? 'active' : ''}`}
              onClick={() => setMenuOpen(false)}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="live-dot header-live">
            <span className="dot-pulse" />
            {isMock ? 'Mock' : 'Live'}
          </div>
          <div className="user-menu" ref={userRef}>
            <button type="button" className="user-btn" onClick={() => setUserOpen(o => !o)}>
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
          <div className="live-dot header-live">
            <span className="dot-pulse" />
            {isMock ? 'Mock' : 'Live'}
          </div>
        </header>

        <main className="app-main">
          {noAccess ? (
            <div className="no-access-wrap">
              <div className="no-access-card">
                <div className="no-access-icon">!</div>
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
      </div>
      </div>
    </div>
  );
}
