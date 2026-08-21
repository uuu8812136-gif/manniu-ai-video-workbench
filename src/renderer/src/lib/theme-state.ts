export type ThemeMode = "light" | "dark";

export const THEME_STORAGE_KEY = "ai-tool-theme";

type ThemeStorage = Pick<Storage, "getItem" | "setItem">;

export function readThemeMode(storage: ThemeStorage): ThemeMode {
  return storage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
}

export function applyThemeMode(mode: ThemeMode, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = mode;
  root.style.colorScheme = mode;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute(
    "content",
    mode === "dark" ? "#16191d" : "#f4f6f8",
  );
}

export function saveThemeMode(mode: ThemeMode, storage: ThemeStorage): void {
  storage.setItem(THEME_STORAGE_KEY, mode);
}
