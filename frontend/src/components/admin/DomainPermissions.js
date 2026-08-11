import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { SelectField } from '../ui/Field';
import Button from '../ui/Button';
import PermissionsPanel from './PermissionsPanel';
import { PERMISSION_SECTIONS } from '../../utils/permissions';
import { buildPermissionSaveSummary } from '../../utils/adminPermissionChanges';
import { PermissionSaveSummary } from './PermissionChangeSummary';
import SuccessModal from '../ui/SuccessModal';
import { readDateRestrictionFromUser, dateRestrictionPayload } from '../../utils/adminDateRestriction';

const ALL_PERM_ITEMS = [
  ...PERMISSION_SECTIONS.pages,
  ...PERMISSION_SECTIONS.actions,
  ...PERMISSION_SECTIONS.metrics,
];
const ALL_FLAG_KEYS = ALL_PERM_ITEMS.map((i) => i.key);

function flagsFromUser(user) {
  const f = {};
  ALL_FLAG_KEYS.forEach((k) => {
    const p = user?.permissions || {};
    f[k] = typeof p[k] === 'boolean' ? p[k] : true;
  });
  return f;
}

export default function DomainPermissions({
  users = [], usersLoading = false, domains = [], domainsLoading, catalogLoading = false,
  catalogRows = [], catalogLists = {},
  onSave, saving, error, onLoadDomains,
}) {
  const [userId, setUserId] = useState('');
  const [flags, setFlags] = useState({});
  const [allowedDomains, setAllowedDomains] = useState([]);
  const [allowedSites, setAllowedSites] = useState([]);
  const [allowedAppIds, setAllowedAppIds] = useState([]);
  const [dateRestrictionStart, setDateRestrictionStart] = useState('');
  const [dateRestrictionEnd, setDateRestrictionEnd] = useState('');
  const [successMsg, setSuccessMsg] = useState(null);

  const childUsers = useMemo(() => users.filter((u) => u.role !== 'admin'), [users]);
  const selectedUser = useMemo(() => childUsers.find((u) => u.id === userId) || null, [childUsers, userId]);

  useEffect(() => {
    if (userId) onLoadDomains?.();
  }, [userId, onLoadDomains]);

  useEffect(() => {
    if (!selectedUser) return;
    setFlags(flagsFromUser(selectedUser));
    setAllowedDomains(selectedUser.permissions?.allowedDomains || []);
    setAllowedSites(selectedUser.permissions?.allowedSites || []);
    setAllowedAppIds(selectedUser.permissions?.allowedAppIds || []);
    const dr = readDateRestrictionFromUser(selectedUser);
    setDateRestrictionStart(dr.start);
    setDateRestrictionEnd(dr.end);
  }, [selectedUser]);

  const userOptions = childUsers.map((u) => ({ value: u.id, label: u.username }));

  const handleSave = useCallback(async () => {
    if (!selectedUser) return;
    setSuccessMsg(null);
    try {
      const payload = {
        ...flags,
        allowedDomains,
        allowedSites,
        allowedAppIds,
        ...dateRestrictionPayload(dateRestrictionStart, dateRestrictionEnd),
      };
      const oldUser = selectedUser;
      await onSave(selectedUser.id, payload, selectedUser.username);
      setSuccessMsg(buildPermissionSaveSummary(oldUser.username, oldUser, payload));
    } catch (_) {}
  }, [selectedUser, flags, allowedDomains, allowedSites, allowedAppIds, dateRestrictionStart, dateRestrictionEnd, onSave]);

  return (
    <div className="admin-panel">
      <SuccessModal
        open={!!successMsg}
        icon="💾"
        title="Permissions Updated"
        onClose={() => setSuccessMsg(null)}
      >
        <PermissionSaveSummary
          username={successMsg?.username}
          added={successMsg?.added}
          removed={successMsg?.removed}
        />
      </SuccessModal>

      <h3 className="admin-panel-title">Assign Permissions</h3>
      <p className="form-note" style={{ marginBottom: 12 }}>
        Select a domain user and configure page access, metrics, actions, and data scope.
      </p>

      <div className="domain-perm-picker">
        <SelectField
          label="Select User"
          value={userId}
          onChange={setUserId}
          options={userOptions}
          placeholder="Select domain user…"
          loading={usersLoading}
        />
      </div>

      {error && <div className="login-error">{error}</div>}

      {selectedUser && (
        <div className="domain-perm-body">
          <PermissionsPanel
            flags={flags}
            onFlagChange={(key, checked) => setFlags((prev) => ({ ...prev, [key]: checked }))}
            allowedDomains={allowedDomains}
            onDomainsChange={setAllowedDomains}
            allowedSites={allowedSites}
            onSitesChange={setAllowedSites}
            allowedAppIds={allowedAppIds}
            onAppIdsChange={setAllowedAppIds}
            dateRestrictionStart={dateRestrictionStart}
            dateRestrictionEnd={dateRestrictionEnd}
            onDateRestrictionChange={(start, end) => {
              setDateRestrictionStart(start);
              setDateRestrictionEnd(end);
            }}
            domains={domains}
            domainsLoading={domainsLoading}
            catalogLoading={catalogLoading}
            catalogRows={catalogRows}
            catalogLists={catalogLists}
          />
          <div className="domain-perm-actions">
            <Button variant="primary" loading={saving} onClick={handleSave}>
              Save Permissions
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
