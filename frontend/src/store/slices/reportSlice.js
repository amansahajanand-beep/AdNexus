import { createSlice } from '@reduxjs/toolkit';
import { AUTH_LOGOUT } from '../actions/authActions';

const PAGE_KEYS = new Set(['dashboard', 'reporting', 'roi']);

/**
 * Report page cache — persisted to sessionStorage via redux-persist (root whitelist).
 * Survives tab navigation and browser refresh (F5). Cleared on logout.
 */
const reportSlice = createSlice({
  name: 'reports',
  initialState: {
    dashboard: null,
    reporting: null,
    roi: null,
  },
  reducers: {
    saveReportPage(state, action) {
      const { pageKey, payload } = action.payload;
      if (PAGE_KEYS.has(pageKey)) {
        state[pageKey] = payload ?? null;
      }
    },
    clearReportPages(state) {
      state.dashboard = null;
      state.reporting = null;
      state.roi = null;
    },
  },
  extraReducers: (builder) => {
    builder.addCase(AUTH_LOGOUT, (state) => {
      state.dashboard = null;
      state.reporting = null;
      state.roi = null;
    });
  },
});

export const { saveReportPage, clearReportPages } = reportSlice.actions;
export default reportSlice.reducer;
