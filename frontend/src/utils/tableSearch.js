/** Client-side table search: match if any field text contains the query. */
export function filterRowsBySearch(rows, search, getTexts) {
  const q = String(search || '').trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) =>
    getTexts(row).some((t) => String(t ?? '').toLowerCase().includes(q))
  );
}
