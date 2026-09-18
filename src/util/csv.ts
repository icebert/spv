/**
 * Spreadsheet-safe export cells. Excel, LibreOffice and Sheets run a cell that starts with `=`,
 * `+`, `-`, `@`, a tab or a carriage return as a formula when a CSV is opened, so text from a file
 * (cell names, categories, section names) gets a leading apostrophe in that case. Numbers are
 * written separately as numbers and never pass through here.
 */
export function neutralizeFormula(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

/** One text cell for a CSV (`,`) or TSV (`\t`) line: formula-safe, quoted or flattened as needed. */
export function csvCell(v: string, sep: ',' | '\t'): string {
  const s = neutralizeFormula(v);
  if (sep === ',') return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  return s.replace(/[\t\n\r]+/g, ' ');
}
