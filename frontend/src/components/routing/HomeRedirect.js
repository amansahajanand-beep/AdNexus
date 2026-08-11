import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../../store/useAuth';
import { getDefaultHomeRoute } from '../../utils/permissions';

/** Send authenticated users to their first allowed page. */
export default function HomeRedirect() {
  const { user } = useAuth();
  return <Navigate to={getDefaultHomeRoute(user)} replace />;
}
