/** Minimal RFC4180-ish CSV parser: handles quoted fields, escaped quotes, and CRLF/LF. No external dependency. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  const source = text.replace(/\r\n/g, '\n');
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += char;
      continue;
    }
    if (char === '"') { inQuotes = true; continue; }
    if (char === ',') { row.push(field); field = ''; continue; }
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += char;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).filter(cells => cells.some(cell => cell !== '')).map(cells => {
    const record: Record<string, string> = {};
    header.forEach((key, index) => { record[key] = cells[index] ?? ''; });
    return record;
  });
}
