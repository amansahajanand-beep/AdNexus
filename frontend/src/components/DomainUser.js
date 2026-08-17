import React from 'react';
import UserProfilePanel from './ui/UserProfilePanel';
import PageHeader from './ui/PageHeader';
import { usePermissions } from '../hooks/usePermissions';

export default function DomainUser() {
  const { user } = usePermissions();

  return (
    <div className="dashboard-page domain-user-page domain-user-profile-page">
      <PageHeader
        title="My Profile"
        subtitle="Account details and password"
        summary={user?.username ? `Signed in as ${user.username}` : undefined}
      />
      <UserProfilePanel user={user} layout="page" />
    </div>
  );
}
