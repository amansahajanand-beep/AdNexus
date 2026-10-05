import { postEventStream, toError } from './eventStream';

/**
 * Month-end forecast for one product. `onFigures` receives the exact projection straight away (with a rule-based
 * explanation); the promise resolves with the same figures plus the written explanation.
 */
export async function streamForecast(body, { signal, onFigures } = {}) {
  let result = null;
  await postEventStream('/ai/forecast', body, {
    signal,
    onEvent: (event, data) => {
      if (event === 'figures') onFigures?.(data);
      else if (event === 'result') result = data;
    },
  });
  if (!result) throw toError('The forecast ended before it finished.', 502);
  return result;
}
