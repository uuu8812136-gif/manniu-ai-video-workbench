import { resolve } from "node:path";
import type { App } from "electron";

export const INSTALLED_DATA_DIRECTORY = "ai-tool";
export const PORTABLE_DATA_DIRECTORY = "ai-tool-data";

export type RuntimeStorage = {
  mode: "installed" | "portable";
  userData: string;
};

export type RuntimePathApp = Pick<App, "isPackaged" | "getPath" | "setPath">;

export function resolveDefaultJianyingDraftPath(
  environment: NodeJS.ProcessEnv = process.env,
  userHome = environment.USERPROFILE ?? "",
): string {
  const localAppData = environment.LOCALAPPDATA?.trim()
    || resolve(userHome, "AppData", "Local");
  return resolve(localAppData, "JianyingPro", "User Data", "Projects", "com.lveditor.draft");
}

export function resolveRuntimeStorage(
  defaultUserData: string,
  isPackaged: boolean,
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeStorage {
  const portableRoot = environment.PORTABLE_EXECUTABLE_DIR?.trim();
  if (!isPackaged || !portableRoot) return { mode: "installed", userData: defaultUserData };
  return { mode: "portable", userData: resolve(portableRoot, PORTABLE_DATA_DIRECTORY) };
}

export function configureRuntimeUserData(
  app: RuntimePathApp,
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeStorage {
  const defaultUserData = app.isPackaged
    ? resolve(app.getPath("appData"), INSTALLED_DATA_DIRECTORY)
    : app.getPath("userData");
  const storage = resolveRuntimeStorage(defaultUserData, app.isPackaged, environment);
  if (app.getPath("userData") !== storage.userData) app.setPath("userData", storage.userData);
  return storage;
}
