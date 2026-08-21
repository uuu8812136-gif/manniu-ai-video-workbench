import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function pageSource(name: string): string {
  return readFileSync(join(process.cwd(), "src", "renderer", "src", "pages", name), "utf8");
}

describe("workflow page wiring contract", () => {
  it("persists and restores opening and polish jobs with their actual modes", () => {
    const source = pageSource("TextWorkflowPage.tsx");

    expect(source).toContain("restoreSingleTextWorkflow(kind, jobs, window.localStorage.getItem(trackingKey))");
    expect(source).toContain("window.localStorage.setItem(trackingKey, restored.job.id)");
    expect(source).toContain("setOpeningMode(restored.openingMode)");
    expect(source).toContain("setPolishMode(restored.polishMode)");
    expect(source).toContain("setPolishSourceFormat(restored.polishSourceFormat)");
    expect(source).toContain('window.offline.jobs.enqueue("text.polish", {');
    expect(source.match(/mode: polishMode,/gu)).toHaveLength(2);
    expect(source.match(/polishSourceFormat \? \{ sourceFormat: polishSourceFormat \}/gu)).toHaveLength(2);
    expect(source.match(/window\.localStorage\.setItem\(trackingKey, queued\.id\)/gu)).toHaveLength(2);
  });

  it("restores standalone image batches and keeps regenerated cards addressable", () => {
    const source = pageSource("ImagePage.tsx");

    expect(source).toContain("restoreStandaloneImageBatch(jobs, window.localStorage.getItem(imageBatchStorageKey()))");
    expect(source).toContain("window.localStorage.setItem(imageBatchStorageKey(), batchName)");
    expect(source).toContain("workbenchKey: result.key");
    expect(source).toContain("summarizeImageBatchCompletion(refreshed.map((item) => item.status))");
    expect(source).toContain("window.localStorage.removeItem(imageBatchStorageKey())");
  });

  it("blocks new Vidu submissions without an account while allowing existing task checks", () => {
    const source = pageSource("VideoPage.tsx");

    expect(source).toContain('const videoProviderReady = provider !== "vidu-browser" || hasUsableViduAccount(viduAccounts)');
    expect(source).toContain("if (!videoProviderReady && !storyboard.videoTaskId)");
    expect(source).toContain("disabled={busy || runnable.length === 0 || !videoProviderReady}");
    expect(source).toContain('storyboard.videoTaskId ? <button className="secondary-button compact-button"');
    expect(source).toContain('title="继续追踪已有网站任务"');
  });

  it("uses an in-app confirmation flow for uncertain Vidu submissions", () => {
    const source = pageSource("VideoPage.tsx");

    expect(source).not.toContain("window.prompt(");
    expect(source).toContain("<ModalDialog");
    expect(source).toContain('className="uncertain-resolution-form"');
    expect(source).toContain("确认无此任务并清除");
    expect(source).toContain("disabled={busy || !uncertainClearConfirmed}");
    expect(source).toContain("await window.offline.vidu.resolveUncertain(storyboard.id, { taskId: uncertainTaskId.trim() })");
    expect(source).toContain("await window.offline.vidu.resolveUncertain(storyboard.id, { clear: true })");
  });
});
