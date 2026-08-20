import React, { useEffect, useState } from 'react';
import { TextField } from '../ui/Field';
import Button from '../ui/Button';
import { clientsAPI } from '../../utils/api';
import { getUserFacingMessage, logErrorForDebug } from '../../utils/userFacingError';

const MASK = '••••••••';

export default function ClientSettings() {
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [connecting, setConnecting] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await clientsAPI.me();
      setInfo(data);
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
    if (params.get('oauth') === 'error') setError('Google OAuth failed. Try Connect Google again.');
  }, []);

  if (loading) return <div className="spinner" />;

  return (
    <div className="client-settings-wrap">
      <div className="client-settings-card">
        <p className="reporting-sub">
          Connection: {info?.hasRefreshToken ? 'Configured' : 'Missing refresh token'}
          {info?.isMock ? ' · mock / not live' : ' · live'}
          {info?.networkCode ? ` · network ${info.networkCode}` : ''}
        </p>
        {error && <div className="login-error">{error}</div>}
        <TextField label="Publisher name" value={info?.name || ''} readOnly />
        <TextField label="GAM network code" value={info?.networkCode || ''} readOnly />
        <TextField label="Google client ID" value={info?.googleClientId || ''} readOnly />
        <TextField label="Google client secret" value={MASK} readOnly />
        <TextField label="Google refresh token" value={MASK} readOnly />
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
              setError(getUserFacingMessage(err, 'Could not start Google OAuth.'));
              setConnecting(false);
            }
          }}
        >
          Connect Google (get refresh token)
        </Button>
      </div>
    </div>
  );
}
