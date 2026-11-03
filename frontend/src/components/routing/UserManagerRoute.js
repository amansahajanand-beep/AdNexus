import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../../store/useAuth';
import { canManageUsers } from '../../utils/permissions';

/** Sub-admin guard: only domain users granted "manage users" may pass. */
export default function UserManagerRoute({ children }) {
  const { user } = useAuth();
  if (!canManageUsers(user)) return <Navigate to="/dashboard" replace />;
  return children;
}
