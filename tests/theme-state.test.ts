import { describe, expect, it, vi } from "vitest";
import { readThemeMode, saveThemeMode, THEME_STORAGE_KEY } from "../src/renderer/src/lib/theme-state";

describe("theme state", () => {
  it("defaults unknown and missing values to light", () => {
    expect(readThemeMode({ getItem: () => null, setItem: vi.fn() })).toBe("light");
    expect(readThemeMode({ getItem: () => "system", setItem: vi.fn() })).toBe("light");
  });

  it("persists and restores dark mode", () => {
    let value: string | null = null;
    const storage = {
      getItem: (key: string) => key === THEME_STORAGE_KEY ? value : null,
      setItem: (key: string, next: string) => { if (key === THEME_STORAGE_KEY) value = next; },
    };
    saveThemeMode("dark", storage);
    expect(readThemeMode(storage)).toBe("dark");
  });
});
