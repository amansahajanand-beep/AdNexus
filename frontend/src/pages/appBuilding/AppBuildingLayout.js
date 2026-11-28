import React from 'react';
import { Outlet } from 'react-router-dom';
import './AppBuilding.css';

/** Plain pass-through: pages render their own header and <AppBuildingTabs /> like every other dashboard page. */
export default function AppBuildingLayout() {
  return (
    <div className="ab-shell">
      <Outlet />
    </div>
  );
}
