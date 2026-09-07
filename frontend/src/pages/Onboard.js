import React, { useEffect, useState } from 'react';
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
    username: '',
    email: '',
    password: '',
  });
  const [error, setError] = useState(null);
  const [okMsg, setOkMsg] = useState(null);
  const [loading, setLoading] = useState(false);
  const [picker, setPicker] = useState(null);
  const [pickingCode, setPickingCode] = useState(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [advanced, setAdvanced] = useState({
    networkCode: '',
    googleClientId: '',
    googleClientSecret: '',
    refreshToken: '',
  });

  const set = (key) => (value) => setForm((prev) => ({ ...prev, [key]: value }));

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauth = params.get('oauth');
    if (oauth === 'error') {
      setError(`Google OAuth failed${params.get('reason') ? `: ${params.get('reason')}` : ''}`);
    } else if (oauth === 'connected') {
      setOkMsg('GAM connected. Sign in with your admin account.');
      setTimeout(() => navigate('/login', { replace: true, state: { resetKey: Date.now() } }), 1200);
    } else if (oauth === 'pick') {
      const sessionId = params.get('session');
      if (sessionId) {
        setLoading(true);
        clientsAPI.onboardOauthPending(sessionId)
          .then((data) => {
            setPicker({ sessionId: data.sessionId, networks: data.networks || [] });
            if (data.publisherName) setForm((f) => ({ ...f, name: data.publisherName }));
          })
          .catch((err) => {
            setError(getUserFacingMessage(err, 'Could not load GAM networks.'));
          })
          .finally(() => setLoading(false));
      }
    }
    if (oauth) {
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [navigate]);

  const connectWithGoogle = async (e) => {
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
      const { url } = await clientsAPI.onboardOauthStart({
        name: form.name,
        username: form.username,
        email: form.email,
        password: form.password,
      });
      window.location.href = url;
    } catch (err) {
      logErrorForDebug(err, 'Onboard OAuth');
      setError(getUserFacingMessage(err, 'Could not start Google connection.'));
      setLoading(false);
    }
  };

  const selectNetwork = async (networkCode) => {
    if (!picker?.sessionId) return;
    setPickingCode(networkCode);
    setError(null);
    try {
      await clientsAPI.onboardOauthSelect({ sessionId: picker.sessionId, networkCode });
      setOkMsg('Account created. Redirecting to sign in…');
      navigate('/login', { replace: true, state: { resetKey: Date.now() } });
    } catch (err) {
      setError(getUserFacingMessage(err, 'Could not complete onboarding.'));
    } finally {
      setPickingCode(null);
    }
  };

  const submitAdvanced = async (e) => {
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
      <header className="login-topbar">
        <div className="header-left">
          <BrandLogo />
        </div>
      </header>
      <div className="login-body">
        <form
          className="login-card onboard-card"
          onSubmit={picker ? (e) => e.preventDefault() : (showAdvanced ? submitAdvanced : connectWithGoogle)}
          noValidate
          autoComplete="off"
        >
          <BrandMark size={56} className="login-logo" />
          <h2 className="login-title">Register your GAM network</h2>
          <p className="login-sub">
            {picker
              ? 'Choose the Ad Manager network to connect.'
              : 'Create your admin account, then Connect with Google to fetch your network automatically.'}
          </p>
          {error && <div className="login-error">{error}</div>}
          {okMsg && <div className="client-settings-ok">{okMsg}</div>}

          {picker ? (
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table className="data-table report-table report-table--comfortable">
                <thead>
                  <tr>
                    <th>Network</th>
                    <th>Code</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {(picker.networks || []).map((n) => (
                    <tr key={n.networkCode}>
                      <td>{n.displayName || n.networkCode}</td>
                      <td className="td-mono">{n.networkCode}</td>
                      <td>
                        <Button
                          type="button"
                          variant="primary"
                          loading={pickingCode === n.networkCode}
                          disabled={!!pickingCode}
                          onClick={() => selectNetwork(n.networkCode)}
                        >
                          Select
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <>
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
                {showAdvanced ? 'Create account' : 'Connect with Google'}
              </Button>
              <button
                type="button"
                className="link-action"
                style={{ marginTop: 12, background: 'none', border: 0, cursor: 'pointer' }}
                onClick={() => setShowAdvanced((v) => !v)}
              >
                {showAdvanced ? 'Use Connect with Google instead' : 'Advanced: paste credentials manually'}
              </button>
            </>
          )}

          <p className="onboard-login-link">
            Already registered? <Link to="/login">Sign in</Link>
          </p>
        </form>
      </div>
    </div>
  );
}
