import React, { useState, useEffect, useMemo, useRef } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { TextField, SelectField } from '../ui/Field';
import MultiSelect from '../ui/MultiSelect';
import PermissionsPanel from './PermissionsPanel';
import { validatePassword, PASSWORD_RULES_HINT } from '../../utils/passwordPolicy';
import { validateUsername, USERNAME_RULES_HINT } from '../../utils/namePolicy';
import { readDateRestrictionFromUser, dateRestrictionPayload } from '../../utils/adminDateRestriction';
import { PERMISSION_SECTIONS } from '../../utils/permissions';
import { isAllSelection } from '../../utils/inventorySelection';
import { reportsAPI, usersAPI } from '../../utils/api';
import { catalogRowsToDomainOptions, catalogRowsToAppIdOptions } from '../../utils/domainCatalog';
import { isLikelyAppPackage } from '../../utils/appPackage';

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

function allowedClientIdsFromUser(user, linkedNetworks) {
  const fromPerms = user?.permissions?.allowedClientIds;
  if (Array.isArray(fromPerms) && fromPerms.length) {
    return fromPerms.map((id) => String(id)).filter(Boolean);
  }
  if (Array.isArray(user?.allowedClientIds) && user.allowedClientIds.length) {
    return user.allowedClientIds.map((id) => String(id)).filter(Boolean);
  }
  if (user?.clientId) return [String(user.clientId)];
  return linkedNetworks[0]?.id ? [linkedNetworks[0].id] : [];
}

