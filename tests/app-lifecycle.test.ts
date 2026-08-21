import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activeJobQuitDetail, summarizeActiveJobs } from "../src/main/app-lifecycle";

describe("desktop app lifecycle", () => {
  it("counts only work that has not reached a terminal state", () => {
    const summary = summarizeActiveJobs([
      { status: "queued" },
      { status: "running" },
      { status: "running" },
      { status: "paused" },
      { status: "done" },
      { status: "error" },
      { status: "cancelled" },
    ]);

    expect(summary).toEqual({ queued: 1, running: 2, paused: 1, total: 4 });
  });

  it("builds a concrete quit warning", () => {
    expect(activeJobQuitDetail({ queued: 1, running: 2, paused: 0, total: 3 }))
      .toBe("还有 3 个未结束任务（运行中 2，排队中 1）。退出后本地任务状态会保留，已提交到网站的任务可能继续运行。");
  });

  it("wires the single-instance and active-job guards into Electron startup", () => {
    const main = readFileSync(join(process.cwd(), "src", "main", "index.ts"), "utf8");
    expect(main).toContain("app.requestSingleInstanceLock()");
    expect(main).toContain('app.on("second-instance"');
    expect(main).toContain("activeJobQuitDetail(active)");
  });
});
