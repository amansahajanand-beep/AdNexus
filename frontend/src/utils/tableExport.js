function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function excelCell(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<Cell><Data ss:Type="Number">${value}</Data></Cell>`;
  }
  return `<Cell><Data ss:Type="String">${xmlEscape(value)}</Data></Cell>`;
}

/** Rows per Blob part: keeps the peak memory of a 200k-row export far below one giant string. */
const CHUNK_ROWS = 5000;

/**
 * Excel's legacy .xls / SpreadsheetML format holds at most 65,536 rows per sheet and silently drops the rest,
 * so long exports continue on "Report 2", "Report 3", ... (header repeated on each sheet).
 */
const EXCEL_MAX_ROWS_PER_SHEET = 60000;

/** UTF-8 CSV with BOM so Excel keeps currency symbols and commas. Every row is written (no row cap). */
export function downloadCsv(filename, headers = [], rows = []) {
  const parts = ['﻿', `${headers.map(csvCell).join(',')}\n`];
  for (let i = 0; i < rows.length; i += CHUNK_ROWS) {
    parts.push(`${rows.slice(i, i + CHUNK_ROWS).map((row) => row.map(csvCell).join(',')).join('\n')}\n`);
  }
  const blob = new Blob(parts, { type: 'text/csv;charset=utf-8;' });
  triggerDownload(blob, filename.endsWith('.csv') ? filename : `${filename}.csv`);
}

/** SpreadsheetML .xls — opens in Excel / Google Sheets without extra libraries. Every row is written. */
export function downloadExcel(filename, headers = [], rows = [], sheetName = 'Report') {
  const headerRow = `<Row>${headers.map(excelCell).join('')}</Row>`;
  const baseName = xmlEscape(sheetName).slice(0, 25) || 'Report';
  const parts = [`<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
`];
  const sheetCount = Math.max(1, Math.ceil(rows.length / EXCEL_MAX_ROWS_PER_SHEET));
  for (let s = 0; s < sheetCount; s += 1) {
    const name = s === 0 ? baseName : `${baseName} ${s + 1}`;
    parts.push(`<Worksheet ss:Name="${name}">\n<Table>${headerRow}`);
    const from = s * EXCEL_MAX_ROWS_PER_SHEET;
    const to = Math.min(rows.length, from + EXCEL_MAX_ROWS_PER_SHEET);
    for (let i = from; i < to; i += CHUNK_ROWS) {
      parts.push(rows.slice(i, Math.min(to, i + CHUNK_ROWS))
        .map((row) => `<Row>${row.map(excelCell).join('')}</Row>`).join(''));
    }
    parts.push('</Table>\n</Worksheet>\n');
  }
  parts.push('</Workbook>');
  const blob = new Blob(parts, { type: 'application/vnd.ms-excel' });
  const base = filename.replace(/\.(csv|xls|xlsx)$/i, '');
  triggerDownload(blob, `${base}.xls`);
}

export function exportCellValue(col, row) {
  const raw = col.getValue(row);
  if (col.format === 'money' || col.format === 'num' || col.format === 'percent') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : '';
  }
  return raw == null ? '' : String(raw);
}
