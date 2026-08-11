import React from 'react';
import UserProfilePanel from './ui/UserProfilePanel';
import { usePermissions } from '../hooks/usePermissions';

export default function DomainUser() {
  const { user } = usePermissions();

  return (
    <div className="dashboard-page domain-user-page domain-user-profile-page">
      <UserProfilePanel user={user} layout="page" />
    </div>
  );
}
