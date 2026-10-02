/**
 * Analysis written from the detected signals alone. Used when the model is unavailable, off, or
 * when there is no data worth sending to it. It has the same shape as the model's output.
 */

/** Next steps for signals that do not carry their own. */
const DEFAULT_ACTIONS = {
  concentration: {
    title: 'Reduce reliance on the top item',
    detail: 'Grow the next largest items with more traffic or more ad sources so one problem cannot move the whole result.',
  },
  top_mover: {
    title: 'Check what changed on the biggest mover',
    detail: 'Open Reporting and compare it with the prior period to see whether the change is lasting.',
  },
  anomaly: {
    title: 'Check that day for outages or tracking problems',
    detail: 'Look at that date in Reporting and confirm ad serving and data sync were normal.',
  },
  drop_off: {
    title: 'Find out why it fell sharply',
    detail: 'Check for removed placements, policy limits or traffic loss on that item.',
  },
  match_rate: {
    title: 'Look at why requests go unfilled',
    detail: 'Compare formats and countries in Reporting to find where fill dropped.',
  },
  losing_entity: {
    title: 'Cut or fix the campaign that loses money',
    detail: 'Reduce its Google Ads budget or improve its targeting, then re-check ROI in a few days.',
  },
  negative_roi: {
    title: 'Review spend against earnings',
    detail: 'Find the campaigns driving the loss and lower their budgets until ROI is positive.',
  },
  unmatched_spend: {
    title: 'Map the remaining campaigns',
    detail: 'Link each unmatched campaign to its app or site so its spend counts toward ROI.',
  },
};

function rulesAnalysis(final, { deep = false } = {}) {
  const signals = final.signals || [];
  const top = signals[0];

  if (final.noData) {
    return {
      headline: 'There is no data for these filters in this period.',
      summary: 'Try a wider date range or fewer filters.',
      findings: signals.slice(0, 1).map((s) => ({ severity: s.severity, title: s.title, detail: s.text, factIds: s.factIds })),
      actions: [],
    };
  }

  const findings = signals.slice(0, 5).map((s) => ({
    severity: s.severity, title: s.title, detail: s.text, factIds: s.factIds,
  }));
  const actions = [];
  const seen = new Set();
  for (const s of signals) {
    const action = s.action || DEFAULT_ACTIONS[s.kind];
    if (action && !seen.has(action.title)) {
      seen.add(action.title);
      actions.push({ title: action.title, detail: action.detail, factIds: s.factIds });
    }
    if (actions.length >= 3) break;
  }

  const out = {
    headline: top
      ? top.title
      : 'Nothing stands out against the prior period.',
    summary: top
      ? top.text
      : 'Key figures moved within a normal range and no single item dominates.',
    findings,
    actions,
  };
  if (deep) {
    out.deepDive = [];
    out.confidence = { level: 'low', note: 'Written from fixed rules only, without the AI explanation.' };
  }
  return out;
}

module.exports = { rulesAnalysis };
