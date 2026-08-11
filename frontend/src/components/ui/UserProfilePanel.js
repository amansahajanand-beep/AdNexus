import React, { useState, useEffect, useMemo } from 'react';
import { useDispatch } from 'react-redux';
import { TextField, PasswordField } from './Field';
import Button from './Button';
import { validatePassword, PASSWORD_RULES_HINT } from '../../utils/passwordPolicy';
import { sessionAPI } from '../../utils/api';
import { authSuccess } from '../../store/actions/authActions';
import { getUserFacingMessage, logErrorForDebug } from '../../utils/userFacingError';

function formatWhen(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function roleLabel(role) {
  if (role === 'admin') return 'Admin';
  if (role === 'child') return 'Domain User';
  return role || '—';
}

function userInitials(username = '') {
  const parts = String(username).trim().split(/[._\s-]+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export default function UserProfilePanel({ user, layout = 'card' }) {
  const dispatch = useDispatch();
  const isPage = layout === 'page';
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changePassword, setChangePassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const initials = useMemo(() => userInitials(user?.username), [user?.username]);

  useEffect(() => {
    setUsername(user?.username || '');
    setEmail(user?.email || '');
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setChangePassword(false);
    setError(null);
  }, [user?.id]);

  useEffect(() => {
    setUsername(user?.username || '');
    setEmail(user?.email || '');
  }, [user?.username, user?.email]);

  const submit = async () => {
    setError(null);
    setSuccess(null);
    const name = username.trim();
    const mail = email.trim();
    const origName = (user?.username || '').trim();
    const origMail = (user?.email || '').trim();
    const usernameChanged = name !== origName;
    const emailChanged = mail !== origMail;
    const passwordChangeRequested = changePassword
      && Boolean(String(newPassword).trim() || String(confirmPassword).trim() || String(currentPassword).trim());

    if (usernameChanged) {
      if (!name) {
        setError('Username is required.');
        return;
      }
    }
    if (emailChanged) {
      if (!mail) {
        setError('Email is required.');
        return;
      }
      if (!/^[^\s@]+@[^\s@]+(\.[^\s@]+)?$/.test(mail)) {
        setError('Enter a valid email address.');
        return;
      }
    }
    if (passwordChangeRequested) {
      if (!currentPassword) {
        setError('Enter your current password to change password. If you don\'t remember it, contact your admin to reset it.');
        return;
      }
      if (!newPassword) {
        setError('Enter a new password.');
        return;
      }
      if (newPassword !== confirmPassword) {
        setError('New password and confirm password must match.');
        return;
      }
      const check = validatePassword(newPassword, { username: name || origName });
      if (!check.valid) {
        setError(check.errors[0]);
        return;
      }
    }

    const payload = {};
    if (usernameChanged) payload.username = name;
    if (emailChanged) payload.email = mail;
    if (newPassword) {
      payload.currentPassword = currentPassword;
      payload.newPassword = newPassword;
    }
    if (!Object.keys(payload).length) {
      setSuccess('No changes to save.');
      return;
    }

    setSaving(true);
    try {
      const res = await sessionAPI.updateProfile(payload);
      const updated = res?.user || res;
      if (!updated?.id) {
        throw new Error('Profile update did not return user data.');
      }
      dispatch(authSuccess(updated));
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setChangePassword(false);
      const savedPassword = Boolean(payload.newPassword);
      const savedFields = [
        payload.username && 'username',
        payload.email && 'email',
        savedPassword && 'password',
      ].filter(Boolean);
      setSuccess(
        savedPassword && savedFields.length === 1
          ? 'Password updated successfully.'
          : `Profile updated successfully${savedFields.length ? ` (${savedFields.join(', ')})` : ''}.`
      );
    } catch (err) {
      logErrorForDebug(err, 'Profile update');
      setError(
        err?.technicalMessage
        || getUserFacingMessage(err, 'Could not update profile. Please try again.')
      );
    } finally {
      setSaving(false);
    }
  };

  const toggleChangePassword = (enabled) => {
    setChangePassword(enabled);
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    if (enabled) setError(null);
  };

  if (!user) return null;

  const rootClass = isPage
    ? 'profile-page-shell'
    : 'filter-card profile-card';

  return (
    <div className={rootClass}>
      <div className={`profile-hero ${isPage ? 'profile-hero--page' : ''}`}>
        <div className="profile-hero-main">
          <div className="profile-avatar" aria-hidden>{initials}</div>
          <div className="profile-hero-text">
            <h2 className="profile-hero-title">{user.username}</h2>
            <p className="profile-hero-sub">{user.email || 'No email set'}</p>
            <span className="profile-role-badge">{roleLabel(user.role)}</span>
          </div>
        </div>
        {isPage && (
          <p className="profile-hero-desc">
            Update any field you need — username, email, or password — one at a time or all together, then save.
          </p>
        )}
      </div>

      {error && <div className="login-error profile-alert">{error}</div>}
      {success && <div className="success-box profile-alert">{success}</div>}

      <div className={`profile-card-grid ${isPage ? 'profile-card-grid--page' : ''}`}>
        <section className="profile-panel profile-panel--info">
          <h3 className="profile-panel-title">Account info</h3>
          <div className="profile-meta-list">
            <div className="profile-meta-item">
              <span className="profile-meta-icon" aria-hidden>📅</span>
              <div>
                <span className="profile-readonly-label">Member since</span>
                <span className="profile-readonly-value">{formatWhen(user.createdAt)}</span>
              </div>
            </div>
            <div className="profile-meta-item">
              <span className="profile-meta-icon" aria-hidden>🕐</span>
              <div>
                <span className="profile-readonly-label">Last login</span>
                <span className="profile-readonly-value">{formatWhen(user.lastLogin)}</span>
              </div>
            </div>
            <div className="profile-meta-item">
              <span className="profile-meta-icon" aria-hidden>✓</span>
              <div>
                <span className="profile-readonly-label">Status</span>
                <span className="profile-readonly-value profile-status-active">Active</span>
              </div>
            </div>
          </div>
        </section>

        <section className="profile-panel profile-panel--form">
          <h3 className="profile-panel-title">Edit profile</h3>
          <div className="profile-form">
            <div className="profile-form-row">
              <TextField label="Username" value={username} onChange={setUsername} placeholder="Username" />
              <TextField label="Email" type="email" value={email} onChange={setEmail} placeholder="you@example.com" />
            </div>
          </div>
        </section>

        <section className="profile-panel profile-panel--security">
          <div className="profile-panel-head">
            <h3 className="profile-panel-title">Change password</h3>
            <label className="profile-pw-change-toggle">
              <input
                type="checkbox"
                checked={changePassword}
                onChange={(e) => toggleChangePassword(e.target.checked)}
              />
              <span>I want to change my password</span>
            </label>
          </div>
          <p className="form-note profile-pw-note">
            {changePassword
              ? 'Enter your current password, then choose a new one.'
              : 'Your password is saved securely and shown as ••••••••.'}
          </p>
          <div className="profile-pw-admin-notice" role="note">
            <span className="profile-pw-admin-notice-icon" aria-hidden>ℹ️</span>
            <p>
              If you don&apos;t remember your current password, please contact your admin to change or reset it.
            </p>
          </div>
          {/* Trap browser autofill so saved login password is not injected into these fields */}
          <div className="profile-autofill-trap" aria-hidden="true">
            <input type="text" name="username" tabIndex={-1} autoComplete="username" />
            <input type="password" name="password" tabIndex={-1} autoComplete="current-password" />
          </div>
          <form
            className="profile-form profile-form--password"
            autoComplete="off"
            onSubmit={(e) => e.preventDefault()}
          >
            <PasswordField
              label="Current password"
              value={changePassword ? currentPassword : '••••••••'}
              onChange={setCurrentPassword}
              placeholder={changePassword ? 'Enter current password' : '••••••••'}
              autoComplete="off"
              name="profile-current-password"
              locked={!changePassword}
              disabled={!changePassword}
            />
            <div className={`profile-form-row${changePassword ? '' : ' profile-form-row--disabled'}`}>
              <PasswordField
                label="New password"
                value={newPassword}
                onChange={setNewPassword}
                placeholder="••••••••"
                autoComplete="new-password"
                name="profile-new-password"
                allowReveal
                disabled={!changePassword}
              />
              <PasswordField
                label="Confirm new password"
                value={confirmPassword}
                onChange={setConfirmPassword}
                placeholder="••••••••"
                autoComplete="new-password"
                name="profile-confirm-password"
                allowReveal
                disabled={!changePassword}
              />
            </div>
            {changePassword && (
              <p className="form-note profile-pw-hint">{PASSWORD_RULES_HINT}</p>
            )}
          </form>
        </section>
      </div>

      <div className="profile-form-actions profile-form-actions--footer">
        <Button variant="primary" onClick={submit} loading={saving}>Save changes</Button>
      </div>
    </div>
  );
}
