/**
 * Domain / channel catalogue used by the permission pickers
 * (Add User → Domain Access, Edit Channel Permissions, Domain Permissions tab).
 * Mounted at /api/domains. Requires an authenticated user.
 *
 * Returns: [{ id, label, domainName, appId, site }] — id/label = root domain name
 *   - Mock mode: sample list matching mock report data.
 *   - Live mode: derived from cached GAM report rows (no extra Inventory API call).
 */
const express = require('express');
const router = express.Router();
const { cache } = require('../gam/client');
const { requireAuth } = require('../middleware/auth');
const logger = require('../utils/logger');
const { findCachedInventoryRows, rowsToDomainOptions, isLegacyAdUnitCatalog } = require('../utils/inventoryCatalog');

const { isMockClient } = require('../utils/clientContext');

function mockDomains() {
  const { resolveInventoryFields } = require('../utils/adUnit');
  const sites = [
    { appId: 'com.arena.hub', site: 'arenahubply.com_inter (23353334942)', siteUrl: 'arenahubply.com' },
    { appId: 'com.arena.hub', site: 'arenahubply.com_d1 (23353334943)', siteUrl: 'm.arenahubply.com' },
    { appId: 'com.arena.hub', site: 'arenahubply.com_d2 (23353334944)', siteUrl: 'amp.arenahubply.com' },
    { appId: 'com.freez.games', site: 'Freezgames.com_inter (23339683599)', siteUrl: 'freezgames.com' },
    { appId: 'com.freez.games', site: 'Freezgames.com_rewarded (23339683600)', siteUrl: 'play.freezgames.com' },
    { appId: 'com.news.dailyfeed', site: 'newsdaily.com_top (23341110021)', siteUrl: 'newsdaily.com' },
    { appId: 'com.news.dailyfeed', site: 'newsdaily.com_side (23341110022)', siteUrl: 'in.newsdaily.com' },
    { appId: 'com.shop.dealsnow', site: 'dealsnow.com_home (23344550010)', siteUrl: 'dealsnow.com' },
    { appId: 'com.video.streamhub', site: 'streamhub.com_pre (23346770088)', siteUrl: 'watch.streamhub.com' },
  ];
  const seen = new Set();
  const out = [];
  sites.forEach((s) => {
    const { domainName } = resolveInventoryFields(s.site, s.siteUrl);
    if (!domainName || seen.has(domainName)) return;
    seen.add(domainName);
    out.push({
      id: domainName,
      label: domainName,
      domainName,
      appId: s.appId,
      site: s.site,
    });
  });
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

router.get('/', requireAuth, async (req, res) => {
  if (isMockClient()) {
    return res.json(mockDomains());
  }

  const cachedKey = 'domains_catalogue_v6';
  const cached = cache.get(cachedKey);
  if (cached?.length && !isLegacyAdUnitCatalog(cached)) return res.json(cached);

  try {
    const rows = findCachedInventoryRows(cache);
    if (rows?.length) {
      const domains = rowsToDomainOptions(rows);
      cache.set(cachedKey, domains, 600);
      return res.json(domains);
    }

    // No report cache yet — return empty; Admin can refresh after a report loads.
    logger.info('Domains catalogue: no cached inventory rows yet');
    res.json([]);
  } catch (err) {
    logger.error('Domains catalogue error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
