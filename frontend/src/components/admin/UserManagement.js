import React, { useMemo, useState } from 'react';
import Button from '../ui/Button';
import TableSearchBar from '../ui/TableSearchBar';
import { filterRowsBySearch } from '../../utils/tableSearch';
import UserFormModal from './UserFormModal';
import EditChannelsModal from './EditChannelsModal';
import { permissionBadgeList } from '../../utils/permissions';
import {
  buildPermissionSaveSummary,
  buildUserEditSummary,
  buildNewUserInventorySummary,
} from '../../utils/adminPermissionChanges';
import { PermissionSaveSummary, UserEditChangeSummary } from './PermissionChangeSummary';
import SuccessModal from '../ui/SuccessModal';
import { getUserFacingMessage, logErrorForDebug } from '../../utils/userFacingError';

/**
 * User List table with Add / Edit / Edit-Channels / Delete actions.
 * Persistence is delegated to parent callbacks (each returns a promise).
 *
 * Props:
 *   users, loading, error
 *   domains, domainsLoading
 *   onCreate(payload), onUpdate(id, payload), onSavePermissions(id, allowedDomains), onDelete(id)
 *   currentUserId
 */
export default function UserManagement({
  users = [], loading, error,
  domains = [], domainsLoading, catalogLoading = false, catalogRows = [], catalogLists = {},
  onCreate, onUpdate, onSavePermissions, onDelete,
  currentUserId,
  onLoadDomains,
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [channelsUser, setChannelsUser] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);
  const [search, setSearch] = useState('');
  const [successMsg, setSuccessMsg] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const showSuccess = (msg) => setSuccessMsg(msg);

  const filteredUsers = useMemo(
    () => filterRowsBySearch(users, search, (u) => [
      u.username, u.role, u.id,
      ...(u.permissions?.allowedDomains || []),
      ...(u.permissions?.allowedSites || []),
      ...(u.permissions?.allowedAppIds || []),
    ]),
    [users, search]
  );

  const domainLabelMap = useMemo(() => {
    const map = new Map();
    domains.forEach((d) => {
      map.set(d.id, d.label);
      if (d.domainName) map.set(d.domainName, d.label);
      if (d.appId) map.set(d.appId, d.label);
    });
    return map;
  }, [domains]);

  const formatUserScope = (user) => {
    if (user.role === 'admin') return 'All';
    const p = user.permissions || {};
    const parts = [];
    const domainsList = p.allowedDomains || [];
    const sitesList = p.allowedSites || [];
    const appsList = p.allowedAppIds || [];
    if (domainsList.length) {
      const labels = domainsList.map((id) => domainLabelMap.get(id) || id);
      parts.push(labels.length <= 2 ? labels.join(', ') : `${labels.slice(0, 2).join(', ')} +${labels.length - 2}`);
    }
    if (sitesList.length) parts.push(`${sitesList.length} site${sitesList.length === 1 ? '' : 's'}`);
    if (appsList.length) parts.push(`${appsList.length} app${appsList.length === 1 ? '' : 's'}`);
    return parts.length ? parts.join(' · ') : '—';
  };

  // Refresh domain list only when it's empty (first open or after an error).
  const openAdd = () => { if (!domains.length) onLoadDomains?.(); setEditingUser(null); setFormError(null); setFormOpen(true); };
  const openEdit = (u) => { if (!domains.length) onLoadDomains?.(); setEditingUser(u); setFormError(null); setFormOpen(true); };
  const openChannels = (u) => { if (!domains.length) onLoadDomains?.(); setChannelsUser(u); setFormError(null); };

  const handleSaveForm = async (payload) => {
    setSaving(true);
    setFormError(null);
    try {
      if (editingUser) {
        const oldUser = editingUser;
        await onUpdate(editingUser.id, payload);
        setFormOpen(false);
        setEditingUser(null);
        showSuccess({ type: 'edit', ...buildUserEditSummary(oldUser, payload) });
      } else {
        await onCreate(payload);
        setFormOpen(false);
        const changes = payload.role !== 'admin' ? buildNewUserInventorySummary(payload) : [];
        showSuccess({ type: 'add', username: payload.username, changes });
      }
    } catch (err) {
      logErrorForDebug(err, 'UserManagement save');
      setFormError(getUserFacingMessage(err, 'Could not save user. Please try again.'));
      setSaving(false);
      throw err;
    }
    setSaving(false);
  };

  const handleSaveChannels = async (payload) => {
    setSaving(true);
    setFormError(null);
    const username = channelsUser?.username;
    try {
      await onSavePermissions(channelsUser.id, payload);
      const oldUser = channelsUser;
      setChannelsUser(null);
      showSuccess(buildPermissionSaveSummary(username, oldUser, payload));
    } catch (err) {
      logErrorForDebug(err, 'UserManagement channels');
      setFormError(getUserFacingMessage(err, 'Could not save permissions. Please try again.'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (u) => {
    if (!window.confirm(`Delete user "${u.username}"?`)) return;
    try {
      await onDelete(u.id);
    } catch (err) {
      logErrorForDebug(err, 'UserManagement delete');
      window.alert(getUserFacingMessage(err, 'Could not delete user. Please try again.'));
    }
  };

  return (
    <div className="admin-panel">
      <SuccessModal
        open={!!successMsg}
        icon="💾"
        title={
          successMsg?.type === 'add' ? 'User Created' :
          successMsg?.type === 'edit' ? 'User Updated' :
          'Permissions Updated'
        }
        onClose={() => setSuccessMsg(null)}
      >
        {successMsg?.type === 'add' && (
          <PermissionSaveSummary
            username={successMsg.username}
            added={(successMsg.changes || []).map((c) => c.text)}
          />
        )}
        {successMsg?.type === 'edit' && (
          <UserEditChangeSummary
            username={successMsg.username}
            changes={successMsg.changes}
          />
        )}
        {!successMsg?.type && (
          <PermissionSaveSummary
            username={successMsg?.username}
            added={successMsg?.added}
            removed={successMsg?.removed}
          />
        )}
      </SuccessModal>
      <div className="admin-panel-head">
        <h3 className="admin-panel-title">User List</h3>
        <div className="admin-panel-actions">
          <TableSearchBar
            value={search}
            onChange={setSearch}
            placeholder="Search user / role…"
          />
          <Button variant="primary" icon={<span>＋</span>} onClick={openAdd}>Add User</Button>
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}

      <div className="table-wrap">
        <table className="data-table responsive-table admin-table">
          <thead>
            <tr>
              <th>ID No.</th>
              <th>User Name</th>
              <th>Role</th>
              <th>Permissions</th>
              <th>Domains</th>
              <th style={{ textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>{Array.from({ length: 6 }).map((_, j) => (
                  <td key={j} data-label=""><div className="skeleton" style={{ height: 16 }} /></td>
                ))}</tr>
              ))
            ) : filteredUsers.length === 0 ? (
              <tr><td colSpan="6" style={{ textAlign: 'center', color: '#888', padding: 30 }}>
                {search.trim() ? 'No users match your search' : 'No users'}
              </td></tr>
            ) : filteredUsers.map((u, i) => (
              <tr key={u.id}>
                <td className="td-mono" data-label="ID No.">{String(i + 1).padStart(2, '0')}</td>
                <td className="td-name" data-label="User Name">{u.username}</td>
                <td data-label="Role">
                  <span className={`role-badge ${u.role === 'admin' ? 'admin' : 'child'}`}>
                    {u.role === 'admin' ? 'Admin' : 'Domain User'}
                  </span>
                </td>
                <td data-label="Permissions">
                  <div className="perm-badge-row">
                    {permissionBadgeList(u).map((b) => (
                      <span key={b.label} className={`perm-badge perm-badge-${b.type}`}>{b.label}</span>
                    ))}
                  </div>
                </td>
                <td data-label="Scope" className="td-domains">{formatUserScope(u)}</td>
                <td data-label="Actions">
                  <div className="row-actions">
                    <button className="link-action" onClick={() => openEdit(u)}>✎ Edit User</button>
                    <button className="link-action" onClick={() => openChannels(u)}>≣ Edit Channels</button>
                    <button
                      className="link-action danger"
                      onClick={() => handleDelete(u)}
                      disabled={u.id === currentUserId}
                      title={u.id === currentUserId ? 'You cannot delete yourself' : 'Delete user'}
                    >🗑 Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <UserFormModal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSave={handleSaveForm}
        saving={saving}
        error={formError}
        user={editingUser}
        domains={domains}
        domainsLoading={domainsLoading}
        catalogLoading={catalogLoading}
        catalogRows={catalogRows}
        catalogLists={catalogLists}
      />

      <EditChannelsModal
        open={!!channelsUser}
        onClose={() => setChannelsUser(null)}
        onSave={handleSaveChannels}
        saving={saving}
        error={formError}
        user={channelsUser}
        domains={domains}
        domainsLoading={domainsLoading}
        catalogLoading={catalogLoading}
        catalogRows={catalogRows}
        catalogLists={catalogLists}
      />
    </div>
  );
}
