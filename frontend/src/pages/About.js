import React from 'react';
import { Link } from 'react-router-dom';
import { BrandMark } from '../components/ui/BrandLogo';

/**
 * Public app homepage for Google OAuth branding verification.
 * App name on this page must match OAuth consent screen App name: "mediamonetix".
 */
export default function About() {
  return (
    <div className="login-screen legal-page">
      <div className="legal-body">
        <header className="legal-header">
          <Link to="/about" className="login-brand-row legal-brand">
            <BrandMark size={36} className="login-logo" />
            <span className="login-brand-name">mediamonetix</span>
          </Link>
          <nav className="legal-nav">
            <Link to="/about">About</Link>
            <Link to="/privacy">Privacy Policy</Link>
            <Link to="/terms">Terms of Service</Link>
            <Link to="/login">Sign in</Link>
          </nav>
        </header>
        <article className="legal-card">
          <h1 className="legal-title">mediamonetix</h1>
          <p className="legal-updated">Application home page</p>
          <div className="legal-content">
            <p>
              <strong>mediamonetix</strong> is an advertising analytics application that helps
              publishers and advertisers view Google Ad Manager (GAM) earnings and Google Ads
              spend in one place. Authorized users sign in to access reporting, ROI analysis,
              inventory views, and related dashboard tools for their connected Google accounts.
            </p>

            <h2>Purpose of mediamonetix</h2>
            <ul>
              <li>
                Connect Google Ad Manager and Google Ads with OAuth so reporting data can sync
                securely.
              </li>
              <li>
                Display dashboards and detailed reports for impressions, revenue, campaigns, and
                inventory.
              </li>
              <li>
                Help teams compare earnings and ad spend (ROI) across sites, apps, and accounts.
              </li>
              <li>
                Provide administration tools for organizations that manage multiple users and
                clients.
              </li>
            </ul>

            <h2>Access</h2>
            <p>
              mediamonetix is for authorized business users. You can review our{' '}
              <Link to="/privacy">Privacy Policy</Link> and <Link to="/terms">Terms of Service</Link>{' '}
              without signing in. Account holders can{' '}
              <Link to="/login">sign in to mediamonetix</Link>.
            </p>
          </div>
        </article>
      </div>
      <footer className="login-footer">
        <span>© {new Date().getFullYear()} mediamonetix</span>
      </footer>
    </div>
  );
}
