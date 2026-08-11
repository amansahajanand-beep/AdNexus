import { useCallback } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { login as loginAction, logout as logoutAction } from './actions/authActions';

/**
 * Thin hook over the Redux auth slice. Keeps the same API the components used
 * before (user, loading, isAuthenticated, isAdmin, login, logout).
 */
export function useAuth() {
  const dispatch = useDispatch();
  const { user, loading, error } = useSelector((state) => state.auth);

  const login = useCallback((username, password) => dispatch(loginAction(username, password)), [dispatch]);
  const logout = useCallback(() => dispatch(logoutAction()), [dispatch]);

  return {
    user,
    loading,
    error,
    isAuthenticated: !!user,
    isAdmin: user?.role === 'admin',
    login,
    logout,
  };
}