export default function UserFormModal({
  open, onClose, onSave, saving, error, user,
  domains = [], domainsLoading, catalogLoading = false, catalogRows = [], catalogLists = {},
  adsAccountOptions = [], adsAccountsLoading = false,
  networks = [],
}) {
  const isEdit = !!user;
  const editingAdmin = isEdit && isAdminRole(user);
  const linkedNetworks = useMemo(
    () => (networks || []).filter((n) => !n.isPending && n.networkCode),
    [networks]
  );
  const networkOptions = useMemo(
    () => linkedNetworks.map((n) => ({
      value: n.id,
      label: n.name ? `${n.name} (${n.networkCode})` : n.networkCode,
    })),
    [linkedNetworks]
  );
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [role, setRole] = useState('child');
  const [allowedClientIds, setAllowedClientIds] = useState([]);
  const [flags, setFlags] = useState(defaultFlags);
  const [allowedDomains, setAllowedDomains] = useState([]);
  const [allowedSites, setAllowedSites] = useState([]);
  const [allowedAppIds, setAllowedAppIds] = useState([]);
  const [allowedAdsAccountIds, setAllowedAdsAccountIds] = useState([]);
  const [dateRestrictionStart, setDateRestrictionStart] = useState('');
  const [dateRestrictionEnd, setDateRestrictionEnd] = useState('');
  const [localError, setLocalError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);
  const errorRef = useRef(null);
  const [scopeDomains, setScopeDomains] = useState(domains);
  const [scopeCatalogRows, setScopeCatalogRows] = useState(catalogRows);
  const [scopeCatalogLists, setScopeCatalogLists] = useState(catalogLists);
  const [scopeCatalogLoading, setScopeCatalogLoading] = useState(false);
  const [scopeDomainsLoading, setScopeDomainsLoading] = useState(false);
  const networksKey = allowedClientIds.slice().sort().join(',');

  useEffect(() => {
    if (!open) return;
    setUsername(user?.username || '');
    setEmail(user?.email || '');
    setPassword('');
    setConfirmPassword('');
    setLocalError(null);
    setSuccessMsg(null);
    setRole(isAdminRole(user) ? 'admin' : (user?.role || 'child'));
    setAllowedClientIds(allowedClientIdsFromUser(user, linkedNetworks));
    setFlags(flagsFromUser(user));
    setAllowedDomains(user?.permissions?.allowedDomains || []);
    setAllowedSites(user?.permissions?.allowedSites || []);
    setAllowedAppIds(user?.permissions?.allowedAppIds || []);
    setAllowedAdsAccountIds(user?.permissions?.allowedAdsAccountIds || []);
    const dr = readDateRestrictionFromUser(user);
    setDateRestrictionStart(dr.start);
    setDateRestrictionEnd(dr.end);
  }, [open, user, linkedNetworks]);

  // Inventory catalog follows selected network permissions (one network or merged).
  useEffect(() => {
    if (!open || role === 'admin') return undefined;
    const ids = (allowedClientIds || []).map(String).filter(Boolean);
    if (!ids.length) {
      setScopeDomains([]);
      setScopeCatalogRows([]);
      setScopeCatalogLists({ siteHosts: [], appIds: [], sitesByDomain: {}, adUnitsByHost: {} });
      setScopeCatalogLoading(false);
      setScopeDomainsLoading(false);
      return undefined;
    }
    let cancelled = false;
    setScopeCatalogLoading(true);
    setScopeDomainsLoading(true);
    (async () => {
      try {
        const [catalog, picker] = await Promise.all([
          reportsAPI.getMergedFilterCatalog(ids).catch(() => null),
          usersAPI.getMergedInventoryPicker(ids).catch(() => null),
        ]);
        if (cancelled) return;
        if (catalog?.rows?.length) {
          setScopeCatalogRows(catalog.rows);
          setScopeCatalogLists({
            siteHosts: catalog.siteHosts?.length ? catalog.siteHosts : (picker?.siteHosts || []),
            appIds: catalog.appPackages?.length
              ? catalog.appPackages.filter(isLikelyAppPackage)
              : (picker?.appIds || catalogRowsToAppIdOptions(catalog.rows).map((o) => o.id)),
            sitesByDomain: catalog.sitesByDomain || {},
            adUnitsByHost: catalog.adUnitsByHost || {},
          });
          setScopeDomains(catalogRowsToDomainOptions(catalog.rows));
        } else if (picker) {
          setScopeCatalogRows([]);
          setScopeCatalogLists({
            siteHosts: picker.siteHosts || [],
            appIds: picker.appIds || [],
            sitesByDomain: picker.sitesByDomain || {},
            adUnitsByHost: picker.adUnitsByHost || {},
          });
          if (picker.domains?.length) setScopeDomains(picker.domains);
          else if (picker.domainRoots?.length) {
            setScopeDomains(picker.domainRoots.map((d) => ({ id: d, label: d, domainName: d })));
          } else setScopeDomains([]);
        } else {
          setScopeDomains(domains);
          setScopeCatalogRows(catalogRows);
          setScopeCatalogLists(catalogLists);
        }
      } finally {
        if (!cancelled) {
          setScopeCatalogLoading(false);
          setScopeDomainsLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [open, role, networksKey]);

  // Drop assigned inventory that is no longer in the scoped catalog.
  useEffect(() => {
    if (!open || role === 'admin' || scopeCatalogLoading) return;
    const domainSet = new Set(
      (scopeDomains || []).map((d) => String(d.id || d.domainName || d.label || d).toLowerCase())
    );
    const siteSet = new Set((scopeCatalogLists.siteHosts || []).map((s) => String(s).toLowerCase()));
    const appSet = new Set((scopeCatalogLists.appIds || []).map((a) => String(a).toLowerCase()));
    if (domainSet.size) {
      setAllowedDomains((prev) => prev.filter((d) => domainSet.has(String(d).toLowerCase())));
    }
    if (siteSet.size) {
      setAllowedSites((prev) => prev.filter((s) => siteSet.has(String(s).toLowerCase())));
    }
    if (appSet.size) {
      setAllowedAppIds((prev) => prev.filter((a) => appSet.has(String(a).toLowerCase())));
    }
  }, [open, role, scopeCatalogLoading, networksKey, scopeDomains, scopeCatalogLists]);

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
      if (!allowedClientIds.length) {
        setLocalError('Select at least one network for this domain user.');
        scrollToError();
        return;
      }
      if (dateRestrictionStart && dateRestrictionEnd && dateRestrictionStart > dateRestrictionEnd) {
        setLocalError('Allowed date range: start date must be on or before end date.');
        scrollToError();
        return;
      }
      payload.allowedClientIds = allowedClientIds;
      payload.clientId = allowedClientIds[0];
      Object.assign(payload, flags, {
        allowedDomains,
        allowedSites,
        allowedAppIds,
        allowedAdsAccountIds,
        ...dateRestrictionPayload(dateRestrictionStart, dateRestrictionEnd),
      });
    }

    onSave(payload);
  };

  const displayError = localError || error;
  const showNetworkPicker = !editingAdmin && role !== 'admin' && linkedNetworks.length > 0;

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
      {showNetworkPicker && (
        <div className="ui-field" style={{ marginBottom: 14 }}>
          <span className="ui-field-label">Network permissions</span>
          <MultiSelect
            options={networkOptions}
            value={allowedClientIds}
            onChange={(next) => {
              if (isAllSelection(next)) {
                setAllowedClientIds(linkedNetworks.map((n) => n.id));
                return;
              }
              setAllowedClientIds((Array.isArray(next) ? next : []).map(String).filter(Boolean));
            }}
            placeholder="Select networks…"
            showSelectAll={linkedNetworks.length > 1}
            selectAllLabel="All networks"
          />
          <p className="form-note" style={{ marginTop: 6 }}>
            Domain user can open Dashboard / Reporting for the selected networks only.
          </p>
        </div>
      )}
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
          allowedAdsAccountIds={allowedAdsAccountIds}
          onAdsAccountsChange={setAllowedAdsAccountIds}
          dateRestrictionStart={dateRestrictionStart}
          dateRestrictionEnd={dateRestrictionEnd}
          onDateRestrictionChange={handleDateRestrictionChange}
          domains={scopeDomains}
          domainsLoading={scopeDomainsLoading || domainsLoading}
          catalogLoading={scopeCatalogLoading || catalogLoading}
          catalogRows={scopeCatalogRows}
          catalogLists={scopeCatalogLists}
          adsAccountOptions={adsAccountOptions}
          adsAccountsLoading={adsAccountsLoading}
        />
      )}
      </div>
    </Modal>
  );
}
