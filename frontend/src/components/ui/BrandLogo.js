import React from 'react';

const LOGO_SRC = `${process.env.PUBLIC_URL || ''}/adnexus-logo.png`;

export function BrandMark({ size = 28, className = 'logo-badge' }) {
  return (
    <img
      src={LOGO_SRC}
      alt="AdNexus"
      className={className}
      width={size}
      height={size}
      style={{ width: size, height: size }}
    />
  );
}

export default function BrandLogo({ showTitle = true, titleClassName = 'header-title', markSize = 28 }) {
  return (
    <>
      <BrandMark size={markSize} />
      {showTitle && <span className={titleClassName}>AdNexus</span>}
    </>
  );
}
