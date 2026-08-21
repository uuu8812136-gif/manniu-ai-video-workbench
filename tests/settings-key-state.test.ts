import { describe, expect, it } from "vitest";
import {
  parseSettingKeyRows,
  pasteSettingKeyRows,
  removeSettingKeyRow,
  replaceSettingKeyRow,
  serializeSettingKeyRows,
} from "../src/renderer/src/pages/settings-key-state";

describe("settings API key rows", () => {
  it("round-trips the existing primary and backup storage keys", () => {
    const rows = parseSettingKeyRows("primary", "backup-1\n\nbackup-2");
    expect(rows).toEqual(["primary", "backup-1", "backup-2"]);
    expect(serializeSettingKeyRows(rows)).toEqual({ primary: "primary", backups: "backup-1\nbackup-2" });
    expect(parseSettingKeyRows("", "")).toEqual([""]);
  });

  it("supports editing, multiline paste and keeping one empty row", () => {
    expect(replaceSettingKeyRow(["a", "b"], 1, "changed")).toEqual(["a", "changed"]);
    expect(pasteSettingKeyRows(["a", "b"], 1, "x\r\ny\n\nz")).toEqual(["a", "x", "y", "z"]);
    expect(pasteSettingKeyRows(["a"], 0, "single")).toBeNull();
    expect(removeSettingKeyRow(["a", "b"], 0)).toEqual(["b"]);
    expect(removeSettingKeyRow(["a"], 0)).toEqual([""]);
  });
});
