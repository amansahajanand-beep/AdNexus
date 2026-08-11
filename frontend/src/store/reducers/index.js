import { combineReducers } from '@reduxjs/toolkit';
import authReducer from './authReducer';
import reportReducer from '../slices/reportSlice';

const rootReducer = combineReducers({
  auth: authReducer,
  reports: reportReducer,
});

export default rootReducer;
