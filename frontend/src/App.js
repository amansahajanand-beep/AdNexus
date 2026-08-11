import React, { useState, useEffect, useCallback } from 'react';
import { Routes, Route, useNavigate } from 'react-router-dom';
import SuccessModal from './components/ui/SuccessModal';
import Layout from './components/layout/Layout';
import Login from './pages/Login';
import Onboard from './pages/Onboard';
import Dashboard from './components/Dashboard';
import Reporting from './components/Reporting';
import Admin from './components/Admin';
import DomainUser from './components/DomainUser';
import ProtectedRoute from './components/routing/ProtectedRoute';
import AdminRoute from './components/routing/AdminRoute';
import PermissionRoute from './components/routing/PermissionRoute';
import HomeRedirect from './components/routing/HomeRedirect';
import PublicOnlyRoute from './components/routing/PublicOnlyRoute';
import { useAuth } from './store/useAuth';
import { useCrossTabAuthSync } from './hooks/useCrossTabAuthSync';
import {
  CROSS_TAB_ACCOUNT_SWITCH,
  CROSS_TAB_LOGOUT,
  CROSS_TAB_SESSION_REPLACED,
  isIntentionalLogout,
} from './utils/crossTabAuth';
import './App.css';

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

      {/* Authenticated app shell */}
      <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
        <Route index element={<HomeRedirect />} />
        <Route path="/dashboard" element={<PermissionRoute page="dashboard"><Dashboard /></PermissionRoute>} />
        <Route path="/reporting" element={<PermissionRoute page="reporting"><Reporting /></PermissionRoute>} />
        <Route path="/admin" element={<AdminRoute><Admin /></AdminRoute>} />
        <Route path="/domain-user" element={<PermissionRoute page="domain-user"><DomainUser /></PermissionRoute>} />
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
