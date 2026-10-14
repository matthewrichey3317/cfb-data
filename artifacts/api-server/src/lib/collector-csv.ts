export type Row = Record<string, unknown>;

export function csvCell(value: unknown): string {
  const text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(rows: Row[], defaultColumns: string[]): string {
  const columns = [...new Set([...defaultColumns, ...rows.flatMap(Object.keys)])];
  return columns.map(csvCell).join(",") + "\r\n" +
    rows.map(row => columns.map(key => csvCell(row[key])).join(",")).join("\r\n") +
    (rows.length ? "\r\n" : "");
}

// RFC 4180 parser, including escaped quotes and embedded newlines.
export function parseCsv(text: string): Row[] {
  const records: string[][] = [];
  let record: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === "," && !quoted) { record.push(cell); cell = ""; }
    else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      record.push(cell); records.push(record); record = []; cell = "";
    } else cell += ch;
  }
  if (quoted) throw new Error("Invalid CSV: unterminated quoted field");
  if (cell || record.length) { record.push(cell); records.push(record); }
  const header = records.shift() ?? [];
  return records.filter(r => !(r.length === 1 && r[0] === "")).map(r =>
    Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}
