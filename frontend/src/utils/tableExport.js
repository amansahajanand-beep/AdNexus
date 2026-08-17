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

/** UTF-8 CSV with BOM so Excel keeps currency symbols and commas. */
export function downloadCsv(filename, headers = [], rows = []) {
  const lines = [
    headers.map(csvCell).join(','),
    ...rows.map((row) => row.map(csvCell).join(',')),
  ];
  const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8;' });
  triggerDownload(blob, filename.endsWith('.csv') ? filename : `${filename}.csv`);
}

/** SpreadsheetML .xls — opens in Excel / Google Sheets without extra libraries. */
export function downloadExcel(filename, headers = [], rows = [], sheetName = 'Report') {
  const headerRow = `<Row>${headers.map(excelCell).join('')}</Row>`;
  const body = rows.map((row) => `<Row>${row.map(excelCell).join('')}</Row>`).join('');
  const xml = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Worksheet ss:Name="${xmlEscape(sheetName).slice(0, 31) || 'Report'}">
<Table>${headerRow}${body}</Table>
</Worksheet>
</Workbook>`;
  const blob = new Blob([xml], { type: 'application/vnd.ms-excel' });
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
