import React, { useState, useEffect, useCallback } from 'react';
import { Routes, Route, useNavigate, Navigate } from 'react-router-dom';
import SuccessModal from './components/ui/SuccessModal';
import Layout from './components/layout/Layout';
import Login from './pages/Login';
import Onboard from './pages/Onboard';
import Dashboard from './pages/Dashboard';
import Reporting from './pages/Reporting';
import Roi from './pages/Roi';
import RoiSheet from './pages/RoiSheet';
import Presets from './pages/Presets';
import Admin from './pages/Admin';
import TeamUsers from './pages/TeamUsers';
import UserManagerRoute from './components/routing/UserManagerRoute';
import DomainUser from './pages/DomainUser';
import MyAds from './pages/MyAds';
import AdInsights from './pages/AdInsights';
import AdsViewer from './pages/AdsViewer';
import MarketPulse from './pages/MarketPulse';
import AppBuildingLayout from './pages/appBuilding/AppBuildingLayout';
import Advertisers from './pages/appBuilding/Advertisers';
import WhatToBuild from './pages/appBuilding/WhatToBuild';
import MarketingIntel from './pages/appBuilding/MarketingIntel';
import UniversalSearch from './pages/appBuilding/UniversalSearch';
import BestApps from './pages/appBuilding/BestApps';
import Websites from './pages/appBuilding/Websites';
import OtherAssets from './pages/appBuilding/OtherAssets';
import CreativeExplorer from './pages/appBuilding/CreativeExplorer';
import MatchVideos from './pages/appBuilding/MatchVideos';
import AppLookup from './pages/appBuilding/AppLookup';
import AdCompare from './pages/appBuilding/AdCompare';
import Groups from './pages/appBuilding/Groups';
import Help from './pages/Help';
import GoogleSheets from './pages/GoogleSheets';
import AiReport from './pages/AiReport';
import AiForecast from './pages/AiForecast';
import PrivacyPolicy from './pages/PrivacyPolicy';
import TermsOfService from './pages/TermsOfService';
import About from './pages/About';
import AdMobDashboard from './pages/admob/AdMobDashboard';
import AdMobReporting from './pages/admob/AdMobReporting';
import AdMobRoi from './pages/admob/AdMobRoi';
import AdSenseDashboard from './pages/adsense/AdSenseDashboard';
import AdSenseReporting from './pages/adsense/AdSenseReporting';
import AdSenseRoi from './pages/adsense/AdSenseRoi';
import PublisherPresets from './pages/PublisherPresets';
import ProtectedRoute from './components/routing/ProtectedRoute';
import AdminRoute from './components/routing/AdminRoute';
import PermissionRoute from './components/routing/PermissionRoute';
import HomeRedirect from './components/routing/HomeRedirect';
import PublicOnlyRoute from './components/routing/PublicOnlyRoute';
import { useAuth } from './store/useAuth';
import { ADSENSE_ENABLED } from './utils/productWorkspace';
import { useCrossTabAuthSync } from './hooks/useCrossTabAuthSync';
import {
  CROSS_TAB_ACCOUNT_SWITCH,
  CROSS_TAB_LOGOUT,
  CROSS_TAB_SESSION_REPLACED,
  isIntentionalLogout,
} from './utils/crossTabAuth';
import './App.css';

/**
 * Public homepage. Logged-out visitors (and Google's OAuth verification crawler) see the About page,
 * which explains the app and links to Privacy / Terms. Signed-in users go straight to their dashboard.
 */
function RootEntry() {
  const { isAuthenticated, loading } = useAuth();
  if (loading) return <div className="app-boot"><div className="spinner" /></div>;
  return isAuthenticated ? <HomeRedirect /> : <About />;
}

/** Admins manage Google Ads in Admin; /my-ads is the domain-user page. */
function MyAdsEntry() {
  const { user } = useAuth();
  if (user?.role === 'admin') return <Navigate to="/admin?tab=ads" replace />;
  return <PermissionRoute page="my-ads"><MyAds /></PermissionRoute>;
}

