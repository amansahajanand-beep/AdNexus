import React from 'react';
import { NavLink } from 'react-router-dom';
import './AppBuilding.css';

// Same grouping as Kpeworld's section menu.
const GROUPS = [
  ['Intelligence', [['pulse', 'Market Pulse'], ['build', 'What to build'], ['viewer', 'Ads Viewer'], ['intel', 'Marketing Intel'], ['search', 'Search']]],
  ['Creatives', [['top-ads', 'Top Ads'], ['compare', 'Ad Compare'], ['explorer', 'Creative Explorer'], ['video-groups', 'Video Groups']]],
  ['Advertisers & apps', [['advertisers', 'Advertisers'], ['best-apps', 'Best Apps'], ['websites', 'Websites'], ['other-assets', 'Other assets'], ['app-groups', 'App Groups'], ['match-videos', 'Match Videos'], ['lookup', 'App Lookup']]],
];

/** Section switcher (same segmented control as the Admin page), grouped like Kpeworld's menu. Rendered by each page under its header. */
export default function AppBuildingTabs() {
  return (
    <div className="ab-tabs-groups" role="tablist" aria-label="App Building sections">
      {GROUPS.map(([group, tabs]) => (
        <div key={group} className="ab-tabs-group">
          <span className="ab-tabs-label">{group}</span>
          <div className="admin-tabs ab-tabs">
            {tabs.map(([to, label]) => (
              <NavLink key={to} to={`/app-building/${to}`} role="tab" className={({ isActive }) => `admin-tab${isActive ? ' active' : ''}`}>
                {label}
              </NavLink>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
