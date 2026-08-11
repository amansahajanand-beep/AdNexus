import { resolveDateRestriction } from './dateRestriction';

/** Read assigned date window from user permissions for admin form. */
export function readDateRestrictionFromUser(user) {
  const resolved = resolveDateRestriction(user?.permissions?.dateRestriction);
  if (!resolved) return { start: '', end: '' };
  return { start: resolved.startDate, end: resolved.endDate };
}

export function dateRestrictionPayload(start, end) {
  return {
    dateRestrictionStart: start || '',
    dateRestrictionEnd: end || '',
  };
}

export function formatDateRestrictionForSummary(dr) {
  const resolved = resolveDateRestriction(dr);
  if (!resolved) return '';
  if (resolved.startDate === resolved.endDate) return resolved.startDate;
  return `${resolved.startDate} → ${resolved.endDate}`;
}