function AppRoutes() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [showExpiredPopup, setShowExpiredPopup] = useState(false);
  const [supersededPopup, setSupersededPopup] = useState(null);

  useCrossTabAuthSync();

  useEffect(() => {
    const handler = () => {
      logout();
      setShowExpiredPopup(true);
    };
    window.addEventListener('session_expired', handler);
    return () => window.removeEventListener('session_expired', handler);
  }, [logout]);

  useEffect(() => {
    const handler = () => {
      if (isIntentionalLogout()) return;
      logout();
      setSupersededPopup(CROSS_TAB_SESSION_REPLACED);
    };
    window.addEventListener('session_replaced', handler);
    return () => window.removeEventListener('session_replaced', handler);
  }, [logout]);

  useEffect(() => {
    const handler = (e) => {
      const reason = e.detail?.reason;
      setSupersededPopup(reason || CROSS_TAB_ACCOUNT_SWITCH);
    };
    window.addEventListener('session_superseded', handler);
    return () => window.removeEventListener('session_superseded', handler);
  }, []);

  const handleClosePopup = useCallback(() => {
    setShowExpiredPopup(false);
    navigate('/login');
  }, [navigate]);

  const handleCloseSuperseded = useCallback(() => {
    setSupersededPopup(null);
    navigate('/login', { replace: true, state: { resetKey: Date.now() } });
  }, [navigate]);

  return (
    <>
      <SuccessModal
        open={showExpiredPopup}
        icon="🔒"
        iconBg="#fee2e2"
        title="Session Ended"
        onClose={handleClosePopup}
        btnLabel="Go to Login"
        btnColor="#ef4444"
      >
        Your session has expired after 7 days. Please sign in again.
      </SuccessModal>
      <SuccessModal
        open={!!supersededPopup}
        icon="👤"
        iconBg="#fef3c7"
        title={supersededPopup === CROSS_TAB_LOGOUT ? 'Signed Out' : 'Session Replaced'}
        onClose={handleCloseSuperseded}
        btnLabel="Go to Login"
        btnColor="#d97706"
      >
        {supersededPopup === CROSS_TAB_LOGOUT
          ? 'This account was signed out on another browser tab.'
          : supersededPopup === CROSS_TAB_SESSION_REPLACED
            ? 'This account signed in elsewhere (another device, browser, or tab). Please sign in again.'
            : 'Another account signed in on this browser in a different tab. You have been signed out of this tab.'}
      </SuccessModal>
      <Routes>
      {/* Public */}
      <Route path="/login" element={<PublicOnlyRoute><Login /></PublicOnlyRoute>} />
      <Route path="/onboard" element={<PublicOnlyRoute><Onboard /></PublicOnlyRoute>} />
      <Route path="/" element={<RootEntry />} />
      <Route path="/about" element={<About />} />
      <Route path="/privacy" element={<PrivacyPolicy />} />
      <Route path="/terms" element={<TermsOfService />} />

      {/* Authenticated app shell */}
      <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
        <Route path="/dashboard" element={<PermissionRoute page="dashboard"><Dashboard /></PermissionRoute>} />
        <Route path="/reporting" element={<PermissionRoute page="reporting"><Reporting /></PermissionRoute>} />
        <Route path="/roi" element={<PermissionRoute page="roi"><Roi /></PermissionRoute>} />
        <Route path="/roi/sheet/:sheetId" element={<PermissionRoute page="roi"><RoiSheet /></PermissionRoute>} />
        <Route path="/presets" element={<PermissionRoute page="presets"><Presets /></PermissionRoute>} />
        <Route path="/admin" element={<AdminRoute><Admin /></AdminRoute>} />
        <Route path="/team" element={<UserManagerRoute><TeamUsers /></UserManagerRoute>} />
        <Route path="/my-ads" element={<MyAdsEntry />} />
        <Route path="/app-building" element={<PermissionRoute page="ad-insights"><AppBuildingLayout /></PermissionRoute>}>
          <Route index element={<Navigate to="pulse" replace />} />
          <Route path="pulse" element={<MarketPulse />} />
          <Route path="build" element={<WhatToBuild />} />
          <Route path="viewer" element={<AdsViewer />} />
          <Route
            path="top-ads"
            element={<AdsViewer title="Top Ads" subtitle="Longest-running ads — advertisers keep paying for these, so they tend to be winners." preset={{ seen: "7d", minDays: "60", sort: "longest" }} />}
          />
          <Route path="intel" element={<MarketingIntel />} />
          <Route path="search" element={<UniversalSearch />} />
          <Route path="advertisers" element={<Advertisers />} />
          <Route path="best-apps" element={<BestApps />} />
          <Route path="websites" element={<Websites />} />
          <Route path="other-assets" element={<OtherAssets />} />
          <Route path="explorer" element={<CreativeExplorer />} />
          <Route path="match-videos" element={<MatchVideos />} />
          <Route path="lookup" element={<AppLookup />} />
          <Route path="compare" element={<AdCompare />} />
          <Route path="app-groups" element={<Groups kind="app" />} />
          <Route path="video-groups" element={<Groups kind="video" />} />
          <Route path="*" element={<Navigate to="pulse" replace />} />
        </Route>
        <Route path="/market-pulse" element={<Navigate to="/app-building/pulse" replace />} />
        <Route path="/ads-viewer" element={<Navigate to="/app-building/viewer" replace />} />
        <Route path="/ad-insights" element={<PermissionRoute page="ad-insights"><AdInsights /></PermissionRoute>} />
        <Route path="/domain-user" element={<PermissionRoute page="domain-user"><DomainUser /></PermissionRoute>} />
        <Route path="/help" element={<Help />} />
        <Route path="/google-sheets" element={<GoogleSheets />} />
        <Route path="/ai-report" element={<AdminRoute><AiReport /></AdminRoute>} />
        <Route path="/ai-forecast" element={<AdminRoute><AiForecast /></AdminRoute>} />

        <Route path="/admob" element={<PermissionRoute page="admob-dashboard"><Navigate to="/admob/dashboard" replace /></PermissionRoute>} />
        <Route path="/admob/dashboard" element={<PermissionRoute page="admob-dashboard"><AdMobDashboard /></PermissionRoute>} />
        <Route path="/admob/apps" element={<PermissionRoute page="admob-reporting"><Navigate to="/admob/reporting" replace /></PermissionRoute>} />
        <Route path="/admob/ad-units" element={<PermissionRoute page="admob-reporting"><Navigate to="/admob/reporting" replace /></PermissionRoute>} />
        <Route path="/admob/reporting" element={<PermissionRoute page="admob-reporting"><AdMobReporting /></PermissionRoute>} />
        <Route path="/admob/presets" element={<PublisherPresets product="admob" />} />
        <Route path="/admob/roi" element={<AdminRoute><AdMobRoi /></AdminRoute>} />

        {ADSENSE_ENABLED && (
          <>
            <Route path="/adsense" element={<PermissionRoute page="adsense-dashboard"><Navigate to="/adsense/dashboard" replace /></PermissionRoute>} />
            <Route path="/adsense/dashboard" element={<PermissionRoute page="adsense-dashboard"><AdSenseDashboard /></PermissionRoute>} />
            <Route path="/adsense/sites" element={<Navigate to="/adsense/dashboard" replace />} />
            <Route path="/adsense/ad-units" element={<Navigate to="/adsense/dashboard" replace />} />
            <Route path="/adsense/reporting" element={<PermissionRoute page="adsense-reporting"><AdSenseReporting /></PermissionRoute>} />
            <Route path="/adsense/roi" element={<AdminRoute><AdSenseRoi /></AdminRoute>} />
            <Route path="/adsense/presets" element={<PublisherPresets product="adsense" />} />
          </>
        )}
      </Route>

      {/* Fallback */}
      <Route path="*" element={<HomeRedirect />} />
    </Routes>
    </>
  );
}

export default function App() {
  return <AppRoutes />;
}
