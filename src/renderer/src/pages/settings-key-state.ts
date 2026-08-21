export function parseSettingKeyRows(primary: string, backups: string): string[] {
  const values = [primary, ...backups.split(/\r?\n/u)].map((value) => value.trim()).filter(Boolean);
  return values.length > 0 ? values : [""];
}

export function serializeSettingKeyRows(rows: readonly string[]): { primary: string; backups: string } {
  const values = rows.map((value) => value.trim()).filter(Boolean);
  return { primary: values[0] ?? "", backups: values.slice(1).join("\n") };
}

export function replaceSettingKeyRow(rows: readonly string[], index: number, value: string): string[] {
  if (index < 0 || index >= rows.length) return [...rows];
  return rows.map((item, itemIndex) => itemIndex === index ? value : item);
}

export function pasteSettingKeyRows(rows: readonly string[], index: number, value: string): string[] | null {
  const pasted = value.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
  if (pasted.length < 2 || index < 0 || index >= rows.length) return null;
  return [...rows.slice(0, index), ...pasted, ...rows.slice(index + 1)].slice(0, 100);
}

export function removeSettingKeyRow(rows: readonly string[], index: number): string[] {
  if (rows.length <= 1) return [""];
  const next = rows.filter((_, itemIndex) => itemIndex !== index);
  return next.length > 0 ? next : [""];
}
