import { useMemo } from 'react';
import { useAuth } from '../store/useAuth';
import {
  buildClientVisibility,
  canAccessPage,
  getDefaultHomeRoute,
  hasAnyPageAccess,
  hasPermission,
  isAdmin,
} from '../utils/permissions';

export function usePermissions() {
  const { user } = useAuth();

  return useMemo(() => ({
    user,
    isAdmin: isAdmin(user),
    visibility: buildClientVisibility(user),
    has: (key) => hasPermission(user, key),
    canPage: (page) => canAccessPage(user, page),
    homeRoute: getDefaultHomeRoute(user),
    hasAnyPage: hasAnyPageAccess(user),
  }), [user]);
}
