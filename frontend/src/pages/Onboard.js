import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { TextField } from '../components/ui/Field';
import Button from '../components/ui/Button';
import { BrandMark } from '../components/ui/BrandLogo';
import { clientsAPI } from '../utils/api';
import { getUserFacingMessage, logErrorForDebug } from '../utils/userFacingError';
import {
  validateSavedName,
  validateUsername,
  SAVED_NAME_RULES_HINT,
  USERNAME_RULES_HINT,
} from '../utils/namePolicy';
import { validatePassword, PASSWORD_RULES_HINT } from '../utils/passwordPolicy';
import { UserRound } from 'lucide-react';

export default function Onboard() {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: '',
    username: '',
    email: '',
    password: '',
  });
  const [error, setError] = useState(null);
  const [okMsg, setOkMsg] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [advanced, setAdvanced] = useState({
    networkCode: '',
    googleClientId: '',
    googleClientSecret: '',
    refreshToken: '',
  });

  const set = (key) => (value) => setForm((prev) => ({ ...prev, [key]: value }));

  const validateAccountFields = () => {
    const publisherCheck = validateSavedName(form.name, { maxLength: 80, label: 'Publisher name' });
    if (!publisherCheck.valid) {
      setError(publisherCheck.errors[0]);
      return false;
    }
    const usernameCheck = validateUsername(form.username);
    if (!usernameCheck.valid) {
      setError(usernameCheck.errors[0]);
      return false;
    }
    const passwordCheck = validatePassword(form.password, { username: form.username.trim() });
    if (!passwordCheck.valid) {
      setError(passwordCheck.errors[0]);
      return false;
    }
    return true;
  };

  const registerAccount = async (e) => {
    e.preventDefault();
    setError(null);
    if (!validateAccountFields()) return;

    setLoading(true);
    try {
      await clientsAPI.register({
        name: form.name,
        username: form.username,
        email: form.email,
        password: form.password,
      });
      setOkMsg('Account created. Sign in, then connect Google Ad Manager under Admin → GAM Connection.');
      setTimeout(() => navigate('/login', { replace: true, state: { resetKey: Date.now() } }), 900);
    } catch (err) {
      logErrorForDebug(err, 'Register');
      setError(getUserFacingMessage(err, 'Could not create account.'));
    } finally {
      setLoading(false);
    }
  };

  const submitAdvanced = async (e) => {
    e.preventDefault();
    setError(null);
    if (!validateAccountFields()) return;
    setLoading(true);
    try {
      await clientsAPI.onboard({
        ...form,
        ...advanced,
      });
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
      <div className="login-body">
        <form
          className="login-card onboard-card"
          onSubmit={showAdvanced ? submitAdvanced : registerAccount}
          noValidate
          autoComplete="off"
        >
          <div className="login-brand-row">
            <BrandMark size={40} className="login-logo" />
            <span className="login-brand-name">AdNexus</span>
          </div>
          <h2 className="login-title">Create your account</h2>
          <p className="login-sub">
            Register with a publisher name and admin login. Connect Google Ad Manager later from Admin → GAM Connection.
          </p>
          <ol className="onboard-stepper" aria-label="Onboarding steps">
            <li className="onboard-step is-active">
              <span className="onboard-step-icon" aria-hidden>
                <UserRound size={14} strokeWidth={2} />
              </span>
              <span>Account</span>
            </li>
            <li className="onboard-step">
              <span className="onboard-step-icon" aria-hidden>2</span>
              <span>Connect GAM in Admin</span>
            </li>
          </ol>
          {error && <div className="login-error">{error}</div>}
          {okMsg && <div className="client-settings-ok">{okMsg}</div>}

          <TextField label="Publisher name" value={form.name} onChange={set('name')} placeholder="Acme Media" autoFocus />
          <p className="form-note" style={{ marginTop: -8 }}>{SAVED_NAME_RULES_HINT}</p>
          <TextField label="Admin username" value={form.username} onChange={set('username')} />
          <p className="form-note" style={{ marginTop: -8 }}>{USERNAME_RULES_HINT}</p>
          <TextField label="Admin email" value={form.email} onChange={set('email')} placeholder="you@company.com" />
          <TextField label="Admin password" type="password" value={form.password} onChange={set('password')} />
          <p className="form-note" style={{ marginTop: -8 }}>{PASSWORD_RULES_HINT}</p>

          {showAdvanced && (
            <>
              <TextField label="GAM network code" value={advanced.networkCode} onChange={(v) => setAdvanced((a) => ({ ...a, networkCode: v }))} placeholder="12345678" />
              <TextField label="Google client ID" value={advanced.googleClientId} onChange={(v) => setAdvanced((a) => ({ ...a, googleClientId: v }))} placeholder="....apps.googleusercontent.com" />
              <TextField label="Google client secret" type="password" value={advanced.googleClientSecret} onChange={(v) => setAdvanced((a) => ({ ...a, googleClientSecret: v }))} />
              <TextField label="Google refresh token" type="password" value={advanced.refreshToken} onChange={(v) => setAdvanced((a) => ({ ...a, refreshToken: v }))} />
            </>
          )}

          <Button type="submit" variant="primary" loading={loading} className="login-submit">
            {showAdvanced ? 'Create with credentials' : 'Create account'}
          </Button>
          <button
            type="button"
            className="link-action"
            style={{ marginTop: 12, background: 'none', border: 0, cursor: 'pointer' }}
            onClick={() => setShowAdvanced((v) => !v)}
          >
            {showAdvanced ? 'Back to simple register' : 'Advanced: paste GAM credentials now'}
          </button>

          <p className="onboard-login-link">
            Already registered? <Link to="/login">Sign in</Link>
          </p>
        </form>
      </div>
    </div>
  );
}
