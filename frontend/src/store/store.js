import { configureStore } from '@reduxjs/toolkit';

import {

  persistStore,

  persistReducer,

  FLUSH,

  REHYDRATE,

  PAUSE,

  PERSIST,

  PURGE,

  REGISTER,

} from 'redux-persist';

import storage from 'redux-persist/lib/storage/session';

import rootReducer from './reducers';
import { registerPersistor } from './persistorRef';



const persistConfig = {

  key: 'gam_dashboard',

  storage,

  whitelist: ['reports'],

};



const persistedReducer = persistReducer(persistConfig, rootReducer);



const store = configureStore({

  reducer: persistedReducer,

  middleware: (getDefaultMiddleware) =>

    getDefaultMiddleware({

      serializableCheck: {

        ignoredActions: [FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER],

      },

    }),

});



const persistor = persistStore(store);
registerPersistor(persistor);

export { persistor };
export default store;


