import { createSlice } from '@reduxjs/toolkit';
import { AUTH_LOGOUT } from '../actions/authActions';

/**
 * Report page cache — persisted to sessionStorage via redux-persist (root whitelist).
 * Survives tab navigation and browser refresh (F5). Cleared on logout.
 */
const reportSlice = createSlice({
  name: 'reports',
  initialState: {
    dashboard: null,
    reporting: null,
  },
  reducers: {
    saveReportPage(state, action) {
      const { pageKey, payload } = action.payload;
      if (pageKey === 'dashboard' || pageKey === 'reporting') {
        state[pageKey] = payload ?? null;
      }
    },
    clearReportPages(state) {
      state.dashboard = null;
      state.reporting = null;
    },
  },
  extraReducers: (builder) => {
    builder.addCase(AUTH_LOGOUT, (state) => {
      state.dashboard = null;
      state.reporting = null;
    });
  },
});

export const { saveReportPage, clearReportPages } = reportSlice.actions;
export default reportSlice.reducer;
