import React, { useState, useEffect, useCallback } from 'react';
import { ordersAPI } from '../utils/api';
import { getUserFacingMessage, logErrorForDebug } from '../utils/userFacingError';
import PageHeader from './ui/PageHeader';
import TableSearchBar from './ui/TableSearchBar';

function statusClass(status) {
  const key = String(status || '').toLowerCase();
  return `status-badge status-badge--${key || 'completed'}`;
}

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

  const [searchInput, setSearchInput] = useState('');
  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput); setPage(1); }, 400);
    return () => clearTimeout(t);
  }, [searchInput]);

  const empty = !loading && !error && orders.length === 0;
  const summary = pagination.total
    ? `${orders.length} of ${pagination.total} orders`
    : undefined;

  return (
    <div className="orders-page">
      <PageHeader
        title="Orders"
        subtitle="Line items and delivery status"
        summary={loading ? undefined : summary}
      >
        <div className="page-controls">
          <TableSearchBar
            value={searchInput}
            onChange={setSearchInput}
            placeholder="Search orders…"
          />
          <select
            className="filter-select"
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
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
      </PageHeader>

      {error && (
        <div className="error-box dash-error-box">
          <div className="dash-error-copy">
            <strong>Could not load orders</strong>
            <span>{error}</span>
          </div>
          <button onClick={load} className="btn-retry">Retry</button>
        </div>
      )}

      {empty ? (
        <div className="dash-empty-state">
          <h3 className="dash-empty-title">
            {search || statusFilter ? 'No matching orders' : 'No orders found'}
          </h3>
          <p className="dash-empty-desc">
            {search || statusFilter
              ? 'Clear search or status to see more orders.'
              : 'Orders will appear here once they are available in GAM.'}
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table responsive-table orders-table report-table--freeze-first">
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
              ) : (
                orders.map((order) => {
                  const budget = order.totalBudget
                    ? `₹${(parseInt(order.totalBudget, 10) / 1000000).toFixed(0)}`
                    : '—';
                  return (
                    <tr key={order.id}>
                      <td className="td-name" data-label="Order Name">{order.name}</td>
                      <td data-label="Advertiser">{order.advertiserName || '—'}</td>
                      <td data-label="Status">
                        <span className={statusClass(order.status)}>{order.status}</span>
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
      )}

      {!empty && (
        <div className="pagination">
          <span className="pag-info">
            {pagination.total ? `${orders.length} of ${pagination.total} orders` : ''}
          </span>
          <div className="pag-btns">
            <button
              className="pag-btn"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
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
              onClick={() => setPage((p) => p + 1)}
            >Next ›</button>
          </div>
        </div>
      )}
    </div>
  );
}
