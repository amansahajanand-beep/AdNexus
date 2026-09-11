import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../components/ui/PageHeader';
import { usePermissions } from '../hooks/usePermissions';

const SECTIONS = [
  { id: 'start', label: 'Before you start' },
  { id: 'combos', label: 'Filter combinations' },
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'reporting', label: 'Reporting' },
  { id: 'roi', label: 'ROI' },
  { id: 'ads', label: 'Google Ads' },
  { id: 'presets', label: 'Presets' },
  { id: 'roles', label: 'Admin vs Domain User' },
  { id: 'shortcuts', label: 'Shortcuts' },
];

function Combo({ title, steps, result }) {
  return (
    <div className="help-combo">
      <h4 className="help-combo-title">{title}</h4>
      <ol className="help-combo-steps">
        {steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      {result ? <p className="help-combo-result">{result}</p> : null}
    </div>
  );
}

export default function Help() {
  const { isAdmin, canPage } = usePermissions();
  const [active, setActive] = useState('start');

  const visibleLinks = useMemo(() => {
    const links = [];
    if (canPage('dashboard')) links.push({ to: '/dashboard', label: 'Open Dashboard' });
    if (canPage('reporting')) links.push({ to: '/reporting', label: 'Open Reporting' });
    if (canPage('roi')) links.push({ to: '/roi', label: 'Open ROI' });
    if (canPage('my-ads')) links.push({ to: '/my-ads', label: 'Open Google Ads' });
    if (canPage('presets')) links.push({ to: '/presets', label: 'Open Presets' });
    if (isAdmin) links.push({ to: '/admin', label: 'Open Admin' });
    if (canPage('domain-user')) links.push({ to: '/domain-user', label: 'Open My Profile' });
    return links;
  }, [canPage, isAdmin]);

  const scrollTo = (id) => {
    setActive(id);
    const el = document.getElementById(`help-${id}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="dashboard-page help-page">
      <PageHeader
        title="Help"
        subtitle="How to use AdNexus — pages, filter combinations, and what you need to see data."
      />

      {visibleLinks.length > 0 && (
        <div className="help-quick-links">
          {visibleLinks.map((l) => (
            <Link key={l.to} to={l.to} className="help-quick-link">{l.label}</Link>
          ))}
        </div>
      )}

      <div className="help-layout">
        <nav className="help-toc filter-card" aria-label="Help sections">
          <div className="filter-card-head">
            <span className="filter-card-title">On this page</span>
          </div>
          <ul className="help-toc-list">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={`help-toc-btn${active === s.id ? ' is-active' : ''}`}
                  onClick={() => scrollTo(s.id)}
                >
                  {s.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="help-body">
          <section id="help-start" className="filter-card help-section">
            <div className="filter-card-head">
              <span className="filter-card-title">Before you start</span>
            </div>
            <ul className="help-bullets">
              <li>AdNexus shows <strong>GAM earnings</strong> and <strong>Google Ads spend</strong> in one place (sidebar shows currency and timezone).</li>
              <li>Ask your admin for <strong>page access</strong> and at least one assigned <strong>domain, site, or app</strong>. Ads accounts alone do not unlock the app.</li>
              <li>You also need permission to <strong>view reports</strong> and <strong>apply filters</strong>.</li>
              <li>For ROI spend: Google Ads must be <strong>connected and synced</strong> (Admin → Google Ads, or the Google Ads page for domain users).</li>
              <li>Almost every page needs you to click <strong>Apply Filter</strong> after choosing dates — data does not load until then.</li>
            </ul>
          </section>

          <section id="help-combos" className="filter-card help-section">
            <div className="filter-card-head">
              <span className="filter-card-title">Filter combinations that show data</span>
            </div>
            <p className="help-lead">
              Use these recipes when a page looks empty. Complete dates first, then Apply.
            </p>
            <div className="help-combo-grid">
              <Combo
                title="Dashboard — admin"
                steps={[
                  'Open Dashboard',
                  'Pick a date preset (Today / Last 7 days) or a full custom start + end',
                  'Click Apply Filter',
                ]}
                result="Overview KPIs, charts, and the breakdown table load for the network (optionally refine with domain / site / app)."
              />
              <Combo
                title="Dashboard — domain user"
                steps={[
                  'Open Dashboard',
                  'Pick dates',
                  'Select at least one assigned domain, site, or app',
                  'Click Apply Filter',
                ]}
                result="Scoped inventory metrics for what was assigned to you. Without inventory selection, Apply stays blocked."
              />
              <Combo
                title="Reporting"
                steps={[
                  'Open Reporting',
                  'Keep or pick dimensions and metrics',
                  'Optionally add domain / site / app / ad unit',
                  'Set a complete date range',
                  'Click Apply Filter',
                ]}
                result="Nothing loads until Apply. Need at least one dimension, metric, or inventory filter plus dates."
              />
              <Combo
                title="ROI — spend + earn"
                steps={[
                  'Connect Google Ads and run Sync (Admin or Google Ads page)',
                  'Open ROI and pick a date range',
                  'Optionally filter Ads account, campaign, app, site, or country',
                  'Click Apply Filter',
                ]}
                result="Ads spend vs GAM earn. Missing spend → Ads not connected/synced. Missing site earn → pick the subdomain / inventory on ROI."
              />
              <Combo
                title="ROI — same app on multiple Ads accounts"
                steps={[
                  'Apply a date range on ROI',
                  'Expand Country → Account → Package',
                ]}
                result="GAM package earn is shown on the top-spend Ads account only. Other accounts still show spend so totals are not double-counted."
              />
              <Combo
                title="Presets"
                steps={[
                  'On Dashboard, Reporting, or ROI, set filters you like',
                  'Save as a preset',
                  'Later open Presets and launch it with a fresh date range',
                ]}
                result="Reuses dimensions, inventory, and Ads filters without rebuilding them each time."
              />
            </div>
          </section>

          <section id="help-dashboard" className="filter-card help-section">
            <div className="filter-card-head">
              <span className="filter-card-title">Dashboard</span>
            </div>
            <ul className="help-bullets">
              <li>Network overview: KPIs, trends, and a detailed breakdown table.</li>
              <li>Always <strong>Apply Filter</strong> after changing dates or inventory.</li>
              <li>Use Compare to stack two date ranges.</li>
              <li>Save the current view as a preset for later.</li>
            </ul>
          </section>

          <section id="help-reporting" className="filter-card help-section">
            <div className="filter-card-head">
              <span className="filter-card-title">Reporting</span>
            </div>
            <ul className="help-bullets">
              <li>Build historical GAM reports with dimensions, metrics, and inventory filters.</li>
              <li>Data stays empty until you click <strong>Apply Filter</strong>.</li>
              <li>Export CSV / Excel when download permission is enabled.</li>
              <li>If results are empty: widen dates, clear a tight filter, or confirm inventory is assigned.</li>
            </ul>
          </section>

          <section id="help-roi" className="filter-card help-section">
            <div className="filter-card-head">
              <span className="filter-card-title">ROI</span>
            </div>
            <ul className="help-bullets">
              <li><strong>Spend</strong> comes from Google Ads; <strong>earn</strong> comes from GAM; expenses are optional manual costs.</li>
              <li>Country tree: Country → Ads account → Package / Site.</li>
              <li>Site rows show impressions, clicks, CTR, and eCPM from GAM (Ads spend stays blank on earn-only sites).</li>
              <li>Use account / campaign / app / site / country filters to refine, then Apply.</li>
            </ul>
          </section>

          <section id="help-ads" className="filter-card help-section">
            <div className="filter-card-head">
              <span className="filter-card-title">Google Ads</span>
            </div>
            <ul className="help-bullets">
              <li><strong>Admins:</strong> Admin → Google Ads accounts → Connect with Google → pick MCC or client → Sync spend. Toggle Include in ROI on partner accounts.</li>
              <li><strong>Domain users:</strong> Google Ads in the sidebar → Connect with Google → select account → Sync spend. Disconnect only removes it from your ROI view.</li>
              <li>GAM network connection (Admin → client settings) is separate from Ads OAuth.</li>
            </ul>
          </section>

          <section id="help-presets" className="filter-card help-section">
            <div className="filter-card-head">
              <span className="filter-card-title">Presets</span>
            </div>
            <ul className="help-bullets">
              <li>Store reusable filter combinations from Dashboard, Reporting, or ROI.</li>
              <li>Open a preset from the Presets page or from the in-page preset picker.</li>
              <li>Always re-check the date range after opening a preset.</li>
            </ul>
          </section>

          <section id="help-roles" className="filter-card help-section">
            <div className="filter-card-head">
              <span className="filter-card-title">Admin vs Domain User</span>
            </div>
            <div className="help-table-wrap">
              <table className="data-table report-table report-table--comfortable help-table">
                <thead>
                  <tr>
                    <th>Topic</th>
                    <th>Admin</th>
                    <th>Domain user</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Data scope</td>
                    <td>Full network</td>
                    <td>Assigned domains / sites / apps only</td>
                  </tr>
                  <tr>
                    <td>Admin page</td>
                    <td>Yes — users, permissions, GAM, Ads</td>
                    <td>No</td>
                  </tr>
                  <tr>
                    <td>My Profile / Google Ads</td>
                    <td>No (use Admin instead)</td>
                    <td>Yes when permitted</td>
                  </tr>
                  <tr>
                    <td>Empty inventory</td>
                    <td>Still can use the app</td>
                    <td>App is blocked until admin assigns inventory</td>
                  </tr>
                  <tr>
                    <td>ROI Ads accounts</td>
                    <td>Network Ads accounts</td>
                    <td>Assigned IDs + accounts you connect on Google Ads</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section id="help-shortcuts" className="filter-card help-section">
            <div className="filter-card-head">
              <span className="filter-card-title">Shortcuts & tips</span>
            </div>
            <ul className="help-bullets">
              <li><kbd>A</kbd> — Apply Filter (on pages that support it)</li>
              <li><kbd>R</kbd> — Reset filters</li>
              <li><kbd>/</kbd> — Focus search</li>
              <li><kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>K</kbd> — Command palette (jump to pages)</li>
              <li><kbd>[</kbd> — Toggle focus mode (hide chrome)</li>
              <li>Use dark mode and focus controls in the sidebar header</li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
