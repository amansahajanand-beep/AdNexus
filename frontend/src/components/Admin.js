import React, { useState, useEffect, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { usersAPI, domainsAPI, reportsAPI } from '../utils/api';
import { useAuth } from '../store/useAuth';
import { catalogRowsToDomainOptions, catalogRowsToAppIdOptions, normalizeDomainPickerOptions } from '../utils/domainCatalog';
import { isLikelyAppPackage } from '../utils/appPackage';
import UserManagement from './admin/UserManagement';
import ClientSettings from './admin/ClientSettings';
import DomainPermissions from './admin/DomainPermissions';
import PageHeader from './ui/PageHeader';
import { getUserFacingMessage, logErrorForDebug } from '../utils/userFacingError';
const TABS = [
  { id: 'user', label: 'Users' },
  { id: 'domains', label: 'Assign Permissions' },
  { id: 'client', label: 'GAM credentials' },
];

export default function Admin() {
  const { user } = useAuth();
  const location = useLocation();
  const [tab, setTab] = useState(() => (
    new URLSearchParams(location.search).get('oauth') ? 'client' : 'user'
  ));

  useEffect(() => {
    if (new URLSearchParams(location.search).get('oauth')) setTab('client');
  }, [location.search]);
  const [users, setUsers] = useState([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersError, setUsersError] = useState(null);

  const [domains, setDomains] = useState([]);
  const [catalogRows, setCatalogRows] = useState([]);
  const [catalogLists, setCatalogLists] = useState({ siteHosts: [], appIds: [], sitesByDomain: {}, adUnitsByHost: {} });
  const [domainsLoading, setDomainsLoading] = useState(true);
  const [catalogLoading, setCatalogLoading] = useState(true);

  const [permSaving, setPermSaving] = useState(false);
  const [permError, setPermError] = useState(null);

  const loadUsers = useCallback(async () => {
    setUsersLoading(true);
    setUsersError(null);
    try {
      setUsers(await usersAPI.getAll());
    } catch (err) {
      logErrorForDebug(err, 'Admin users');
      setUsersError(getUserFacingMessage(err, 'Could not load users. Please refresh the page.'));
    } finally {
      setUsersLoading(false);
    }
  }, []);

  const loadDomains = useCallback(async () => {
    setDomainsLoading(true);
    setCatalogLoading(true);
    let picker = null;
    try {
      picker = await usersAPI.getInventoryPicker().catch(() => null);
      if (picker) {
        setCatalogLists({
          siteHosts: picker.siteHosts || [],
          appIds: picker.appIds || [],
          sitesByDomain: picker.sitesByDomain || {},
          adUnitsByHost: picker.adUnitsByHost || {},
        });
        if (picker.domains?.length) {
          setDomains(picker.domains);
        } else if (picker.domainRoots?.length) {
          setDomains(picker.domainRoots.map((d) => ({ id: d, label: d, domainName: d })));
        }
      }
    } catch {
      /* inventory-picker optional on first load */
    } finally {
      setCatalogLoading(false);
    }

    try {
      const catalog = await reportsAPI.getFilterCatalog().catch(() => null);
      if (catalog?.rows?.length) {
        setCatalogRows(catalog.rows);
        setCatalogLists((prev) => ({
          siteHosts: catalog.siteHosts?.length ? catalog.siteHosts : (prev.siteHosts || []),
          appIds: catalog.appPackages?.length
            ? catalog.appPackages.filter(isLikelyAppPackage)
            : catalogRowsToAppIdOptions(catalog.rows).map((o) => o.id),
          sitesByDomain: catalog.sitesByDomain || prev.sitesByDomain || {},
          adUnitsByHost: catalog.adUnitsByHost || prev.adUnitsByHost || {},
        }));
        setDomains(catalogRowsToDomainOptions(catalog.rows));
        return;
      }
      if (!picker?.domains?.length && !picker?.domainRoots?.length) {
        const list = await domainsAPI.getAll();
        setDomains(normalizeDomainPickerOptions(Array.isArray(list) ? list : []));
      }
    } catch {
      try {
        const list = await domainsAPI.getAll();
        setDomains(normalizeDomainPickerOptions(Array.isArray(list) ? list : []));
      } catch {
        setDomains([]);
      }
    } finally {
      setDomainsLoading(false);
    }
  }, []);
  useEffect(() => { loadUsers(); loadDomains(); }, [loadUsers, loadDomains]);

  // ─── Action handlers ──────────────────────────────────────────────────────
  const onCreate = async (payload) => {
    const createdUser = await usersAPI.create(payload);
    await loadUsers();
    return createdUser;
  };
  const onUpdate = async (id, payload) => { await usersAPI.update(id, payload); await loadUsers(); };
  const onDelete = async (id) => { await usersAPI.remove(id); await loadUsers(); };
  const onSavePermissions = async (id, payload) => {
    await usersAPI.updatePermissions(id, payload);
    await loadUsers();
  };


  const onSaveDomainTab = async (id, payload, username) => {
    setPermSaving(true);
    setPermError(null);
    try {
      await usersAPI.updatePermissions(id, payload);
      await loadUsers();
    } catch (err) {
      logErrorForDebug(err, 'Admin permissions');
      setPermError(getUserFacingMessage(err, 'Could not save permissions. Please try again.'));
      throw err;
    } finally {
      setPermSaving(false);
    }
  };

  return (
    <div className="dashboard-page admin-page">
      <PageHeader
        title="Admin"
        subtitle="Users, inventory permissions, and GAM OAuth credentials"
        summary={tab === 'user' ? 'User management' : tab === 'domains' ? 'Assign inventory access' : 'Client OAuth settings'}
      />

      <div className="admin-tabs" role="tablist" aria-label="Admin sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`admin-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'user' && (
        <UserManagement
          users={users}
          loading={usersLoading}
          error={usersError}
          domains={domains}
          domainsLoading={domainsLoading}
          catalogLoading={catalogLoading}
          catalogRows={catalogRows}
          catalogLists={catalogLists}
          onCreate={onCreate}
          onUpdate={onUpdate}
          onSavePermissions={onSavePermissions}
          onDelete={onDelete}
          currentUserId={user?.id}
          onLoadDomains={loadDomains}
        />
      )}

      {tab === 'client' && <ClientSettings />}

      {tab === 'domains' && (
        <DomainPermissions
          users={users}
          usersLoading={usersLoading}
          domains={domains}
          domainsLoading={domainsLoading}
          catalogLoading={catalogLoading}
          catalogRows={catalogRows}
          catalogLists={catalogLists}
          onSave={onSaveDomainTab}
          saving={permSaving}
          error={permError}
          onLoadDomains={loadDomains}
        />
      )}
    </div>
  );
}
