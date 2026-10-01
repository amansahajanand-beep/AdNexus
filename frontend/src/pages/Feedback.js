import React from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../components/ui/PageHeader';

export default function Feedback() {
  return (
    <div className="dashboard-page">
      <PageHeader
        title="Feedback & Issues"
        subtitle="Share product feedback or report a problem to your AdNexus administrator."
      />
      <section className="filter-card">
        <div className="filter-card-head">
          <span className="filter-card-title">Need help?</span>
        </div>
        <p>
          Feedback submission is not configured for this workspace. For an issue, include the page,
          date range, and steps to reproduce, then contact your AdNexus administrator.
        </p>
        <Link to="/help" className="btn-reset">Open Help</Link>
      </section>
    </div>
  );
}