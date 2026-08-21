import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  PORTABLE_DATA_DIRECTORY,
  configureRuntimeUserData,
  resolveDefaultJianyingDraftPath,
  resolveRuntimeStorage,
} from "../src/main/runtime-paths";

describe("runtime user data paths", () => {
  it("keeps Electron's per-user path for development and installed builds", () => {
    const defaultPath = join("C:\\Users", "tester", "AppData", "Roaming", "ai-tool");
    expect(resolveRuntimeStorage(defaultPath, false, { PORTABLE_EXECUTABLE_DIR: "D:\\portable" })).toEqual({
      mode: "installed",
      userData: defaultPath,
    });
    expect(resolveRuntimeStorage(defaultPath, true, {})).toEqual({ mode: "installed", userData: defaultPath });
  });

  it("stores portable data beside the launcher only in a packaged portable build", () => {
    const result = resolveRuntimeStorage("ignored", true, { PORTABLE_EXECUTABLE_DIR: "D:\\AI Tools\\AI工具" });
    expect(result).toEqual({
      mode: "portable",
      userData: resolve("D:\\AI Tools\\AI工具", PORTABLE_DATA_DIRECTORY),
    });
  });

  it("uses the renamed portable data directory", () => {
    expect(PORTABLE_DATA_DIRECTORY).toBe("ai-tool-data");
  });

  it("resolves the original Jianying Pro draft directory from LOCALAPPDATA", () => {
    expect(resolveDefaultJianyingDraftPath({ LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" }, "ignored"))
      .toBe(resolve("C:\\Users\\tester\\AppData\\Local", "JianyingPro", "User Data", "Projects", "com.lveditor.draft"));
    expect(resolveDefaultJianyingDraftPath({}, "C:\\Users\\tester"))
      .toBe(resolve("C:\\Users\\tester", "AppData", "Local", "JianyingPro", "User Data", "Projects", "com.lveditor.draft"));
  });

  it("sets the Electron userData path before startup for portable builds", () => {
    const setPath = vi.fn();
    const app = { isPackaged: true, getPath: vi.fn(() => "default"), setPath };
    const result = configureRuntimeUserData(app, { PORTABLE_EXECUTABLE_DIR: "E:\\portable" });

    expect(result.mode).toBe("portable");
    expect(setPath).toHaveBeenCalledWith("userData", resolve("E:\\portable", PORTABLE_DATA_DIRECTORY));
  });
});
