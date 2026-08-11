import { useEffect } from 'react';
import { useDispatch } from 'react-redux';
import {
  TOKEN_KEY,
  userIdFromToken,
  markSessionSuperseded,
  clearSessionSuperseded,
  CROSS_TAB_ACCOUNT_SWITCH,
  CROSS_TAB_LOGOUT,
  dispatchCrossTabEvent,
  isIntentionalLogout,
} from '../utils/crossTabAuth';
import {
  authLogoutAction,
  loadUser,
} from '../store/actions/authActions';
import { purgePersistedState } from '../store/persistorRef';
import { clearRecentFilters } from '../utils/recentFilters';
import store from '../store/store';

/**
 * When another tab changes gam_token in localStorage, sync this tab:
 * - different user → local sign-out (keep shared token for the other tab)
 * - same user → refresh profile
 * - token cleared → sign out everywhere in UI
 */
export function useCrossTabAuthSync() {
  const dispatch = useDispatch();

  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== TOKEN_KEY) return;

      const newToken = e.newValue;
      const { user: currentUser } = store.getState().auth || {};

      if (!newToken) {
        clearSessionSuperseded();
        clearRecentFilters(currentUser?.id);
        dispatch(authLogoutAction());
        purgePersistedState();
        if (!isIntentionalLogout()) {
          dispatchCrossTabEvent(CROSS_TAB_LOGOUT);
        }
        return;
      }

      if (!currentUser) return;

      const newUserId = userIdFromToken(newToken);
      const currentUserId = currentUser.id;

      if (newUserId && currentUserId && newUserId !== currentUserId) {
        markSessionSuperseded();
        clearRecentFilters(currentUserId);
        dispatch(authLogoutAction());
        purgePersistedState();
        dispatchCrossTabEvent(CROSS_TAB_ACCOUNT_SWITCH);
        return;
      }

      if (newUserId && newUserId === currentUserId) {
        dispatch(loadUser());
      }
    };

    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [dispatch]);
}
