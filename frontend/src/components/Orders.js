import React, { useState, useEffect, useCallback } from 'react';
import { ordersAPI } from '../utils/api';
import { getUserFacingMessage, logErrorForDebug } from '../utils/userFacingError';

const STATUS_COLORS = {
  DELIVERING: { bg: '#e6f4ea', color: '#137333' },
  READY: { bg: '#e8f0fe', color: '#1a73e8' },
  PAUSED: { bg: '#fef7e0', color: '#945300' },
  COMPLETED: { bg: '#f1f3f4', color: '#5f6368' },
  CANCELED: { bg: '#fce8e6', color: '#c5221f' },
  DRAFT: { bg: '#f3e8fd', color: '#7b1fa2' },
};

export default function Orders() {
  const [orders, setOrders] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, pages: 1, total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await ordersAPI.getAll({ page, limit: 10, search, status: statusFilter });
      setOrders(data.orders || []);
      setPagination(data.pagination || {});
    } catch (err) {
      logErrorForDebug(err, 'Orders');
      setError(getUserFacingMessage(err, 'Could not load orders. Please try again.'));
    } finally {
      setLoading(false);
    }
  }, [page, search, statusFilter]);

  useEffect(() => { load(); }, [load]);

  // Debounce search
  const [searchInput, setSearchInput] = useState('');
  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput); setPage(1); }, 400);
    return () => clearTimeout(t);
  }, [searchInput]);

  const statusStyle = (s) => STATUS_COLORS[s] || { bg: '#f1f3f4', color: '#5f6368' };

  return (
    <div className="orders-page">
      <div className="page-header">
        <h2 className="page-title">Orders</h2>
        <div className="page-controls">
          <TableSearchBar
            value={searchInput}
            onChange={setSearchInput}
            placeholder="Search orders…"
          />
          <select
            className="filter-select"
            value={statusFilter}
            onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
          >
            <option value="">All Status</option>
            <option value="DELIVERING">Delivering</option>
            <option value="READY">Ready</option>
            <option value="PAUSED">Paused</option>
            <option value="COMPLETED">Completed</option>
            <option value="CANCELED">Canceled</option>
            <option value="DRAFT">Draft</option>
          </select>
          <button className="btn-refresh" onClick={load} title="Refresh">↺ Refresh</button>
        </div>
      </div>

      {error && (
        <div className="error-box">
          ⚠️ {error}
          <button onClick={load} className="btn-retry">Retry</button>
        </div>
      )}

      <div className="table-wrap">
        <table className="data-table responsive-table orders-table">
          <thead>
            <tr>
              <th>Order Name</th>
              <th>Advertiser</th>
              <th>Status</th>
              <th>Start Date</th>
              <th>End Date</th>
              <th>Budget</th>
              <th>External ID</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: 7 }).map((_, j) => (
                    <td key={j} data-label=""><div className="skeleton" style={{ height: 16 }} /></td>
                  ))}
                </tr>
              ))
            ) : orders.length === 0 ? (
              <tr><td colSpan="7" style={{ textAlign: 'center', color: '#888', padding: 40 }}>
                No orders found
              </td></tr>
            ) : (
              orders.map(order => {
                const ss = statusStyle(order.status);
                const budget = order.totalBudget
                  ? `₹${(parseInt(order.totalBudget) / 1000000).toFixed(0)}`
                  : '—';
                return (
                  <tr key={order.id}>
                    <td className="td-name" data-label="Order Name">{order.name}</td>
                    <td data-label="Advertiser">{order.advertiserName || '—'}</td>
                    <td data-label="Status">
                      <span className="status-badge" style={{ background: ss.bg, color: ss.color }}>
                        {order.status}
                      </span>
                    </td>
                    <td data-label="Start Date">{order.startDate?.slice(0, 10) || '—'}</td>
                    <td data-label="End Date">{order.endDate?.slice(0, 10) || '—'}</td>
                    <td data-label="Budget">{budget}</td>
                    <td data-label="External ID">{order.externalId || '—'}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="pagination">
        <span className="pag-info">
          {pagination.total ? `${orders.length} of ${pagination.total} orders` : ''}
        </span>
        <div className="pag-btns">
          <button
            className="pag-btn"
            disabled={page <= 1}
            onClick={() => setPage(p => p - 1)}
          >‹ Prev</button>
          {Array.from({ length: Math.min(pagination.pages || 1, 5) }).map((_, i) => {
            const p = i + 1;
            return (
              <button
                key={p}
                className={`pag-btn ${page === p ? 'active' : ''}`}
                onClick={() => setPage(p)}
              >{p}</button>
            );
          })}
          <button
            className="pag-btn"
            disabled={page >= (pagination.pages || 1)}
            onClick={() => setPage(p => p + 1)}
          >Next ›</button>
        </div>
      </div>
    </div>
  );
}
