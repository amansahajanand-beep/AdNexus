import React, { useState, useEffect, useCallback } from 'react';
import { usersAPI, reportsAPI, clientsAPI } from '../utils/api';
import { useAuth } from '../store/useAuth';
import { catalogRowsToDomainOptions, catalogRowsToAppIdOptions } from '../utils/domainCatalog';
import { isLikelyAppPackage } from '../utils/appPackage';
import UserManagement from '../components/admin/UserManagement';
import PageHeader from '../components/ui/PageHeader';
import { getUserFacingMessage, logErrorForDebug } from '../utils/userFacingError';

/**
 * Sub-admin workspace: add and manage the users you created, limited to the
 * networks, domains, sites and apps assigned to you.
 */
export default function TeamUsers() {
  const { user } = useAuth();
  const [users, setUsers] = useState([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersError, setUsersError] = useState(null);
  const [networks, setNetworks] = useState([]);
  const [domains, setDomains] = useState([]);
  const [catalogRows, setCatalogRows] = useState([]);
  const [catalogLists, setCatalogLists] = useState({ siteHosts: [], appIds: [], sitesByDomain: {}, adUnitsByHost: {} });
  const [catalogLoading, setCatalogLoading] = useState(true);

  const loadUsers = useCallback(async () => {
    setUsersLoading(true);
    setUsersError(null);
    try {
      setUsers(await usersAPI.getAll());
    } catch (err) {
      logErrorForDebug(err, 'Team users');
      setUsersError(getUserFacingMessage(err, 'Could not load users. Please refresh the page.'));
    } finally {
      setUsersLoading(false);
    }
  }, []);

  const loadNetworks = useCallback(async () => {
    try {
      // Already limited server-side to the networks this user may open.
      const data = await clientsAPI.accessibleNetworks();
      const own = (data?.networks || []).filter((n) => n.networkCode);
      setNetworks(own);
      return own;
    } catch {
      setNetworks([]);
      return [];
    }
  }, [user]);

  const loadDomains = useCallback(async (nets) => {
    setCatalogLoading(true);
    const ids = (nets || networks).map((n) => n.id).filter(Boolean);
    const primary = ids[0] || user?.clientId;
    try {
      const [catalog, picker] = await Promise.all([
        (ids.length > 1 ? reportsAPI.getMergedFilterCatalog(ids) : reportsAPI.getFilterCatalog(primary)).catch(() => null),
        usersAPI.getInventoryPicker(primary).catch(() => null),
      ]);
      if (catalog?.rows?.length) {
        setCatalogRows(catalog.rows);
        setCatalogLists({
          siteHosts: catalog.siteHosts?.length ? catalog.siteHosts : (picker?.siteHosts || []),
          appIds: catalog.appPackages?.length
            ? catalog.appPackages.filter(isLikelyAppPackage)
            : catalogRowsToAppIdOptions(catalog.rows).map((o) => o.id),
          sitesByDomain: catalog.sitesByDomain || {},
          adUnitsByHost: catalog.adUnitsByHost || {},
        });
        setDomains(catalogRowsToDomainOptions(catalog.rows));
      } else if (picker) {
        setCatalogLists({ siteHosts: picker.siteHosts || [], appIds: picker.appIds || [], sitesByDomain: {}, adUnitsByHost: {} });
        setDomains(picker.domains || (picker.domainRoots || []).map((d) => ({ id: d, label: d, domainName: d })));
      }
    } finally {
      setCatalogLoading(false);
    }
  }, [networks, user?.clientId]);

  useEffect(() => {
    loadUsers();
    loadNetworks().then((nets) => loadDomains(nets));
  }, []);

  const onCreate = async (payload) => {
    const created = await usersAPI.create(payload);
    await loadUsers();
    return created;
  };
  const onUpdate = async (id, payload) => { await usersAPI.update(id, payload); await loadUsers(); };
  const onDelete = async (id) => { await usersAPI.remove(id); await loadUsers(); };
  const onSavePermissions = async (id, payload) => { await usersAPI.updatePermissions(id, payload); await loadUsers(); };

  return (
    <div className="dashboard-page admin-page">
      <PageHeader
        title="Team"
        subtitle="Add users and choose which of your sites they can manage"
        summary="Users you created"
      />
      <UserManagement
        subAdmin
        users={users}
        loading={usersLoading}
        error={usersError}
        domains={domains}
        domainsLoading={catalogLoading}
        catalogLoading={catalogLoading}
        catalogRows={catalogRows}
        catalogLists={catalogLists}
        networks={networks}
        onCreate={onCreate}
        onUpdate={onUpdate}
        onSavePermissions={onSavePermissions}
        onDelete={onDelete}
        currentUserId={user?.id}
        onLoadDomains={() => loadDomains()}
      />
    </div>
  );
}
