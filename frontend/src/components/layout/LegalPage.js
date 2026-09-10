import React from 'react';
import { Link } from 'react-router-dom';
import { BrandMark } from '../ui/BrandLogo';

/** Public legal document shell (no auth). */
export default function LegalPage({ title, children }) {
  return (
    <div className="login-screen legal-page">
      <div className="legal-body">
        <header className="legal-header">
          <Link to="/login" className="login-brand-row legal-brand">
            <BrandMark size={36} className="login-logo" />
            <span className="login-brand-name">AdNexus</span>
          </Link>
          <nav className="legal-nav">
            <Link to="/privacy">Privacy Policy</Link>
            <Link to="/terms">Terms of Service</Link>
            <Link to="/login">Sign in</Link>
          </nav>
        </header>
        <article className="legal-card">
          <h1 className="legal-title">{title}</h1>
          <p className="legal-updated">Last updated: September 10, 2026</p>
          <div className="legal-content">{children}</div>
        </article>
      </div>
      <footer className="login-footer">
        <span>© {new Date().getFullYear()} AdNexus · MediaMonetix</span>
      </footer>
    </div>
  );
}
