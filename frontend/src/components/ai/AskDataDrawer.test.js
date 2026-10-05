/* Ask-your-data drawer: visibility, suggestions, streaming answer, history, errors; and the text renderer. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';

jest.mock('../../utils/ai/presetAnalysis', () => ({ loadAiStatus: jest.fn() }));
jest.mock('../../utils/ai/ask', () => ({ askData: jest.fn() }));
jest.mock('../../utils/ai/actions', () => ({ runAction: jest.fn() }));

import { loadAiStatus } from '../../utils/ai/presetAnalysis';
import { askData } from '../../utils/ai/ask';
import { runAction } from '../../utils/ai/actions';
import AskDataDrawer from './AskDataDrawer';
import RichText from './RichText';

global.IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = jest.fn();

let container;
let root;
const tick = async (ms = 10) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };

async function mount(path = '/adsense/dashboard') {
  root = createRoot(container);
  await act(async () => { root.render(<MemoryRouter initialEntries={[path]}><AskDataDrawer /></MemoryRouter>); });
  await tick();
}

const openDrawer = async () => {
  await act(async () => { container.querySelector('.ask-launcher').click(); });
};

const typeAndSend = async (text) => {
  const ta = container.querySelector('#ask-input');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { container.querySelector('.ask-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  sessionStorage.clear();
  jest.clearAllMocks();
  loadAiStatus.mockResolvedValue({ enabled: true });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

test('hidden when AI is off', async () => {
  loadAiStatus.mockResolvedValue({ enabled: false });
  await mount();
  expect(container.innerHTML).toBe('');
});

test('shows product-specific suggestions and asks with page context', async () => {
  askData.mockResolvedValue({ answer: 'quiz2 earned the most.', steps: [{ label: 'Splitting AdSense by site', ok: true }], meta: {} });
  await mount('/adsense/roi');
  await openDrawer();
  const suggestion = [...container.querySelectorAll('.ask-suggest button')][0];
  expect(suggestion.textContent).toBe('Which sites earned the most last week?');
  await act(async () => { suggestion.click(); });
  await tick();
  const [body] = askData.mock.calls[0];
  expect(body).toMatchObject({ question: 'Which sites earned the most last week?', history: [], context: { product: 'adsense', page: 'roi' } });
  expect(container.textContent).toContain('quiz2 earned the most.');
  expect(container.textContent).toContain('Splitting AdSense by site');
});

test('streams lookups and partial text, then sends earlier turns as history', async () => {
  let finish;
  askData.mockImplementationOnce((body, { onTool, onText }) => new Promise((resolve) => {
    onTool('Reading AdSense dashboard');
    onText('Earnings rose');
    finish = () => resolve({ answer: 'Earnings rose 120%.', steps: [{ label: 'Reading AdSense dashboard', ok: true }], meta: {} });
  }));
  await mount();
  await openDrawer();
  await typeAndSend('How did we do?');
  expect(container.textContent).toContain('Reading AdSense dashboard');
  expect(container.textContent).toContain('Earnings rose');
  expect(container.querySelector('.ask-form button').textContent).toBe('Stop');
  await act(async () => { finish(); });
  await tick();
  expect(container.textContent).toContain('Earnings rose 120%.');

  askData.mockResolvedValueOnce({ answer: 'Yesterday was flat.', steps: [], meta: {} });
  await typeAndSend('And yesterday?');
  await tick();
  expect(askData.mock.calls[1][0].history).toEqual([
    { role: 'user', content: 'How did we do?' },
    { role: 'assistant', content: 'Earnings rose 120%.' },
  ]);
  expect(JSON.parse(sessionStorage.getItem('adnexus.ask.thread.anon'))).toHaveLength(4);
});

test('every user has their own conversation: another user never sees it, and it returns for the same user', async () => {
  askData.mockResolvedValue({ answer: 'Aman revenue is $5.', steps: [], meta: {} });
  root = createRoot(container);
  const render = (userId) => act(async () => {
    root.render(<MemoryRouter initialEntries={['/dashboard']}><AskDataDrawer userId={userId} /></MemoryRouter>);
  });
  await render('user-aman');
  await tick();
  await openDrawer();
  await typeAndSend('revenue for today?');
  await tick();
  expect(container.textContent).toContain('Aman revenue is $5.');

  // another admin signs in on the same browser
  await render('user-ravi');
  await tick();
  expect(container.textContent).not.toContain('Aman revenue');
  expect(container.textContent).not.toContain('revenue for today?');
  await openDrawer();
  expect(container.querySelector('.ask-suggest')).not.toBeNull();
  expect(sessionStorage.getItem('adnexus.ask.thread.user-ravi')).toBe('[]');
  await act(async () => { container.querySelector('.ask-close').click(); });

  // the first user comes back and finds their own chat
  await render('user-aman');
  await tick();
  await openDrawer();
  expect(container.textContent).toContain('Aman revenue is $5.');
  // and the shared, older key is never used
  expect(sessionStorage.getItem('adnexus.ask.thread')).toBeNull();
});

test('a conversation left under the old shared key is discarded, not shown to the next user', async () => {
  sessionStorage.setItem('adnexus.ask.thread', JSON.stringify([{ role: 'user', content: 'old shared question' }]));
  await mount();
  await openDrawer();
  expect(container.textContent).not.toContain('old shared question');
  expect(sessionStorage.getItem('adnexus.ask.thread')).toBeNull();
});

const SAVE_ACTION = { id: 'a1', type: 'save_preset', product: 'adsense', page: 'reporting', presetPage: 'adsense-reporting', name: 'Top Site', snapshot: {}, title: 'Save preset "Top Site"', detail: 'AdSense reporting · sites quiz2', confirm: true };
const OPEN_ACTION = { id: 'a2', type: 'open_page', href: '/ai-forecast', title: 'Open Forecast', detail: 'Opens in this app', confirm: false };

test('prepared actions appear as cards; nothing runs until a click, and Confirm runs it once', async () => {
  askData.mockImplementation(async (body, { onAction }) => {
    onAction(SAVE_ACTION);
    return { answer: 'Ready. Press Confirm to save it.', steps: [], actions: [SAVE_ACTION], meta: {} };
  });
  let finish;
  runAction.mockImplementation(() => new Promise((resolve) => { finish = () => resolve({ ok: true, message: 'Saved "Top Site".', href: '/adsense/presets', linkLabel: 'View presets' }); }));
  await mount();
  await openDrawer();
  await typeAndSend('save a preset called Top Site');
  await tick();
  expect(container.querySelectorAll('.act-card')).toHaveLength(1);
  expect(container.querySelector('.act-title').textContent).toBe('Save preset "Top Site"');
  expect(container.querySelector('.act-detail').textContent).toContain('sites quiz2');
  expect(runAction).not.toHaveBeenCalled();

  await act(async () => { container.querySelector('.act-confirm').click(); });
  expect(runAction).toHaveBeenCalledTimes(1);
  expect(runAction.mock.calls[0][0]).toMatchObject({ id: 'a1', type: 'save_preset' });
  expect(runAction.mock.calls[0][1]).toMatchObject({ userId: 'anon' });
  expect(container.querySelector('.act-confirm').disabled).toBe(true);
  expect(container.querySelector('.act-confirm').textContent).toBe('Working…');
  await act(async () => { finish(); });
  await tick();
  expect(container.querySelector('.act-result.ok').textContent).toContain('Saved "Top Site".');
  expect(container.querySelector('.act-confirm')).toBeNull();
  // the result is remembered with the conversation
  const stored = JSON.parse(sessionStorage.getItem('adnexus.ask.thread.anon'));
  expect(stored[1].actionStates.a1.status).toBe('done');
});

test('Cancel withdraws a card without running it; a failed action can be tried again', async () => {
  askData.mockResolvedValue({ answer: 'Ready.', steps: [], actions: [SAVE_ACTION, { ...SAVE_ACTION, id: 'a3', title: 'Second' }], meta: {} });
  runAction.mockResolvedValueOnce({ ok: false, message: 'A preset with that name already exists.' });
  await mount();
  await openDrawer();
  await typeAndSend('save it');
  await tick();
  const cards = [...container.querySelectorAll('.act-card')];
  await act(async () => { cards[1].querySelector('.act-cancel').click(); });
  expect(container.querySelectorAll('.act-card')[1].textContent).toContain('Cancelled.');
  expect(runAction).not.toHaveBeenCalled();

  await act(async () => { cards[0].querySelector('.act-confirm').click(); });
  await tick();
  expect(container.querySelector('.act-card.error [role="alert"]').textContent).toContain('already exists');
  runAction.mockResolvedValueOnce({ ok: true, message: 'Saved.' });
  const retry = container.querySelector('.act-card.error .act-confirm');
  expect(retry.textContent).toBe('Try again');
  await act(async () => { retry.click(); });
  await tick();
  expect(container.querySelector('.act-card.done')).not.toBeNull();
  expect(runAction).toHaveBeenCalledTimes(2);
});

test('an Open card has one button, runs on click, and closes the panel when it worked', async () => {
  askData.mockResolvedValue({ answer: 'Here you go.', steps: [], actions: [OPEN_ACTION], meta: {} });
  runAction.mockResolvedValue({ ok: true, message: 'Opened.' });
  await mount();
  await openDrawer();
  await typeAndSend('open the forecast');
  await tick();
  expect(container.querySelectorAll('.act-buttons button')).toHaveLength(1);
  expect(container.querySelector('.act-confirm').textContent).toBe('Open');
  await act(async () => { container.querySelector('.act-confirm').click(); });
  await tick();
  expect(runAction.mock.calls[0][0]).toMatchObject({ type: 'open_page', href: '/ai-forecast' });
  expect(container.querySelector('.ask-drawer')).toBeNull();
});

test('a click that was still working when the page closed can be clicked again after a reload', async () => {
  sessionStorage.setItem('adnexus.ask.thread.anon', JSON.stringify([
    { role: 'user', content: 'save it' },
    { role: 'assistant', content: 'Ready.', actions: [SAVE_ACTION], actionStates: { a1: { status: 'running' } } },
  ]));
  await mount();
  await openDrawer();
  expect(container.querySelector('.act-confirm').disabled).toBe(false);
  expect(container.querySelector('.act-confirm').textContent).toBe('Confirm');
});

test('an error is shown in the thread and not sent as history', async () => {
  askData.mockRejectedValueOnce(new Error('Too many AI requests. Try again in a minute.'));
  await mount();
  await openDrawer();
  await typeAndSend('Hi');
  await tick();
  expect(container.querySelector('.ask-msg.is-error').textContent).toContain('Too many AI requests');
  askData.mockResolvedValueOnce({ answer: 'ok', steps: [], meta: {} });
  await typeAndSend('Again');
  await tick();
  expect(askData.mock.calls[1][0].history).toEqual([{ role: 'user', content: 'Hi' }]);
});

test('clear empties the conversation', async () => {
  askData.mockResolvedValue({ answer: 'ok', steps: [], meta: {} });
  await mount();
  await openDrawer();
  await typeAndSend('Hi');
  await tick();
  await act(async () => { container.querySelector('.ask-link').click(); });
  expect(container.querySelector('.ask-suggest')).not.toBeNull();
});

test('renders paragraphs, lists and bold as text, never as HTML', async () => {
  root = createRoot(container);
  await act(async () => {
    root.render(<RichText text={'First **bold** line\ncontinues here.\n\nSecond paragraph.\n- one\n- two <img src=x onerror=alert(1)>\n1. step'} />);
  });
  expect(container.querySelectorAll('p')).toHaveLength(2);
  expect(container.querySelector('p').textContent).toBe('First bold line continues here.');
  expect(container.querySelector('strong').textContent).toBe('bold');
  expect(container.querySelectorAll('ul li')).toHaveLength(2);
  expect(container.querySelectorAll('ol li')).toHaveLength(1);
  expect(container.querySelector('img')).toBeNull();
});

test('renders a pipe table as a real table', async () => {
  root = createRoot(container);
  await act(async () => {
    const text = ['**Last week:**', '| Product | Earnings |', '|---------|----------|', '| **AdSense** | $603.49 |', '| AdMob | $0.14 |', '', 'Done.'].join('\n');
    root.render(<RichText text={text} />);
  });
  expect(container.querySelector('table')).not.toBeNull();
  expect([...container.querySelectorAll('th')].map((c) => c.textContent)).toEqual(['Product', 'Earnings']);
  expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
  expect(container.querySelector('tbody td strong').textContent).toBe('AdSense');
  expect(container.textContent).not.toContain('---');
  expect(container.textContent).toContain('Done.');
});
