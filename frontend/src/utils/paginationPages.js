/** Up to `maxVisible` page numbers centered around the current page. */
export function getVisiblePageNumbers(currentPage, totalPages, maxVisible = 5) {
  if (totalPages <= 0) return [];
  const safePage = Math.min(Math.max(1, currentPage), totalPages);
  let start = Math.max(1, safePage - 2);
  let end = Math.min(totalPages, start + maxVisible - 1);
  start = Math.max(1, end - maxVisible + 1);
  const pages = [];
  for (let i = start; i <= end; i++) pages.push(i);
  return pages;
}
