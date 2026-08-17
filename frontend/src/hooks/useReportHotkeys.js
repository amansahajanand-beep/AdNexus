import { useEffect } from 'react';

function isTypingTarget(el) {
  if (!el || !(el instanceof Element)) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return Boolean(el.closest('[contenteditable="true"]'));
}

/**
 * Report/Dashboard hotkeys (ignored while typing in fields):
 * - A → apply
 * - R → reset
 * - / → focus table search
 */
export function useReportHotkeys({
  enabled = true,
  onApply,
  onReset,
  searchSelector = '.table-search-input, .table-search input, input[type="search"]',
} = {}) {
  useEffect(() => {
    if (!enabled) return undefined;

    const onKeyDown = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;

      const key = e.key;
      if (key === '/' ) {
        e.preventDefault();
        const input = document.querySelector(searchSelector);
        if (input && typeof input.focus === 'function') {
          input.focus();
          if (typeof input.select === 'function') input.select();
        }
        return;
      }

      const lower = key.toLowerCase();
      if (lower === 'a' && onApply) {
        e.preventDefault();
        onApply();
        return;
      }
      if (lower === 'r' && onReset) {
        e.preventDefault();
        onReset();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [enabled, onApply, onReset, searchSelector]);
}
