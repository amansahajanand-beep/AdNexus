/**
 * Threshold alerts — toast + optional dismissible banners.
 * Cooldown per alert key so we don't spam on every reload.
 */

import { showToast } from '../hooks/useToast';

const COOLDOWN_MS = 30 * 60 * 1000; // 30 min per alert key
const SESSION_PREFIX = 'adnexus.thresholdAlert:';

function recentlyFired(key) {
  try {
    const raw = sessionStorage.getItem(SESSION_PREFIX + key);
    if (!raw) return false;
    const t = Number(raw);
    return Number.isFinite(t) && Date.now() - t < COOLDOWN_MS;
  } catch {
    return false;
  }
}

function markFired(key) {
  try {
    sessionStorage.setItem(SESSION_PREFIX + key, String(Date.now()));
  } catch {
    /* ignore */
  }
}

/**
 * ROI: alert when spend or expense ROI is below 0%.
 * Returns list of banner items for in-page display.
 */
export function evaluateRoiThresholds(summary = {}) {
  const banners = [];
  const spend = summary.roiSpendPercent;
  const exp = summary.roiExpensePercent;

  if (spend != null && !Number.isNaN(Number(spend)) && Number(spend) < 0) {
    const key = 'roi-spend-neg';
    banners.push({
      id: key,
      tone: 'danger',
      title: 'ROI on spend is negative',
      message: `ROI on spend is ${Number(spend).toFixed(1)}% for this range (below 0%).`,
    });
    if (!recentlyFired(key)) {
      markFired(key);
      showToast({
        message: `Alert: ROI on spend is ${Number(spend).toFixed(1)}% (below 0%)`,
        timeout: 7000,
      });
    }
  }

  if (exp != null && !Number.isNaN(Number(exp)) && Number(exp) < 0) {
    const key = 'roi-exp-neg';
    banners.push({
      id: key,
      tone: 'danger',
      title: 'ROI on expenses is negative',
      message: `ROI on expenses is ${Number(exp).toFixed(1)}% for this range (below 0%).`,
    });
    if (!recentlyFired(key)) {
      markFired(key);
      showToast({
        message: `Alert: ROI on expenses is ${Number(exp).toFixed(1)}% (below 0%)`,
        timeout: 7000,
      });
    }
  }

  return banners;
}

/**
 * Dashboard/Reporting: alert when revenue vs compare period drops more than 20%.
 * revenueChange is a percent (e.g. -25 means −25%).
 */
export function evaluateRevenueDropThreshold(revenueChange, compareLabel = 'vs prior period') {
  const banners = [];
  if (revenueChange == null || Number.isNaN(Number(revenueChange))) return banners;
  const ch = Number(revenueChange);
  if (ch > -20) return banners;

  const key = 'rev-drop-20';
  banners.push({
    id: key,
    tone: 'danger',
    title: 'Revenue drop over 20%',
    message: `Revenue is down ${Math.abs(ch).toFixed(1)}% ${compareLabel}.`,
  });
  if (!recentlyFired(key)) {
    markFired(key);
    showToast({
      message: `Alert: Revenue down ${Math.abs(ch).toFixed(1)}% ${compareLabel}`,
      timeout: 7000,
    });
  }
  return banners;
}

export default {
  evaluateRoiThresholds,
  evaluateRevenueDropThreshold,
};
