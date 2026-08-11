import React, { useState, useEffect } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import PermissionsPanel from './PermissionsPanel';
import { readDateRestrictionFromUser, dateRestrictionPayload } from '../../utils/adminDateRestriction';
import { PERMISSION_SECTIONS } from '../../utils/permissions';

const ALL_FLAG_KEYS = [
  ...PERMISSION_SECTIONS.pages,
  ...PERMISSION_SECTIONS.actions,
  ...PERMISSION_SECTIONS.metrics,
].map((i) => i.key);

function flagsFromUser(user) {
  const f = {};
  ALL_FLAG_KEYS.forEach((k) => {
    const p = user?.permissions || {};
    f[k] = typeof p[k] === 'boolean' ? p[k] : true;
  });
  return f;
}

export default function EditChannelsModal({
  open, onClose, onSave, saving, error, user,
  domains = [], domainsLoading, catalogLoading = false, catalogRows = [], catalogLists = {},
}) {
  const [flags, setFlags] = useState({});
  const [allowedDomains, setAllowedDomains] = useState([]);
  const [allowedSites, setAllowedSites] = useState([]);
  const [allowedAppIds, setAllowedAppIds] = useState([]);
  const [dateRestrictionStart, setDateRestrictionStart] = useState('');
  const [dateRestrictionEnd, setDateRestrictionEnd] = useState('');

  useEffect(() => {
    if (open && user) {
      setFlags(flagsFromUser(user));
      setAllowedDomains(user.permissions?.allowedDomains || []);
      setAllowedSites(user.permissions?.allowedSites || []);
      setAllowedAppIds(user.permissions?.allowedAppIds || []);
      const dr = readDateRestrictionFromUser(user);
      setDateRestrictionStart(dr.start);
      setDateRestrictionEnd(dr.end);
    }
  }, [open, user]);

  const isAdmin = user?.role === 'admin';

  const handleSave = async () => {
    const payload = {
      ...flags,
      allowedDomains,
      allowedSites,
      allowedAppIds,
      ...dateRestrictionPayload(dateRestrictionStart, dateRestrictionEnd),
    };
    await onSave(payload);
  };

  const footer = (
    <>
      <Button variant="secondary" onClick={onClose} disabled={saving}>Close</Button>
      <Button variant="primary" onClick={handleSave} loading={saving} disabled={isAdmin}>
        Save Permissions
      </Button>
    </>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Edit Permissions — ${user?.username || ''}`}
      footer={footer}
      width={720}
      className="ui-modal--user-form"
    >
      <div className="modal-user-line">User: <strong>{user?.username}</strong></div>
      {error && <div className="login-error">{error}</div>}
      {isAdmin ? (
        <div className="form-note">This is an admin user with full access to all domains.</div>
      ) : (
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
      )}
    </Modal>
  );
}
