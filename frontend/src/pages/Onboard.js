import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { TextField } from '../components/ui/Field';
import Button from '../components/ui/Button';
import BrandLogo, { BrandMark } from '../components/ui/BrandLogo';
import { clientsAPI } from '../utils/api';
import { getUserFacingMessage, logErrorForDebug } from '../utils/userFacingError';

export default function Onboard() {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: '',
    networkCode: '',
    googleClientId: '',
    googleClientSecret: '',
    refreshToken: '',
    username: '',
    email: '',
    password: '',
  });
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const set = (key) => (value) => setForm((prev) => ({ ...prev, [key]: value }));

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await clientsAPI.onboard(form);
      navigate('/login', { replace: true, state: { resetKey: Date.now() } });
    } catch (err) {
      logErrorForDebug(err, 'Onboard');
      setError(getUserFacingMessage(err, 'Could not complete onboarding. Check credentials and try again.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-screen login-page">
      <header className="login-topbar">
        <div className="header-left">
          <BrandLogo />
        </div>
      </header>
      <div className="login-body">
        <form className="login-card onboard-card" onSubmit={submit} noValidate autoComplete="off">
          <BrandMark size={56} className="login-logo" />
          <h2 className="login-title">Register your GAM network</h2>
          <p className="login-sub">Paste your Google Ad Manager credentials to create your publisher account.</p>
          {error && <div className="login-error">{error}</div>}

          <TextField label="Publisher name" value={form.name} onChange={set('name')} placeholder="Acme Media" autoFocus />
          <TextField label="GAM network code" value={form.networkCode} onChange={set('networkCode')} placeholder="12345678" />
          <TextField label="Google client ID" value={form.googleClientId} onChange={set('googleClientId')} placeholder="....apps.googleusercontent.com" />
          <TextField label="Google client secret" type="password" value={form.googleClientSecret} onChange={set('googleClientSecret')} />
          <TextField label="Google refresh token" type="password" value={form.refreshToken} onChange={set('refreshToken')} />
          <TextField label="Admin username" value={form.username} onChange={set('username')} />
          <TextField label="Admin email" value={form.email} onChange={set('email')} placeholder="you@company.com" />
          <TextField label="Admin password" type="password" value={form.password} onChange={set('password')} />

          <Button type="submit" variant="primary" loading={loading} className="login-submit">
            Create account
          </Button>
          <p className="onboard-login-link">
            Already registered? <Link to="/login">Sign in</Link>
          </p>
        </form>
      </div>
    </div>
  );
}
