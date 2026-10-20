import React from 'react';
import { ROI_CURRENCIES, useRoiDisplayCurrency } from '../../utils/report/roiCurrency';

/** Shows every ROI amount in the chosen currency (converted with the latest FX rate); default = the account currency. */
export default function RoiCurrencySelect() {
  const { code, setCode, ready } = useRoiDisplayCurrency();
  return (
    <label className="roi-currency-select" title="Show ROI amounts in another currency (converted at the latest exchange rate)">
      Currency
      <select value={code} onChange={(e) => setCode(e.target.value)}>
        {ROI_CURRENCIES.map(([c, name]) => (
          <option key={c || 'default'} value={c}>{c ? `${c} — ${name}` : name}</option>
        ))}
      </select>
      {code && !ready ? <span className="form-note">loading rates…</span> : null}
    </label>
  );
}
