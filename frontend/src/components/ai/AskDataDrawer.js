import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { loadAiStatus } from '../../utils/ai/presetAnalysis';
import { askData } from '../../utils/ai/ask';
import { runAction } from '../../utils/ai/actions';
import { resolveActiveProduct } from '../../utils/productWorkspace';
import RichText from './RichText';
import ActionCard from './ActionCard';

// One conversation per signed-in user: a key shared by everyone on this browser would show one admin's chat to the next.
const THREAD_KEY_PREFIX = 'adnexus.ask.thread';
const threadKey = (userId) => `${THREAD_KEY_PREFIX}.${userId}`;
const MAX_HISTORY = 8;

const SUGGESTIONS = {
  gam: ['How did revenue change last week?', 'How will this month end?', 'Open the ROI page'],
  admob: ['Which app earned the most last week?', 'Why did eCPM change in the last 7 days?', 'Which countries grew the most this week?'],
  adsense: ['Which sites earned the most last week?', 'How did page RPM change this month?', 'Which site grew the fastest in the last 7 days?'],
};

function pageFromPath(path) {
  if (/\/roi/.test(path)) return 'roi';
  if (/\/reporting/.test(path)) return 'reporting';
  if (/\/presets/.test(path)) return 'presets';
  if (/\/admin/.test(path)) return 'admin';
  return 'dashboard';
}

