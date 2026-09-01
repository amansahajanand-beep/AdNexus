import React, { useState, useEffect, useMemo, useRef } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { TextField, SelectField } from '../ui/Field';
import PermissionsPanel from './PermissionsPanel';
import { validatePassword, PASSWORD_RULES_HINT } from '../../utils/passwordPolicy';
import { validateUsername, USERNAME_RULES_HINT } from '../../utils/namePolicy';
import { readDateRestrictionFromUser, dateRestrictionPayload } from '../../utils/adminDateRestriction';
import { PERMISSION_SECTIONS } from '../../utils/permissions';

const ROLE_OPTIONS = [
  { value: 'admin', label: 'Admin' },
  { value: 'child', label: 'Domain User' },
];

function isAdminRole(user) {
  if (!user) return false;
  const role = String(user.role || '').toLowerCase();
  if (role === 'admin') return true;
  if (role === 'child') return false;
  return user.permissions == null;
}

const ALL_FLAG_KEYS = [
  ...PERMISSION_SECTIONS.pages,
  ...PERMISSION_SECTIONS.actions,
  ...PERMISSION_SECTIONS.metrics,
].map((i) => i.key);

function defaultFlags() {
  const f = {};
  ALL_FLAG_KEYS.forEach((k) => { f[k] = true; });
  return f;
}

function flagsFromUser(user) {
  const f = defaultFlags();
  const p = user?.permissions || {};
  ALL_FLAG_KEYS.forEach((k) => {
    if (typeof p[k] === 'boolean') f[k] = p[k];
  });
  return f;
}

export default function UserFormModal({
  open, onClose, onSave, saving, error, user,
  domains = [], domainsLoading, catalogLoading = false, catalogRows = [], catalogLists = {},
}) {
  const isEdit = !!user;
  const editingAdmin = isEdit && isAdminRole(user);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [role, setRole] = useState('child');
  const [flags, setFlags] = useState(defaultFlags);
  const [allowedDomains, setAllowedDomains] = useState([]);
  const [allowedSites, setAllowedSites] = useState([]);
  const [allowedAppIds, setAllowedAppIds] = useState([]);
  const [dateRestrictionStart, setDateRestrictionStart] = useState('');
  const [dateRestrictionEnd, setDateRestrictionEnd] = useState('');
  const [localError, setLocalError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);
  const errorRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setUsername(user?.username || '');
    setEmail(user?.email || '');
    setPassword('');
    setConfirmPassword('');
    setLocalError(null);
    setSuccessMsg(null);
    setRole(isAdminRole(user) ? 'admin' : (user?.role || 'child'));
    setFlags(flagsFromUser(user));
    setAllowedDomains(user?.permissions?.allowedDomains || []);
    setAllowedSites(user?.permissions?.allowedSites || []);
    setAllowedAppIds(user?.permissions?.allowedAppIds || []);
    const dr = readDateRestrictionFromUser(user);
    setDateRestrictionStart(dr.start);
    setDateRestrictionEnd(dr.end);
  }, [open, user]);

  const handleDateRestrictionChange = (start, end) => {
    setDateRestrictionStart(start);
    setDateRestrictionEnd(end);
  };

  const onFlagChange = (key, checked) => {
    setFlags((prev) => ({ ...prev, [key]: checked }));
  };

  const scrollToError = () => {
    setTimeout(() => {
      errorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  };

  const submit = () => {
    setLocalError(null);
    const name = username.trim();
    const nameCheck = validateUsername(name);
    if (!nameCheck.valid) {
      setLocalError(nameCheck.errors[0]);
      scrollToError();
      return;
    }
    if (!isEdit && !password) {
      setLocalError('Password is required for new users.');
      scrollToError();
      return;
    }
    if (password || confirmPassword) {
      if (password !== confirmPassword) {
        setLocalError('Password and confirm password must match.');
        scrollToError();
        return;
      }
      const check = validatePassword(password, { username: name });
      if (!check.valid) {
        setLocalError(check.errors[0]);
        scrollToError();
        return;
      }
    }

    const effectiveRole = editingAdmin ? 'admin' : role;

    const payload = {
      username: name,
      email: email.trim() || `${name}@local`,
      password: password || undefined,
      role: effectiveRole,
    };

    if (effectiveRole !== 'admin') {
      if (dateRestrictionStart && dateRestrictionEnd && dateRestrictionStart > dateRestrictionEnd) {
        setLocalError('Allowed date range: start date must be on or before end date.');
        scrollToError();
        return;
      }
      Object.assign(payload, flags, {
        allowedDomains,
        allowedSites,
        allowedAppIds,
        ...dateRestrictionPayload(dateRestrictionStart, dateRestrictionEnd),
      });
    }

    onSave(payload);
  };

  const displayError = localError || error;

  const footer = (
    <>
      <Button variant="primary" onClick={submit} loading={saving}>Save</Button>
      <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
    </>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit User & Permissions' : 'Add New User'}
      footer={footer}
      width={560}
      className="ui-modal--user-form"
    >
      <div className="user-form-modal-content">
      {displayError && <div ref={errorRef} className="login-error">{displayError}</div>}

      <TextField label="Username" value={username} onChange={setUsername} placeholder="Enter username" autoFocus />
      <p className="form-note" style={{ marginTop: -8 }}>{USERNAME_RULES_HINT}</p>
      <TextField label="Email" type="email" value={email} onChange={setEmail} placeholder="user@example.com" />
      <TextField
        label="Password"
        type="password"
        value={password}
        onChange={setPassword}
        placeholder={isEdit ? 'Leave blank to keep current' : 'Enter password'}
        autoComplete="new-password"
      />
      <TextField
        label="Confirm Password"
        type="password"
        value={confirmPassword}
        onChange={setConfirmPassword}
        placeholder={isEdit ? 'Confirm new password' : 'Re-enter password'}
        autoComplete="new-password"
      />
      <p className="form-note" style={{ marginTop: -8 }}>{PASSWORD_RULES_HINT}</p>
      {editingAdmin ? (
        <>
          <TextField label="Role" value="Admin" readOnly />
          <div className="form-note">Admin role cannot be changed to Domain User.</div>
        </>
      ) : (
        <SelectField label="Role" value={role} onChange={setRole} options={ROLE_OPTIONS} />
      )}

      {role === 'admin' ? (
        <div className="form-note">Admin users have full access to all pages, reports, and user management.</div>
      ) : (
        <PermissionsPanel
          flags={flags}
          onFlagChange={onFlagChange}
          allowedDomains={allowedDomains}
          onDomainsChange={setAllowedDomains}
          allowedSites={allowedSites}
          onSitesChange={setAllowedSites}
          allowedAppIds={allowedAppIds}
          onAppIdsChange={setAllowedAppIds}
          dateRestrictionStart={dateRestrictionStart}
          dateRestrictionEnd={dateRestrictionEnd}
          onDateRestrictionChange={handleDateRestrictionChange}
          domains={domains}
          domainsLoading={domainsLoading}
          catalogLoading={catalogLoading}
          catalogRows={catalogRows}
          catalogLists={catalogLists}
        />
      )}
      </div>
    </Modal>
  );
}
