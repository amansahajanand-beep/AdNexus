import React, { useState, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../store/useAuth';
import { TextField } from '../components/ui/Field';
import Button from '../components/ui/Button';
import { BrandMark } from '../components/ui/BrandLogo';
import { getUserFacingMessage, logErrorForDebug } from '../utils/userFacingError';
import { User, Lock } from '../components/ui/Icon';

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
      <div className="login-body">
        <form
          key={formKey}
          className="login-card"
          onSubmit={submit}
          noValidate
          autoComplete="off"
        >
          <div className="login-brand-row">
            <BrandMark size={40} className="login-logo" />
            <span className="login-brand-name">AdNexus</span>
          </div>
          <h2 className="login-title">Sign in</h2>
          <p className="login-sub">Welcome back. Sign in to continue to AdNexus.</p>

          {displayError && <div className="login-error">{displayError}</div>}

          <TextField
            label="Username"
            value={username}
            onChange={setUsername}
            placeholder="Enter your username"
            autoFocus
            autoComplete="off"
            name="gam-username"
            leadingIcon={<User size={16} strokeWidth={1.75} />}
          />
          <TextField
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            placeholder="Enter your password"
            autoComplete="new-password"
            name="gam-password"
            leadingIcon={<Lock size={16} strokeWidth={1.75} />}
          />

          <Button type="submit" variant="primary" loading={loading} className="login-submit">
            Sign in
          </Button>
          <p className="onboard-login-link">
            New publisher? <Link to="/onboard">Register with GAM credentials</Link>
          </p>
        </form>
      </div>
      <footer className="login-footer">
        <span>© {new Date().getFullYear()} AdNexus</span>
      </footer>
    </div>
  );
}
