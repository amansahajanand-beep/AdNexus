import { postEventStream, toError } from './eventStream';

/**
 * Ask a question about the data. Callbacks: onTool(label) when a lookup starts, onText(text) with the
 * answer written so far (it restarts when the assistant starts a new turn). Resolves with
 * { answer, steps, actions, meta }. `onAction(action)` receives each step the assistant prepared (a card the user
 * confirms); nothing it describes has happened yet.
 */
export async function askData({ question, history, context }, { signal, onTool, onText, onAction } = {}) {
  let done = null;
  let turn = -1;
  let text = '';
  await postEventStream('/ai/ask', { question, history, context }, {
    signal,
    onEvent: (event, data) => {
      if (event === 'tool') onTool?.(data.label);
      else if (event === 'action') onAction?.(data);
      else if (event === 'text') {
        if (data.turn !== turn) { turn = data.turn; text = ''; }
        text += data.delta;
        onText?.(text);
      } else if (event === 'done') done = data;
    },
  });
  if (!done) throw toError('The answer ended before it finished.', 502);
  return done;
}
