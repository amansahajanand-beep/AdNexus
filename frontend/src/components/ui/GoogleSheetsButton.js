import React, { useState } from 'react';
import Modal from './Modal';
import GoogleSheetsPanel from './GoogleSheetsPanel';

/** Header button that opens the Google Sheets connect panel in a popup (AdMob / AdSense pages). */
export default function GoogleSheetsButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn-reset btn-copy-link" onClick={() => setOpen(true)}>
        Google Sheets
      </button>
      <Modal open={open} title="Google Sheets" onClose={() => setOpen(false)} width={720}>
        <GoogleSheetsPanel />
      </Modal>
    </>
  );
}
