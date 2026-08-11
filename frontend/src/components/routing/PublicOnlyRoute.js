import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../store/useAuth';

/**
 * For pages that should only be visible when logged OUT (e.g. /login).
 * Authenticated users are bounced to where they came from, or the dashboard.
 */
export default function PublicOnlyRoute({ children }) {
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <div className="app-boot"><div className="spinner" /></div>;
  }

  if (isAuthenticated) {
    const dest = location.state?.from?.pathname || '/dashboard';
    return <Navigate to={dest} replace />;
  }

  return children;
}
