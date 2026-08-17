import React, { useMemo, useState } from 'react';
import { useAPI } from '../hooks/useAPI';
import { inventoryAPI } from '../utils/api';
import PageHeader from './ui/PageHeader';
import TableSearchBar from './ui/TableSearchBar';
import { filterRowsBySearch } from '../utils/tableSearch';

function statusClass(status) {
  const key = String(status || '').toLowerCase();
  if (key === 'active') return 'status-badge status-badge--active';
  if (key === 'inactive') return 'status-badge status-badge--inactive';
  return 'status-badge status-badge--completed';
}

export default function Inventory() {
  const { data, loading, error, refetch } = useAPI(() => inventoryAPI.getAdUnits(), []);
  const [search, setSearch] = useState('');
  const units = data || [];
  const filtered = useMemo(
    () => filterRowsBySearch(units, search, (u) => [u.name, u.code, u.status, u.description]),
    [units, search]
  );
  const searching = Boolean(search.trim());

  return (
    <div className="orders-page inventory-page">
      <PageHeader
        title="Ad Inventory"
        subtitle="Ad units in this GAM network"
        summary={loading ? undefined : `${filtered.length} of ${units.length} units`}
      >
        <div className="page-controls">
          <TableSearchBar
            value={search}
            onChange={setSearch}
            placeholder="Search ad unit / code / status…"
          />
          <button className="btn-refresh" onClick={refetch}>↺ Refresh</button>
        </div>
      </PageHeader>

      {error && (
        <div className="error-box dash-error-box">
          <div className="dash-error-copy">
            <strong>Could not load inventory</strong>
            <span>{error}</span>
          </div>
          <button onClick={refetch} className="btn-retry">Retry</button>
        </div>
      )}

      {!loading && !error && filtered.length === 0 ? (
        <div className="dash-empty-state">
          <h3 className="dash-empty-title">
            {searching ? 'No matching ad units' : 'No ad units found'}
          </h3>
          <p className="dash-empty-desc">
            {searching
              ? 'Try a different name, code, or status.'
              : 'Ad units will appear here once they are available in GAM.'}
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table responsive-table inventory-table report-table--freeze-first">
            <thead>
              <tr>
                <th>Ad Unit Name</th>
                <th>Code</th>
                <th>Status</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 4 }).map((_, j) => (
                      <td key={j} data-label=""><div className="skeleton" style={{ height: 16 }} /></td>
                    ))}
                  </tr>
                ))
              ) : (
                filtered.map((u) => (
                  <tr key={u.id}>
                    <td className="td-name" data-label="Ad Unit Name">{u.name}</td>
                    <td data-label="Code"><code className="td-code">{u.code}</code></td>
                    <td data-label="Status">
                      <span className={statusClass(u.status)}>{u.status}</span>
                    </td>
                    <td data-label="Description" className="td-desc">{u.description || '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
