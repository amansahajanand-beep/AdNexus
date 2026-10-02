import { aiAPI } from '../api';
import { postEventStream, toError } from './eventStream';

const STATUS_TTL_MS = 60_000;

let statusCache = null;

/** Whether AI is on for the signed-in user. Cached briefly; failures read as "off". */
export function loadAiStatus({ force = false } = {}) {
  const now = Date.now();
  if (!force && statusCache && now - statusCache.at < STATUS_TTL_MS) return statusCache.promise;
  const promise = aiAPI.status().catch(() => ({ enabled: false, reason: 'unavailable' }));
  statusCache = { at: now, promise };
  return promise;
}

export function resetAiStatus() {
  statusCache = null;
}

/**
 * Ask for an analysis and receive it in stages: `facts` (key figures, immediately),
 * `headline` (as soon as it is written) and `result` (everything).
 * Resolves with the final result; rejects with an Error that carries `status` and `code`.
 */
export async function streamPresetAnalysis(body, { signal, onFacts, onHeadline } = {}) {
  let result = null;
  await postEventStream('/ai/preset-analysis', body, {
    signal,
    onEvent: (event, data) => {
      if (event === 'facts') onFacts?.(data);
      else if (event === 'headline') onHeadline?.(data.text);
      else if (event === 'result') result = data;
    },
  });
  if (!result) throw toError('The analysis ended before it finished.', 502);
  return result;
}
