import { postEventStream, toError } from './eventStream';

/**
 * Ask why earnings changed between a period and the one before it. `onDrivers` receives the exact figures
 * straight away; the promise resolves with the same figures plus the written explanation.
 */
export async function streamExplainChange(body, { signal, onDrivers } = {}) {
  let result = null;
  await postEventStream('/ai/explain-change', body, {
    signal,
    onEvent: (event, data) => {
      if (event === 'drivers') onDrivers?.(data);
      else if (event === 'result') result = data;
    },
  });
  if (!result) throw toError('The explanation ended before it finished.', 502);
  return result;
}
