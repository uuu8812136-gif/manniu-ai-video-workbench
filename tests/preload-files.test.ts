import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OfflineApi } from "../src/shared/contracts";
import { IPC } from "../src/shared/contracts";

const electronMock = vi.hoisted(() => ({
  api: null as OfflineApi | null,
  invoke: vi.fn(),
  getPathForFile: vi.fn((file: { mockPath: string }) => file.mockPath),
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn((_name: string, api: OfflineApi) => {
      electronMock.api = api;
    }),
  },
  ipcRenderer: {
    invoke: electronMock.invoke,
  },
  webUtils: {
    getPathForFile: electronMock.getPathForFile,
  },
}));

await import("../src/preload/index");

describe("preload dropped document bridge", () => {
  beforeEach(() => {
    electronMock.invoke.mockReset();
    electronMock.getPathForFile.mockClear();
  });

  it("resolves browser File objects with Electron webUtils before invoking IPC", async () => {
    const files = [
      { mockPath: "D:\\稿件\\第一篇.txt" },
      { mockPath: "D:\\稿件\\第二篇.docx" },
    ];
    const imported = [{ path: files[0].mockPath, format: "txt", text: "正文" }];
    electronMock.invoke.mockResolvedValue(imported);

    await expect(electronMock.api?.files.importDroppedDocuments(files)).resolves.toBe(imported);
    expect(electronMock.getPathForFile).toHaveBeenCalledTimes(2);
    expect(electronMock.invoke).toHaveBeenCalledWith(IPC.filesImportDroppedDocuments, files.map((file) => file.mockPath));
  });

  it("exposes priority generation enqueue through the preload bridge", async () => {
    const result = { id: "priority-job" };
    electronMock.invoke.mockResolvedValue(result);
    const input = { storyboardId: 7 };

    await expect(electronMock.api?.jobs.enqueuePriority("video.generate", input)).resolves.toBe(result);
    expect(electronMock.invoke).toHaveBeenCalledWith(IPC.jobsEnqueuePriority, "video.generate", input);
  });

  it("bridges bounded project job and event queries", async () => {
    electronMock.invoke.mockResolvedValue([]);

    await electronMock.api?.jobs.latestForStoryboards([7, 8]);
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC.jobsLatestForStoryboards, [7, 8]);
    await electronMock.api?.jobs.events("63ec415b-7704-4a99-90c5-c9087a796f46", 50);
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC.jobsEvents,
      "63ec415b-7704-4a99-90c5-c9087a796f46",
      50,
    );
  });

  it("bridges project CSV copies and immediate Vidu checks", async () => {
    electronMock.invoke.mockResolvedValueOnce("D:\\项目\\分镜.csv");
    await expect(electronMock.api?.files.copyIntoDirectory({
      sourcePath: "D:\\导入\\分镜.csv",
      directory: "D:\\项目",
    })).resolves.toBe("D:\\项目\\分镜.csv");
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC.filesCopyIntoDirectory, {
      sourcePath: "D:\\导入\\分镜.csv",
      directory: "D:\\项目",
    });

    electronMock.invoke.mockResolvedValueOnce({ providerStatus: "processing" });
    await electronMock.api?.vidu.checkSubmission(7);
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC.viduSubmissionCheck, 7);
  });

  it("bridges all local Vidu subject-library operations without exposing session credentials", async () => {
    const accountId = "63ec415b-7704-4a99-90c5-c9087a796f46";
    electronMock.invoke.mockResolvedValue({ count: 3, copiedAt: "2026-07-27T00:00:00.000Z", sourceAccountName: "账号一" });

    await electronMock.api?.vidu.subjectClipboardStatus();
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC.viduSubjectsClipboardStatus);
    await electronMock.api?.vidu.copySubjectLibrary(accountId);
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC.viduSubjectsCopy, accountId);
    await electronMock.api?.vidu.pasteSubjectLibrary(accountId);
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC.viduSubjectsPaste, accountId);
    await electronMock.api?.vidu.clearSubjectLibrary(accountId);
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC.viduSubjectsClear, accountId);

    expect(electronMock.invoke.mock.calls.flat()).not.toContainEqual(expect.objectContaining({ jwt: expect.anything() }));
  });
});
