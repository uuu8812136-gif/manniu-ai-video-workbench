import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../src/main/database";
import { checkSqlite, collectRuntimeInformation, runDiagnostics } from "../src/main/diagnostics";

describe("runtime diagnostics", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it("checks writable directories, SQLite integrity and runtime versions", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-tool-diagnostics-"));
    cleanup.push(root);
    const database = new AppDatabase(":memory:");
    try {
      const report = runDiagnostics({
        directories: { projects: join(root, "projects"), logs: join(root, "logs") },
        database: database.connection,
        now: () => new Date("2026-07-26T00:00:00.000Z"),
      });

      expect(report).toMatchObject({
        status: "ok",
        generatedAt: "2026-07-26T00:00:00.000Z",
        sqlite: { healthy: true, result: ["ok"], error: null },
        runtime: { node: process.versions.node, platform: process.platform, architecture: process.arch },
      });
      expect(report.directories).toHaveLength(2);
      expect(report.directories.every((entry) => entry.writable)).toBe(true);
      expect(readdirSync(join(root, "projects"))).toEqual([]);
      expect(collectRuntimeInformation().electron).toBe(process.versions.electron ?? null);
    } finally {
      database.close();
    }
  });

  it("reports directory and database failures without throwing", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-tool-diagnostics-failure-"));
    cleanup.push(root);
    const filePath = join(root, "not-a-directory");
    writeFileSync(filePath, "file", "utf8");
    const corruptDatabase = { pragma: () => "row 2 missing from index idx_jobs_status" };

    const report = runDiagnostics({ directories: { projects: filePath }, database: corruptDatabase });

    expect(report.status).toBe("error");
    expect(report.directories[0]).toMatchObject({ writable: false });
    expect(report.directories[0].error).toBeTruthy();
    expect(report.sqlite).toEqual({
      healthy: false,
      result: ["row 2 missing from index idx_jobs_status"],
      error: null,
    });
  });

  it("handles quick_check exceptions and never includes API keys from the environment", () => {
    const previous = process.env.AI_TOOL_TEST_API_KEY;
    process.env.AI_TOOL_TEST_API_KEY = "sk-should-never-appear-in-diagnostics";
    try {
      const sqlite = checkSqlite({
        pragma: () => {
          throw new Error("database is closed");
        },
      });
      expect(sqlite).toEqual({ healthy: false, result: [], error: "Error: database is closed" });

      const root = mkdtempSync(join(tmpdir(), "ai-tool-diagnostics-secret-"));
      cleanup.push(root);
      const report = runDiagnostics({ directories: { userData: root }, database: { pragma: () => "ok" } });
      expect(JSON.stringify(report)).not.toContain(process.env.AI_TOOL_TEST_API_KEY);
    } finally {
      if (previous === undefined) delete process.env.AI_TOOL_TEST_API_KEY;
      else process.env.AI_TOOL_TEST_API_KEY = previous;
    }
  });
});
