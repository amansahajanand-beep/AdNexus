import React from 'react';

/** **bold** inside a line, rendered as text nodes (no HTML is ever injected). */
function inline(text, keyPrefix) {
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => (
    part.startsWith('**') && part.endsWith('**') && part.length > 4
      ? <strong key={`${keyPrefix}-${i}`}>{part.slice(2, -2)}</strong>
      : part
  ));
}

const isTableLine = (line) => line.startsWith('|') && line.indexOf('|', 1) > 0;
const isSeparator = (cells) => cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
const splitCells = (line) => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

/**
 * The small subset of Markdown the assistant uses: paragraphs, "- " / "1. " lists, **bold** and simple
 * pipe tables (models write these even when asked not to).
 */
export default function RichText({ text }) {
  const blocks = [];
  let list = null;
  let table = null;
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const flush = () => {
    if (list) blocks.push(list);
    if (table) blocks.push(table);
    list = null;
    table = null;
  };
  lines.forEach((raw) => {
    const line = raw.trim();
    if (isTableLine(line)) {
      if (list) { blocks.push(list); list = null; }
      const cells = splitCells(line);
      if (!table) table = { type: 'table', head: cells, rows: [] };
      else if (!isSeparator(cells)) table.rows.push(cells);
      return;
    }
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      if (table) { blocks.push(table); table = null; }
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) {
        if (list) blocks.push(list);
        list = { type: 'list', ordered, items: [] };
      }
      list.items.push((bullet || numbered)[1]);
      return;
    }
    flush();
    if (!line) {
      const prev = blocks[blocks.length - 1];
      if (prev && prev.type === 'p') prev.closed = true;
      return;
    }
    const last = blocks[blocks.length - 1];
    if (last && last.type === 'p' && !last.closed) last.text += ` ${line}`;
    else blocks.push({ type: 'p', text: line });
  });
  flush();

  return (
    <div className="rich-text">
      {blocks.map((b, i) => {
        if (b.type === 'table') {
          return (
            <div key={i} className="rich-table-wrap">
              <table className="rich-table">
                <thead><tr>{b.head.map((c, j) => <th key={j}>{inline(c, `h${i}-${j}`)}</th>)}</tr></thead>
                <tbody>
                  {b.rows.map((row, r) => (
                    <tr key={r}>{row.map((c, j) => <td key={j}>{inline(c, `${i}-${r}-${j}`)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (b.type === 'list') {
          const Tag = b.ordered ? 'ol' : 'ul';
          return <Tag key={i}>{b.items.map((item, j) => <li key={j}>{inline(item, `${i}-${j}`)}</li>)}</Tag>;
        }
        return <p key={i}>{inline(b.text, String(i))}</p>;
      })}
    </div>
  );
}
