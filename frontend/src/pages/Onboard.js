import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { TextField } from '../components/ui/Field';
import Button from '../components/ui/Button';
import BrandLogo, { BrandMark } from '../components/ui/BrandLogo';
import { clientsAPI } from '../utils/api';
import { getUserFacingMessage, logErrorForDebug } from '../utils/userFacingError';
import {
  validateSavedName,
  validateUsername,
  SAVED_NAME_RULES_HINT,
  USERNAME_RULES_HINT,
} from '../utils/namePolicy';
import { validatePassword, PASSWORD_RULES_HINT } from '../utils/passwordPolicy';

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

    const publisherCheck = validateSavedName(form.name, { maxLength: 80, label: 'Publisher name' });
    if (!publisherCheck.valid) {
      setError(publisherCheck.errors[0]);
      return;
    }
    const usernameCheck = validateUsername(form.username);
    if (!usernameCheck.valid) {
      setError(usernameCheck.errors[0]);
      return;
    }
    const passwordCheck = validatePassword(form.password, { username: form.username.trim() });
    if (!passwordCheck.valid) {
      setError(passwordCheck.errors[0]);
      return;
    }

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
          <p className="login-sub">Connect Google Ad Manager credentials to start publisher analytics.</p>
          {error && <div className="login-error">{error}</div>}

          <TextField label="Publisher name" value={form.name} onChange={set('name')} placeholder="Acme Media" autoFocus />
          <p className="form-note" style={{ marginTop: -8 }}>{SAVED_NAME_RULES_HINT}</p>
          <TextField label="GAM network code" value={form.networkCode} onChange={set('networkCode')} placeholder="12345678" />
          <TextField label="Google client ID" value={form.googleClientId} onChange={set('googleClientId')} placeholder="....apps.googleusercontent.com" />
          <TextField label="Google client secret" type="password" value={form.googleClientSecret} onChange={set('googleClientSecret')} />
          <TextField label="Google refresh token" type="password" value={form.refreshToken} onChange={set('refreshToken')} />
          <TextField label="Admin username" value={form.username} onChange={set('username')} />
          <p className="form-note" style={{ marginTop: -8 }}>{USERNAME_RULES_HINT}</p>
          <TextField label="Admin email" value={form.email} onChange={set('email')} placeholder="you@company.com" />
          <TextField label="Admin password" type="password" value={form.password} onChange={set('password')} />
          <p className="form-note" style={{ marginTop: -8 }}>{PASSWORD_RULES_HINT}</p>

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
