import React, { useState, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../store/useAuth';
import { TextField } from '../components/ui/Field';
import Button from '../components/ui/Button';
import BrandLogo, { BrandMark } from '../components/ui/BrandLogo';
import { getUserFacingMessage, logErrorForDebug } from '../utils/userFacingError';

export default function Login() {
  const { login, error: authError } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const formKey = location.state?.resetKey || 'login';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState(null);
  const [loading, setLoading] = useState(false);

  const displayError = localError || authError;

  useEffect(() => {
    setUsername('');
    setPassword('');
    setLocalError(null);
  }, [formKey]);

  const submit = async (e) => {
    e.preventDefault();
    setLocalError(null);

    if (!username.trim() || !password) {
      setLocalError('Username and password are required.');
      return;
    }

    setLoading(true);
    const pwd = password;
    setPassword('');
    try {
      await login(username.trim(), pwd);
      setUsername('');
      const dest = location.state?.from?.pathname || '/dashboard';
      navigate(dest, { replace: true });
    } catch (err) {
      logErrorForDebug(err, 'Login');
      setLocalError(getUserFacingMessage(err, 'Invalid username or password. Please try again.'));
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
          key={formKey}
          className="login-card"
          onSubmit={submit}
          noValidate
          autoComplete="off"
        >
          <BrandMark size={56} className="login-logo" />
          <h2 className="login-title">Sign in to AdNexus</h2>
          <p className="login-sub">Publisher Analytics for revenue, inventory, and performance</p>

          {displayError && <div className="login-error">{displayError}</div>}

          <TextField
            label="Username"
            value={username}
            onChange={setUsername}
            placeholder="Enter your username"
            autoFocus
            autoComplete="off"
            name="gam-username"
          />
          <TextField
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            placeholder="Enter your password"
            autoComplete="new-password"
            name="gam-password"
          />

          <Button type="submit" variant="primary" loading={loading} className="login-submit">
            Login
          </Button>
          <p className="onboard-login-link">
            New publisher? <Link to="/onboard">Register with GAM credentials</Link>
          </p>
        </form>
      </div>
    </div>
  );
}
