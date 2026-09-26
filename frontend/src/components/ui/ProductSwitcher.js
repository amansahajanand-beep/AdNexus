import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PRODUCT_LIST, getProduct } from '../../utils/productWorkspace';

/**
 * Sidebar control to switch between GAM, AdMob, and AdSense workspaces.
 */
export default function ProductSwitcher({
  productId = 'gam',
  onChange,
  compact = false,
  allowedProductIds = null,
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const active = getProduct(productId);
  const products = Array.isArray(allowedProductIds) && allowedProductIds.length
    ? PRODUCT_LIST.filter((p) => allowedProductIds.includes(p.id))
    : PRODUCT_LIST;

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = useCallback((id) => {
    setOpen(false);
    if (id !== productId && typeof onChange === 'function') onChange(id);
  }, [onChange, productId]);

  if (compact) {
    return (
      <div className={`product-switcher product-switcher--compact product-switcher--${productId}`} title={active.fullLabel}>
        <span className="product-switcher-badge" aria-hidden>{active.label.slice(0, 1)}</span>
      </div>
    );
  }

  return (
    <div className={`product-switcher product-switcher--${productId}`} ref={wrapRef}>
      <button
        type="button"
        className="product-switcher-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Product: ${active.fullLabel}. Change product`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="product-switcher-current">
          <span className="product-switcher-badge" aria-hidden>{active.label.slice(0, 1)}</span>
          <span className="product-switcher-text">
            <span className="product-switcher-label">{active.label}</span>
            <span className="product-switcher-desc">{active.shortDesc}</span>
          </span>
        </span>
        <span className="product-switcher-caret" aria-hidden>▾</span>
      </button>

      {open && (
        <ul className="product-switcher-menu" role="listbox" aria-label="Select product">
          {products.map((p) => {
            const selected = p.id === productId;
            return (
              <li key={p.id} role="option" aria-selected={selected}>
                <button
                  type="button"
                  className={`product-switcher-option product-switcher-option--${p.id}${selected ? ' is-selected' : ''}`}
                  onClick={() => pick(p.id)}
                >
                  <span className="product-switcher-badge" aria-hidden>{p.label.slice(0, 1)}</span>
                  <span className="product-switcher-text">
                    <span className="product-switcher-label">{p.fullLabel}</span>
                    <span className="product-switcher-desc">{p.shortDesc}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
