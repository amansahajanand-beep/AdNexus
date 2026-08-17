import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../../store/useAuth';
import { getDefaultHomeRoute } from '../../utils/permissions';
import { resolveHomeRoute } from '../../utils/lastRoute';

/** Send authenticated users to last used page, else their first allowed page. */
export default function HomeRedirect() {
  const { user } = useAuth();
  return <Navigate to={resolveHomeRoute(user) || getDefaultHomeRoute(user)} replace />;
}