function readThread(userId) {
  try {
    // The old, shared key held whoever asked last; drop it so it is never read again.
    sessionStorage.removeItem(THREAD_KEY_PREFIX);
    const parsed = JSON.parse(sessionStorage.getItem(threadKey(userId)) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((m) => m && m.content && !m.pending)
      .map((m) => {
        // A click that was still working when the page closed has no result: let it be clicked again.
        const states = Object.fromEntries(Object.entries(m.actionStates || {}).filter(([, s]) => s?.status !== 'running'));
        return m.actions ? { ...m, actionStates: states } : m;
      });
  } catch {
    return [];
  }
}

function Sparkle({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M12 2.5l1.9 5.6 5.6 1.9-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.9L12 2.5zM19 15l.9 2.6 2.6.9-2.6.9L19 22l-.9-2.6-2.6-.9 2.6-.9L19 15z" />
    </svg>
  );
}

/**
 * "Ask AI" launcher and side panel: questions about the user's own data, answered from live lookups.
 * Renders nothing when AI is off. The conversation lasts for the browser session and belongs to the signed-in
 * user: a different user gets their own, empty or earlier, conversation.
 */
export default function AskDataDrawer({ userId = 'anon' }) {
  // A new user remounts the panel, which drops any open question and the other user's messages from memory.
  return <AskDataPanel key={userId} userId={userId} />;
}

function AskDataPanel({ userId }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [thread, setThread] = useState(() => readThread(userId));
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const controllerRef = useRef(null);
  const inputRef = useRef(null);
  const endRef = useRef(null);

  const product = resolveActiveProduct(location.pathname);

  useEffect(() => {
    let alive = true;
    // Fresh for each signed-in user: the cached answer may belong to whoever used this browser before.
    loadAiStatus({ force: true }).then((s) => { if (alive) setEnabled(Boolean(s?.enabled)); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    try { sessionStorage.setItem(threadKey(userId), JSON.stringify(thread.filter((m) => !m.pending))); } catch { /* ignore */ }
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [thread, userId]);

  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => { clearTimeout(t); document.removeEventListener('keydown', onKey); };
  }, [open]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  if (!enabled) return null;

  const updateLast = (patch) => setThread((list) => {
    const next = list.slice();
    next[next.length - 1] = { ...next[next.length - 1], ...patch };
    return next;
  });

  const send = async (text) => {
    const question = String(text || '').trim();
    if (!question || busy) return;
    const history = thread
      .filter((m) => !m.pending && !m.error && m.content)
      .slice(-MAX_HISTORY)
      .map((m) => ({ role: m.role, content: m.content }));
    setInput('');
    setBusy(true);
    setThread((list) => [...list, { role: 'user', content: question }, { role: 'assistant', content: '', steps: [], pending: true }]);
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const done = await askData(
        { question, history, context: { product, page: pageFromPath(location.pathname) } },
        {
          signal: controller.signal,
          onTool: (label) => setThread((list) => {
            const next = list.slice();
            const last = next[next.length - 1];
            next[next.length - 1] = { ...last, steps: [...(last.steps || []), { label, ok: true }] };
            return next;
          }),
          onText: (partial) => updateLast({ content: partial }),
          onAction: (action) => setThread((list) => {
            const next = list.slice();
            const last = next[next.length - 1];
            if ((last.actions || []).some((a) => a.id === action.id)) return list;
            next[next.length - 1] = { ...last, actions: [...(last.actions || []), action] };
            return next;
          }),
        }
      );
      updateLast({ content: done.answer, steps: done.steps, pending: false, ...(done.actions?.length ? { actions: done.actions } : {}) });
    } catch (err) {
      if (controller.signal.aborted) {
        updateLast({ pending: false, content: 'Stopped.', error: true });
      } else {
        updateLast({ pending: false, content: err.message || 'Could not answer right now.', error: true });
      }
    } finally {
      setBusy(false);
      controllerRef.current = null;
    }
  };

  const onSubmit = (e) => {
    e.preventDefault();
    send(input);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  };

  const setActionState = (messageIndex, actionId, state) => setThread((list) => list.map((m, i) => (
    i === messageIndex ? { ...m, actionStates: { ...(m.actionStates || {}), [actionId]: state } } : m
  )));

  // Runs only from a click on a card; the assistant itself cannot trigger this.
  const confirmAction = async (messageIndex, action) => {
    setActionState(messageIndex, action.id, { status: 'running' });
    let result;
    try {
      result = await runAction(action, { navigate, userId });
    } catch (err) {
      result = { ok: false, message: err?.message || 'That did not work. Try again.' };
    }
    setActionState(messageIndex, action.id, result.ok ? { status: 'done', ...result } : { status: 'error', message: result.message });
    if (result.ok && action.type === 'open_page') setOpen(false);
  };

  const followLink = (href) => {
    navigate(href);
    setOpen(false);
  };

  const clear = () => {
    controllerRef.current?.abort();
    setThread([]);
  };

  return (
    <>
      {!open ? (
        <button type="button" className="ask-launcher" onClick={() => setOpen(true)} aria-haspopup="dialog">
          <Sparkle />
          Ask AI
        </button>
      ) : null}

      {open ? (
        <aside className="ask-drawer" role="dialog" aria-label="Ask about your data">
          <div className="ask-head">
            <div className="ask-title"><Sparkle /> Ask about your data</div>
            <div className="ask-head-actions">
              {thread.length ? <button type="button" className="ask-link" onClick={clear}>Clear</button> : null}
              <button type="button" className="ask-close" onClick={() => setOpen(false)} aria-label="Close">×</button>
            </div>
          </div>

          <div className="ask-body">
            {!thread.length ? (
              <div className="ask-empty">
                <p>Ask in plain words. Answers come from your own data, with the dates used.</p>
                <div className="ask-suggest">
                  {(SUGGESTIONS[product] || SUGGESTIONS.gam).map((q) => (
                    <button key={q} type="button" onClick={() => send(q)}>{q}</button>
                  ))}
                </div>
              </div>
            ) : (
              <ul className="ask-thread">
                {thread.map((m, i) => (
                  // Messages are append-only, so the position is a stable key.
                  <li key={i} className={`ask-msg ${m.role}${m.error ? ' is-error' : ''}`}>
                    {m.role === 'assistant' && m.steps?.length ? (
                      <ul className="ask-steps" aria-label="Lookups">
                        {m.steps.map((s, j) => <li key={`${s.label}-${j}`} className={s.ok ? '' : 'is-failed'}>{s.label}</li>)}
                      </ul>
                    ) : null}
                    {m.role === 'assistant'
                      ? (m.content ? <RichText text={m.content} /> : <p className="ask-wait">Looking at your data…</p>)
                      : <p>{m.content}</p>}
                    {m.role === 'assistant' && m.actions?.length ? (
                      <div className="act-list">
                        {m.actions.map((a) => (
                          <ActionCard
                            key={a.id}
                            action={a}
                            state={m.actionStates?.[a.id]}
                            onConfirm={() => confirmAction(i, a)}
                            onCancel={() => setActionState(i, a.id, { status: 'cancelled' })}
                            onLink={followLink}
                          />
                        ))}
                      </div>
                    ) : null}
                  </li>
                ))}
                <li ref={endRef} aria-hidden="true" />
              </ul>
            )}
          </div>

          <form className="ask-form" onSubmit={onSubmit}>
            <textarea
              id="ask-input"
              ref={inputRef}
              className="ask-input"
              rows={2}
              value={input}
              maxLength={1000}
              placeholder="e.g. Which site earned the most last week?"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              aria-label="Your question"
            />
            {busy ? (
              <button type="button" className="btn-reset" onClick={() => controllerRef.current?.abort()}>Stop</button>
            ) : (
              <button type="submit" className="btn-generate" disabled={!input.trim()}>Ask</button>
            )}
          </form>
        </aside>
      ) : null}
    </>
  );
}
