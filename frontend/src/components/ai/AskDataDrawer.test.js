/* Ask-your-data drawer: visibility, suggestions, streaming answer, history, errors; and the text renderer. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';

jest.mock('../../utils/ai/presetAnalysis', () => ({ loadAiStatus: jest.fn() }));
jest.mock('../../utils/ai/ask', () => ({ askData: jest.fn() }));

import { loadAiStatus } from '../../utils/ai/presetAnalysis';
import { askData } from '../../utils/ai/ask';
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
  expect(JSON.parse(sessionStorage.getItem('adnexus.ask.thread'))).toHaveLength(4);
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
