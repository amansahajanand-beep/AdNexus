import { AUTH_LOADING, AUTH_SUCCESS, AUTH_FAILURE, AUTH_LOGOUT } from '../actions/authActions';
import { getToken } from '../../utils/api';
import { isSessionSuperseded } from '../../utils/crossTabAuth';

// If a token exists on boot we start in a loading state while we verify it.
const initialState = {
  user: null,
  loading: !!getToken() && !isSessionSuperseded(),
  error: null,
};

export default function authReducer(state = initialState, action) {
  switch (action.type) {
    case AUTH_LOADING:
      return { ...state, loading: true, error: null };
    case AUTH_SUCCESS:
      return { ...state, loading: false, error: null, user: action.payload };
    case AUTH_FAILURE:
      return { ...state, loading: false, user: null, error: action.payload || null };
    case AUTH_LOGOUT:
      return { ...state, loading: false, user: null, error: null };
    default:
      return state;
  }
}
