import { sessionAPI, setToken, getToken } from '../../utils/api';
import {
  clearSessionSuperseded,
  isSessionSuperseded,
  beginIntentionalLogout,
  endIntentionalLogout,
  clearIntentionalLogout,
  userIdFromToken,
} from '../../utils/crossTabAuth';
import { purgePersistedState } from '../persistorRef';
import { clearReportPages } from '../slices/reportSlice';
import { getUserFacingMessage, logErrorForDebug } from '../../utils/userFacingError';
import { clearRecentFilters } from '../../utils/recentFilters';

// ─── Action types ───────────────────────────────────────────────────────────
export const AUTH_LOADING = 'auth/LOADING';
export const AUTH_SUCCESS = 'auth/SUCCESS';
export const AUTH_FAILURE = 'auth/FAILURE';
export const AUTH_LOGOUT = 'auth/LOGOUT';

// ─── Plain action creators ────────────────────────────────────────────────────
export const authLoading = () => ({ type: AUTH_LOADING });
export const authSuccess = (user) => ({ type: AUTH_SUCCESS, payload: user });
export const authFailure = (error) => ({ type: AUTH_FAILURE, payload: error });
export const authLogoutAction = () => ({ type: AUTH_LOGOUT });

// ─── Thunks (async) ───────────────────────────────────────────────────────────

// Restore the session from a stored token (called once on app start).
export const loadUser = () => async (dispatch) => {
  if (isSessionSuperseded()) {
    dispatch(authFailure(null));
    return;
  }
  if (!getToken()) {
    dispatch(authFailure(null));
    return;
  }
  dispatch(authLoading());
  try {
    const user = await sessionAPI.me();
    dispatch(authSuccess(user));
  } catch {
    clearRecentFilters();
    setToken(null);
    dispatch(authFailure(null));
  }
};

// Log in with username/password. Returns the user (or throws for the caller).
export const login = (username, password) => async (dispatch) => {
  dispatch(authLoading());
  try {
    const { token, user } = await sessionAPI.login(username, password);
    clearSessionSuperseded();
    clearIntentionalLogout();
    setToken(token);
    dispatch(clearReportPages());
    dispatch(authSuccess(user));
    return user;
  } catch (err) {
    logErrorForDebug(err, 'Auth login');
    const msg = getUserFacingMessage(err, 'Invalid username or password. Please try again.');
    dispatch(authFailure(msg));
    throw err;
  }
};

// Log out, invalidate server session, and clear local state.
export const logout = () => async (dispatch) => {
  beginIntentionalLogout();
  clearSessionSuperseded();
  try {
    if (getToken()) await sessionAPI.logout();
  } catch {
    // Token may already be invalid; still clear client state.
  }
  const userId = (() => {
    try {
      return userIdFromToken(getToken());
    } catch {
      return null;
    }
  })();
  clearRecentFilters(userId);
  setToken(null);
  dispatch(authLogoutAction());
  purgePersistedState();
  endIntentionalLogout();
};
