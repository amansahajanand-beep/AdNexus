import React, { useMemo, useState } from 'react';
import { useAPI } from '../hooks/useAPI';
import { inventoryAPI } from '../utils/api';
import TableSearchBar from './ui/TableSearchBar';
import { filterRowsBySearch } from '../utils/tableSearch';

export default function Inventory() {
  const { data, loading, error, refetch } = useAPI(() => inventoryAPI.getAdUnits(), []);
  const [search, setSearch] = useState('');
  const units = data || [];
  const filtered = useMemo(
    () => filterRowsBySearch(units, search, (u) => [u.name, u.code, u.status, u.description]),
    [units, search]
  );

  return (
    <div className="orders-page">
      <div className="page-header">
        <h2 className="page-title">Ad Inventory</h2>
        <div className="page-controls">
          <TableSearchBar
            value={search}
            onChange={setSearch}
            placeholder="Search ad unit / code / status…"
          />
          <button className="btn-refresh" onClick={refetch}>↺ Refresh</button>
        </div>
      </div>

      {error && (
        <div className="error-box">⚠️ {error} <button onClick={refetch} className="btn-retry">Retry</button></div>
      )}

      <div className="table-wrap">
        <table className="data-table responsive-table inventory-table">
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
            ) : filtered.length === 0 ? (
              <tr><td colSpan="4" style={{ textAlign: 'center', color: '#888', padding: 40 }}>
                {search.trim() ? 'No ad units match your search' : 'No ad units found'}
              </td></tr>
            ) : (
              filtered.map(u => (
                <tr key={u.id}>
                  <td className="td-name" data-label="Ad Unit Name">{u.name}</td>
                  <td data-label="Code"><code className="td-code">{u.code}</code></td>
                  <td data-label="Status">
                    <span className="status-badge" style={{
                      background: u.status === 'ACTIVE' ? '#e6f4ea' : '#f1f3f4',
                      color: u.status === 'ACTIVE' ? '#137333' : '#5f6368'
                    }}>
                      {u.status}
                    </span>
                  </td>
                  <td data-label="Description" className="td-desc">{u.description || '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
