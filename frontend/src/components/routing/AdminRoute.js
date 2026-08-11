import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../../store/useAuth';

/**
 * Role guard: only admins may pass. Non-admins are redirected to the dashboard.
 * Assumes it is rendered inside a ProtectedRoute (user already authenticated).
 */
export default function AdminRoute({ children }) {
  const { isAdmin } = useAuth();
  if (!isAdmin) return <Navigate to="/dashboard" replace />;
  return children;
}
