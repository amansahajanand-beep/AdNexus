import React from 'react';
import PageHeader from '../components/ui/PageHeader';
import GoogleSheetsPanel from '../components/ui/GoogleSheetsPanel';

export default function GoogleSheets() {
  return (
    <div className="dashboard-page">
      <PageHeader
        title="Google Sheets"
        subtitle="Get your daily data in your own Google Sheet, updated automatically every morning"
      />
      <GoogleSheetsPanel />
    </div>
  );
}
