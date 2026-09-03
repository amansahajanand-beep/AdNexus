import { formatDateRestrictionForSummary } from '../adminDateRestriction';
import { resolveDateRestriction } from '../dateRestriction';
import { PERMISSION_SECTIONS } from './permissions';

const ALL_PERM_ITEMS = [
  ...PERMISSION_SECTIONS.pages,
  ...PERMISSION_SECTIONS.actions,
  ...PERMISSION_SECTIONS.metrics,
];

function diffLists(oldArr = [], newArr = []) {
  const oldSet = new Set((oldArr || []).map((v) => String(v)));
  const newSet = new Set((newArr || []).map((v) => String(v)));
  return {
    added: [...newSet].filter((x) => !oldSet.has(x)),
    removed: [...oldSet].filter((x) => !newSet.has(x)),
  };
}

/** Summary after saving permissions (flags + domains + sites + app IDs + ads accounts + date limit). */
export function buildPermissionSaveSummary(username, oldUser, newPayload = {}, opts = {}) {
  const oldPerms = oldUser?.permissions || {};
  const added = [];
  const removed = [];
  const adsLabel = (id) => (opts.adsAccountLabelById && opts.adsAccountLabelById[id]) || id;

  const { added: domAdd, removed: domRem } = diffLists(
    oldPerms.allowedDomains,
    newPayload.allowedDomains
  );
  domAdd.forEach((d) => added.push(`Domain: ${d}`));
  domRem.forEach((d) => removed.push(`Domain: ${d}`));

  const { added: siteAdd, removed: siteRem } = diffLists(
    oldPerms.allowedSites,
    newPayload.allowedSites
  );
  siteAdd.forEach((s) => added.push(`Site: ${s}`));
  siteRem.forEach((s) => removed.push(`Site: ${s}`));

  const { added: appAdd, removed: appRem } = diffLists(
    oldPerms.allowedAppIds,
    newPayload.allowedAppIds
  );
  appAdd.forEach((a) => added.push(`App ID: ${a}`));
  appRem.forEach((a) => removed.push(`App ID: ${a}`));

  const { added: adsAdd, removed: adsRem } = diffLists(
    oldPerms.allowedAdsAccountIds,
    newPayload.allowedAdsAccountIds
  );
  adsAdd.forEach((a) => added.push(`Ads account: ${adsLabel(a)}`));
  adsRem.forEach((a) => removed.push(`Ads account: ${adsLabel(a)}`));

  ALL_PERM_ITEMS.forEach((p) => {
    const wasTrue = typeof oldPerms[p.key] === 'boolean'
      ? oldPerms[p.key]
      : true;
    const isNow = newPayload[p.key] === true;
    if (!wasTrue && isNow) added.push(`Permission: ${p.label}`);
    if (wasTrue && !isNow) removed.push(`Permission: ${p.label}`);
  });

  const oldDr = resolveDateRestriction(oldPerms.dateRestriction);
  const newDr = resolveDateRestriction({
    startDate: newPayload.dateRestrictionStart,
    endDate: newPayload.dateRestrictionEnd,
    maxDaysBack: newPayload.maxDaysBack,
  });
  const oldLabel = formatDateRestrictionForSummary(oldPerms.dateRestriction);
  const newLabel = formatDateRestrictionForSummary({
    startDate: newPayload.dateRestrictionStart,
    endDate: newPayload.dateRestrictionEnd,
    maxDaysBack: newPayload.maxDaysBack,
  });
  if (oldLabel !== newLabel) {
    if (newLabel && !oldLabel) added.push(`Date range: ${newLabel}`);
    else if (!newLabel && oldLabel) removed.push(`Date range: ${oldLabel}`);
    else {
      if (oldLabel) removed.push(`Date range: ${oldLabel}`);
      if (newLabel) added.push(`Date range: ${newLabel}`);
    }
  }

  return { username, added, removed };
}

/** Summary after editing a user from the user form. */
export function buildUserEditSummary(oldUser, newPayload = {}) {
  const username = newPayload.username || oldUser?.username;
  const changes = [];

  if (newPayload.password) {
    changes.push({ type: 'info', text: 'Password updated' });
  }
  if (oldUser?.role && newPayload.role && oldUser.role !== newPayload.role) {
    changes.push({ type: 'info', text: `Role: ${oldUser.role} → ${newPayload.role}` });
  }

  if (newPayload.role !== 'admin') {
    const { added, removed } = buildPermissionSaveSummary(username, oldUser, newPayload);
    added.forEach((text) => changes.push({ type: 'added', text }));
    removed.forEach((text) => changes.push({ type: 'removed', text }));
  }

  return { username, changes };
}

/** Initial inventory assigned when creating a new child user. */
export function buildNewUserInventorySummary(payload = {}) {
  const changes = [];
  (payload.allowedDomains || []).forEach((d) => changes.push({ type: 'added', text: `Domain: ${d}` }));
  (payload.allowedSites || []).forEach((s) => changes.push({ type: 'added', text: `Site: ${s}` }));
  (payload.allowedAppIds || []).forEach((a) => changes.push({ type: 'added', text: `App ID: ${a}` }));
  (payload.allowedAdsAccountIds || []).forEach((a) => changes.push({ type: 'added', text: `Ads account: ${a}` }));
  const drLabel = formatDateRestrictionForSummary({
    startDate: payload.dateRestrictionStart,
    endDate: payload.dateRestrictionEnd,
    maxDaysBack: payload.maxDaysBack,
  });
  if (drLabel) {
    changes.push({ type: 'added', text: `Date range: ${drLabel}` });
  }
  return changes;
}
