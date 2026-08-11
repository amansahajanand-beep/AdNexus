import React from 'react';
import { Navigate } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';
import AccessRestricted from '../ui/AccessRestricted';

/**
 * Page-level permission guard for domain users.
 * Admins always pass. Missing page access shows AccessRestricted or redirects home.
 */
export default function PermissionRoute({ page, children }) {
  const { canPage, homeRoute, hasAnyPage } = usePermissions();

  if (!canPage(page)) {
    if (!hasAnyPage) {
      return (
        <AccessRestricted message="You don't have permission to access any pages. Please contact your administrator." />
      );
    }
    return <Navigate to={homeRoute} replace />;
  }

  return children;
}
