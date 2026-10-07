import { useCallback, useEffect, useState } from 'react';
import { useDispatch } from 'react-redux';
import { reportsAPI } from '../utils/api';
import { getReportTz, setReportTz, subscribeReportTz } from '../utils/reportTimezone';
import { setActiveTimezone } from '../utils/datetime';
import { saveReportPage } from '../store/slices/reportSlice';

const POLL_MS = 60000;
const EMPTY = { networkTz: '', options: [], hourlyFrom: null, stale: false };

/**
 * The timezone the user is viewing Google Ad Manager in, for any page that shows it (Dashboard, Reporting, Presets).
 *
 *   tz         the chosen zone ('' = the network's own)
 *   options    { networkTz, options[], hourlyFrom, stale } for the switcher
 *   change(id) picks a zone (everywhere at once) and clears the saved page filters, because their dates were
 *              worked out in the old zone
 *
 * While a page uses this, "today" and the date presets are worked out in the zone being viewed.
 */
export default function useReportTimezone() {
  const dispatch = useDispatch();
  const [tz, setTz] = useState(getReportTz);
  const [options, setOptions] = useState(EMPTY);

  useEffect(() => subscribeReportTz(setTz), []);

  useEffect(() => {
    let cancelled = false;
    const load = () => reportsAPI.getTimezones(tz)
      .then((res) => { if (!cancelled && res) setOptions({ ...EMPTY, ...res }); })
      .catch(() => {});
    load();
    // While another zone is picked, keep checking whether the newest hours have arrived.
    const timer = tz ? setInterval(load, POLL_MS) : null;
    return () => { cancelled = true; if (timer) clearInterval(timer); };
  }, [tz]);

  // Set while rendering so the page's first requests already use the right "today".
  setActiveTimezone(tz || options.networkTz || '');
  useEffect(() => () => setActiveTimezone(''), []);

  const change = useCallback((next) => {
    const value = next === options.networkTz ? '' : next;
    dispatch(saveReportPage({ pageKey: 'dashboard', payload: null }));
    dispatch(saveReportPage({ pageKey: 'reporting', payload: null }));
    setReportTz(value);
  }, [dispatch, options.networkTz]);

  return { tz, options, change };
}
