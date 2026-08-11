import React, { useEffect, useState } from 'react';
import { TextField } from '../ui/Field';
import Button from '../ui/Button';
import { clientsAPI } from '../../utils/api';
import { getUserFacingMessage, logErrorForDebug } from '../../utils/userFacingError';

export default function ClientSettings() {
  const [info, setInfo] = useState(null);
  const [form, setForm] = useState({
    name: '',
    networkCode: '',
    googleClientId: '',
    googleClientSecret: '',
    refreshToken: '',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await clientsAPI.me();
      setInfo(data);
      setForm({
        name: data.name || '',
        networkCode: data.networkCode || '',
        googleClientId: data.googleClientId || '',
        googleClientSecret: '',
        refreshToken: '',
      });
    } catch (err) {
      logErrorForDebug(err, 'Client settings');
      setError(getUserFacingMessage(err, 'Could not load client settings.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('oauth') === 'connected') setSaved(true);
    if (params.get('oauth') === 'error') setError('Google OAuth failed. Try Connect Google again.');
  }, []);

  const set = (key) => (value) => setForm((prev) => ({ ...prev, [key]: value }));

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const payload = {
        name: form.name,
        networkCode: form.networkCode,
        googleClientId: form.googleClientId,
      };
      if (form.googleClientSecret) payload.googleClientSecret = form.googleClientSecret;
      if (form.refreshToken) payload.refreshToken = form.refreshToken;
      const data = await clientsAPI.updateMe(payload);
      setInfo(data);
      setForm((prev) => ({ ...prev, googleClientSecret: '', refreshToken: '' }));
      setSaved(true);
    } catch (err) {
      logErrorForDebug(err, 'Client settings save');
      setError(getUserFacingMessage(err, 'Could not save credentials.'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="spinner" />;

  return (
    <form className="client-settings-card" onSubmit={submit}>
      <p className="reporting-sub">
        Connection: {info?.hasRefreshToken ? 'Configured' : 'Missing refresh token'}
        {info?.isMock ? ' · mock / not live' : ' · live'}
        {info?.networkCode ? ` · network ${info.networkCode}` : ''}
      </p>
      {error && <div className="login-error">{error}</div>}
      {saved && <div className="client-settings-ok">Credentials saved.</div>}
      <TextField label="Publisher name" value={form.name} onChange={set('name')} />
      <TextField label="GAM network code" value={form.networkCode} onChange={set('networkCode')} />
      <TextField label="Google client ID" value={form.googleClientId} onChange={set('googleClientId')} />
      <TextField label="Google client secret (leave blank to keep)" type="password" value={form.googleClientSecret} onChange={set('googleClientSecret')} />
      <TextField label="Google refresh token (leave blank to keep)" type="password" value={form.refreshToken} onChange={set('refreshToken')} />
      <Button type="submit" variant="primary" loading={saving}>Save credentials</Button>
      <Button
        type="button"
        variant="secondary"
        loading={connecting}
        onClick={async () => {
          setConnecting(true);
          setError(null);
          try {
            const { url } = await clientsAPI.oauthUrl();
            window.location.href = url;
          } catch (err) {
            logErrorForDebug(err, 'Connect Google');
            setError(getUserFacingMessage(err, 'Could not start Google OAuth. Save client ID and secret first.'));
            setConnecting(false);
          }
        }}
      >
        Connect Google (get refresh token)
      </Button>
    </form>
  );
}
