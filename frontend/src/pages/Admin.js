import React, { useState, useEffect, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { usersAPI, domainsAPI, reportsAPI, adsAPI, clientsAPI, admobAPI, adsenseAPI } from '../utils/api';
import { useAuth } from '../store/useAuth';
import { catalogRowsToDomainOptions, catalogRowsToAppIdOptions, normalizeDomainPickerOptions } from '../utils/domainCatalog';
import { isLikelyAppPackage } from '../utils/appPackage';
import UserManagement from '../components/admin/UserManagement';
import ClientSettings from '../components/admin/ClientSettings';
import AdsAccountsAdmin from '../components/admin/AdsAccountsAdmin';
import CampaignMappingPanel from '../components/admin/CampaignMappingPanel';
import AiAdminPanel from '../components/admin/AiAdminPanel';
import ProductAccountsAdmin from '../components/admin/ProductAccountsAdmin';
import DomainPermissions from '../components/admin/DomainPermissions';
import PageHeader from '../components/ui/PageHeader';
import { ADSENSE_ENABLED, resolveActiveProduct } from '../utils/productWorkspace';
import { getUserFacingMessage, logErrorForDebug } from '../utils/userFacingError';
import {
  Users, ShieldAlert, Settings, Megaphone, Smartphone, Newspaper, Sparkles,
} from '../components/ui/Icon';

const TABS = [
  { id: 'user', label: 'Users', Icon: Users },
  { id: 'domains', label: 'Assign Permissions', Icon: ShieldAlert },
  { id: 'client', label: 'GAM connection', Icon: Settings, products: ['gam'] },
  { id: 'ads', label: 'Google Ads accounts', Icon: Megaphone, products: ['gam', 'admob', 'adsense'] },
  { id: 'admob', label: 'AdMob accounts', Icon: Smartphone, products: ['admob'] },
  { id: 'adsense', label: 'AdSense accounts', Icon: Newspaper, products: ['adsense'] },
  { id: 'ai', label: 'AI', Icon: Sparkles },
];

function tabsForProduct(product) {
  return TABS.filter((t) => !t.products || t.products.includes(product));
}

function buildAdsAccountPickerOptions(accounts = []) {
  return (accounts || [])
    .filter((a) => a && a.accountType === 'client' && a.isActive !== false)
    .map((a) => {
      const name = a.descriptiveName || a.customerId || a.id;
      const cid = a.customerId ? String(a.customerId) : '';
      return {
        id: String(a.id),
        label: cid && name !== cid ? `${name} (${cid})` : String(name),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

export default function Admin() {
  const { user } = useAuth();
  const location = useLocation();
  const [tab, setTab] = useState(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('tab') === 'ads' || params.get('ads_oauth')) return 'ads';
    if (params.get('tab') === 'admob') return 'admob';
    if (params.get('tab') === 'adsense') return 'adsense';
    if (params.get('tab') === 'ai') return 'ai';
    if (params.get('oauth')) return 'client';
    return 'user';
  });

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('tab') === 'ads' || params.get('ads_oauth')) setTab('ads');
    else if (params.get('tab') === 'admob') setTab('admob');
    else if (params.get('tab') === 'adsense') setTab('adsense');
    else if (params.get('tab') === 'ai') setTab('ai');
    else if (params.get('oauth')) setTab('client');
  }, [location.search]);
  const [users, setUsers] = useState([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersError, setUsersError] = useState(null);

  const [domains, setDomains] = useState([]);
  const [catalogRows, setCatalogRows] = useState([]);
  const [catalogLists, setCatalogLists] = useState({ siteHosts: [], appIds: [], sitesByDomain: {}, adUnitsByHost: {} });
  const [domainsLoading, setDomainsLoading] = useState(true);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [adsAccountOptions, setAdsAccountOptions] = useState([]);
  const [adsAccountsLoading, setAdsAccountsLoading] = useState(true);
  const [networks, setNetworks] = useState([]);

  const activeProduct = resolveActiveProduct(location.pathname);
  // AdMob and AdSense share one publisher workspace tenant that owns its own Google Ads accounts.
  const publisherApi = activeProduct === 'admob' ? admobAPI : activeProduct === 'adsense' ? adsenseAPI : null;
  const publisherLabel = activeProduct === 'admob' ? 'AdMob' : 'AdSense';
  const visibleTabs = tabsForProduct(activeProduct);

  useEffect(() => {
    if (!visibleTabs.some((t) => t.id === tab)) setTab(visibleTabs[0].id);
  }, [visibleTabs, tab]);
  const [publisherWorkspace, setPublisherWorkspace] = useState(null);
  const [publisherWorkspaceError, setPublisherWorkspaceError] = useState(null);

  useEffect(() => {
    if (!publisherApi || tab !== 'ads' || publisherWorkspace) return undefined;
    let cancelled = false;
    publisherApi.workspace()
      .then((ws) => { if (!cancelled) setPublisherWorkspace(ws); })
      .catch((err) => {
        if (!cancelled) setPublisherWorkspaceError(getUserFacingMessage(err, `Could not load the ${publisherLabel} workspace.`));
      });
    return () => { cancelled = true; };
  }, [publisherApi, publisherLabel, tab, publisherWorkspace]);

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

  const loadNetworks = useCallback(async () => {
    try {
      const data = await clientsAPI.networks();
      setNetworks((data?.networks || []).filter((n) => !n.isPending && n.networkCode));
    } catch {
      setNetworks([]);
    }
  }, []);

  const loadAdsAccounts = useCallback(async () => {
    setAdsAccountsLoading(true);
    try {
      const list = await adsAPI.listAccounts();
      setAdsAccountOptions(buildAdsAccountPickerOptions(Array.isArray(list) ? list : list?.accounts || []));
    } catch (err) {
      logErrorForDebug(err, 'Admin ads accounts picker');
      setAdsAccountOptions([]);
    } finally {
      setAdsAccountsLoading(false);
    }
  }, []);

  const loadDomains = useCallback(async () => {
    setDomainsLoading(true);
    setCatalogLoading(true);
    const networkIds = networks.map((n) => n.id).filter(Boolean);
    const primaryClientId = networkIds[0] || user?.clientId;
    let picker = null;
    try {
      picker = await usersAPI.getInventoryPicker(primaryClientId).catch(() => null);
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
      const catalog = networkIds.length > 1
        ? await reportsAPI.getMergedFilterCatalog(networkIds).catch(() => null)
        : await reportsAPI.getFilterCatalog(primaryClientId).catch(() => null);
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
  }, [user?.clientId, networks]);
  useEffect(() => { loadUsers(); loadNetworks(); loadAdsAccounts(); }, [loadUsers, loadNetworks, loadAdsAccounts]);
  useEffect(() => { loadDomains(); }, [loadDomains]);

  // After admin connects another GAM network, reload scoped lists.
  useEffect(() => {
    if (!user?.clientId) return undefined;
    loadUsers();
    loadNetworks();
    return undefined;
  }, [user?.clientId, loadUsers, loadNetworks]);

  useEffect(() => {
    if (tab === 'user' || tab === 'domains') loadAdsAccounts();
  }, [tab, loadAdsAccounts]);

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
        subtitle={
          activeProduct === 'admob' ? 'Users, permissions, AdMob accounts, and Google Ads ROI setup'
            : activeProduct === 'adsense' ? 'Users, permissions, AdSense accounts, and Google Ads ROI setup'
              : 'Users, inventory permissions, GAM OAuth, and Google Ads ROI setup'
        }
        summary={
          tab === 'user' ? 'User management'
            : tab === 'domains' ? 'Assign inventory access'
              : tab === 'client' ? 'Client OAuth settings'
                : tab === 'ads' ? 'Google Ads MCC & accounts'
                  : tab === 'admob' ? 'AdMob publisher accounts'
                    : tab === 'adsense' ? 'AdSense publisher accounts'
                      : tab === 'ai' ? 'AI features'
                        : ''
        }
      />

      <div className="admin-tabs" role="tablist" aria-label="Admin sections">
        {visibleTabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`admin-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            <t.Icon size={15} strokeWidth={1.75} className="admin-tab-icon" aria-hidden />
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
          adsAccountOptions={adsAccountOptions}
          adsAccountsLoading={adsAccountsLoading}
          networks={networks}
          onCreate={onCreate}
          onUpdate={onUpdate}
          onSavePermissions={onSavePermissions}
          onDelete={onDelete}
          currentUserId={user?.id}
          onLoadDomains={loadDomains}
        />
      )}

      {tab === 'client' && <ClientSettings />}

      {tab === 'ads' && !publisherApi && (
        <>
          <AdsAccountsAdmin />
          <CampaignMappingPanel product="gam" />
        </>
      )}
      {tab === 'ads' && publisherApi && (
        publisherWorkspace?.clientId ? (
          <>
            <AdsAccountsAdmin
              key={publisherWorkspace.clientId}
              clientId={publisherWorkspace.clientId}
              scopeLabel={publisherLabel}
            />
            <CampaignMappingPanel
              key={`map-${publisherWorkspace.clientId}-${activeProduct}`}
              product={activeProduct}
              clientId={publisherWorkspace.clientId}
            />
          </>
        ) : (
          <p className="muted">{publisherWorkspaceError || `Loading ${publisherLabel} Google Ads accounts…`}</p>
        )
      )}

      {tab === 'admob' && (
        <ProductAccountsAdmin
          product="admob"
          title="AdMob accounts"
          dashboardPath="/admob/dashboard"
        />
      )}

      {tab === 'adsense' && (
        <ProductAccountsAdmin
          product="adsense"
          title="AdSense accounts"
          dashboardPath={ADSENSE_ENABLED ? '/adsense/dashboard' : null}
        />
      )}

      {tab === 'ai' && <AiAdminPanel />}

      {tab === 'domains' && (
        <DomainPermissions
          users={users}
          usersLoading={usersLoading}
          domains={domains}
          domainsLoading={domainsLoading}
          catalogLoading={catalogLoading}
          catalogRows={catalogRows}
          catalogLists={catalogLists}
          adsAccountOptions={adsAccountOptions}
          adsAccountsLoading={adsAccountsLoading}
          onSave={onSaveDomainTab}
          saving={permSaving}
          error={permError}
          onLoadDomains={loadDomains}
        />
      )}
    </div>
  );
}
