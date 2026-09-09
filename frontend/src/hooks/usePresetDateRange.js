import { useEffect, useMemo, useState } from 'react';
import { DATE_PRESETS } from '../utils/gamReportCatalog';
import {
  allowedDatePresets,
  clampDateRange,
  clampDateValue,
  clampPresetRange,
  defaultReportRangeForUser,
  getDateRestriction,
  isCustomRangeIncomplete,
  isFixedDateRestriction,
} from '../utils/dateRestriction';

/**
 * Local date state for Presets page — filters come from saved preset; dates are chosen here.
 */
export function usePresetDateRange(user, presetItemId) {
  const dateRestriction = useMemo(() => getDateRestriction(user), [user]);
  const todayInit = useMemo(() => defaultReportRangeForUser(user), [user]);

  const [preset, setPreset] = useState('today');
  const [startDate, setStartDate] = useState(todayInit.startDate);
  const [endDate, setEndDate] = useState(todayInit.endDate);
  const [applied, setApplied] = useState({
    startDate: todayInit.startDate,
    endDate: todayInit.endDate,
  });

  useEffect(() => {
    const init = defaultReportRangeForUser(user);
    setPreset('today');
    setStartDate(init.startDate);
    setEndDate(init.endDate);
    setApplied({ startDate: init.startDate, endDate: init.endDate });
  }, [presetItemId, user?.id, todayInit.startDate, todayInit.endDate]);

  const presetOptions = useMemo(
    () => (isFixedDateRestriction(dateRestriction)
      ? []
      : allowedDatePresets(dateRestriction, DATE_PRESETS)),
    [dateRestriction]
  );

  const presetLabel = useMemo(
    () => DATE_PRESETS.find((p) => p.id === preset)?.label || 'Custom',
    [preset]
  );

  const customDatesIncomplete = isCustomRangeIncomplete(preset, startDate, endDate);
  const dateFilterLocked = Boolean(isFixedDateRestriction(dateRestriction));

  const applyDates = (nextPreset = preset, sd = startDate, ed = endDate) => {
    const r = nextPreset !== 'custom'
      ? clampPresetRange(nextPreset, dateRestriction)
      : clampDateRange(sd, ed, dateRestriction);
    if (!r?.startDate || !r?.endDate) return;
    setPreset(nextPreset);
    setStartDate(r.startDate);
    setEndDate(r.endDate);
    setApplied(r);
  };

  const onPreset = (p) => {
    if (dateFilterLocked) return;
    if (p !== 'custom') {
      applyDates(p);
      return;
    }
    setPreset('custom');
  };

  return {
    preset,
    startDate,
    endDate,
    applied,
    dateRestriction,
    dateFilterLocked,
    presetOptions,
    presetLabel,
    customDatesIncomplete,
    onPreset,
    applyDates: () => applyDates('custom', startDate, endDate),
    setStartDate: (v) => setStartDate(clampDateValue(v, dateRestriction)),
    setEndDate: (v) => setEndDate(clampDateValue(v, dateRestriction)),
  };
}
