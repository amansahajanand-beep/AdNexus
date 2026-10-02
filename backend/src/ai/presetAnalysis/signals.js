/**
 * Rule-detected findings. They go to the model as hints and also become the fallback analysis
 * when the model is unavailable, so every text here is a complete, plain sentence from the data.
 */
const RANK = { critical: 0, warning: 1, positive: 2, info: 3 };
const MAX_SIGNALS = 8;

class Signals {
  constructor() {
    this.list = [];
  }

  /**
   * @param {'critical'|'warning'|'positive'|'info'} severity
   * @param {string} kind     machine tag, e.g. "metric_drop", "concentration"
   * @param {string} title    short heading
   * @param {string} text     one or two sentences with the figures
   * @param {string[]} factIds
   * @param {{action?: {title: string, detail: string}, priority?: number}} [extra]
   */
  add(severity, kind, title, text, factIds = [], extra = {}) {
    this.list.push({
      severity, kind, title, text, factIds, action: extra.action || null, priority: extra.priority || 0,
    });
  }

  /** Most severe first; within a severity, higher priority first. Capped for prompt size. */
  top() {
    return this.list
      .slice()
      .sort((a, b) => (RANK[a.severity] - RANK[b.severity]) || (b.priority - a.priority))
      .slice(0, MAX_SIGNALS)
      .map((s, i) => ({ ...s, id: `S${i + 1}` }));
  }
}

module.exports = { Signals };
