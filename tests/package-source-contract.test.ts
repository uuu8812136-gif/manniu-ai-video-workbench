import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";

const packageSourceScript = resolve("scripts/package-source.ps1");

describe.skipIf(process.platform !== "win32")("source package contract", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function projectFixture(): { root: string; project: string; output: string } {
    const root = mkdtempSync(join(tmpdir(), "ai-tool-source-package-"));
    const project = join(root, "project");
    const output = join(root, "ai-tool-source.zip");
    cleanup.push(root);
    mkdirSync(join(project, "src"), { recursive: true });
    mkdirSync(join(project, "audit"), { recursive: true });
    mkdirSync(join(project, "audit", "evidence", "current-ui-interactions-artifacts", "case-1", "user-data"), { recursive: true });
    mkdirSync(join(project, "audit", "arbitrary-short-root", "opening-docx", "user-data"), { recursive: true });
    mkdirSync(join(project, "vendor", "inference-skill"), { recursive: true });
    writeFileSync(join(project, "README.md"), "# AI工具\n", "utf8");
    writeFileSync(join(project, "AI工具交付与验收报告-0.8.1.md"), "# 交付报告\n", "utf8");
    writeFileSync(join(project, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    writeFileSync(join(project, "package.json"), '{"version":"0.8.1"}\n', "utf8");
    writeFileSync(join(project, "audit", "behavior-contract.json"), '{"missingCoreEntryPoints":0}\n', "utf8");
    writeFileSync(join(project, "audit", "evidence", "current-ui-interactions.json"), '{"passed":14}\n', "utf8");
    writeFileSync(join(project, "audit", "evidence", "current-ui-interactions-artifacts", "case-1", "user-data", "Preferences"), "runtime cache\n", "utf8");
    writeFileSync(join(project, "audit", "arbitrary-short-root", "opening-docx", "user-data", "Preferences"), "C:\\Users\\audit\\machine-specific\n", "utf8");
    writeFileSync(join(project, "vendor", "inference-skill", "CLAUDE.md"), "runtime instructions\n", "utf8");
    writeFileSync(join(project, "vendor", "inference-skill", "verify_split_extreme.py"), "# verifier\n", "utf8");
    return { root, project, output };
  }

  function packageSource(project: string, output: string) {
    return spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", packageSourceScript, "-ProjectRoot", project, "-OutputPath", output],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    );
  }

  it("uses an allowlist and excludes Python caches from the archive", async () => {
    const { project, output } = projectFixture();
    mkdirSync(join(project, "vendor", "rules", "__pycache__"), { recursive: true });
    mkdirSync(join(project, "private"), { recursive: true });
    writeFileSync(join(project, "src", "main.ts"), "export {};\n", "utf8");
    writeFileSync(join(project, "vendor", "rules", "rule.md"), "rule\n", "utf8");
    writeFileSync(join(project, "vendor", "rules", "__pycache__", "rule.pyc"), "cache");
    writeFileSync(join(project, "private", "notes.txt"), "internal\n", "utf8");
    writeFileSync(join(project, ".npmrc"), "registry=https://registry.npmjs.org/\n", "utf8");

    const result = packageSource(project, output);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const archive = await JSZip.loadAsync(await import("node:fs/promises").then(({ readFile }) => readFile(output)));
    const entries = Object.keys(archive.files);
    expect(entries).toContain("ai-tool/README.md");
    expect(entries).toContain("ai-tool/AI工具交付与验收报告-0.8.1.md");
    expect(entries).toContain("ai-tool/pnpm-lock.yaml");
    expect(entries).toContain("ai-tool/src/main.ts");
    expect(entries).toContain("ai-tool/audit/behavior-contract.json");
    expect(entries).toContain("ai-tool/audit/evidence/current-ui-interactions.json");
    expect(entries).toContain("ai-tool/vendor/rules/rule.md");
    expect(entries).toContain("ai-tool/vendor/inference-skill/CLAUDE.md");
    expect(entries).toContain("ai-tool/vendor/inference-skill/verify_split_extreme.py");
    expect(entries.some((entry) => entry.includes("__pycache__") || entry.toLowerCase().endsWith(".pyc"))).toBe(false);
    expect(entries.some((entry) => entry.includes("current-ui-interactions-artifacts"))).toBe(false);
    expect(entries.some((entry) => entry.includes("audit/arbitrary-short-root/") || entry.includes("machine-specific"))).toBe(false);
    expect(entries.some((entry) => entry.includes("private/notes.txt") || entry.endsWith("/.npmrc"))).toBe(false);
  });

  it("aborts before creating an archive when an allowed source file contains a credential", () => {
    const { project, output } = projectFixture();
    const fakeCredential = ["sk", "liveproductioncredential0123456789"].join("-");
    writeFileSync(join(project, "src", "config.ts"), `export const value = "${fakeCredential}";\n`, "utf8");

    const result = packageSource(project, output);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("Source archive secret preflight failed: API key");
    expect(existsSync(output)).toBe(false);
  });

  it("rejects a source archive that omits an original inference runtime asset", () => {
    const { project, output } = projectFixture();
    rmSync(join(project, "vendor", "inference-skill", "CLAUDE.md"));

    const result = packageSource(project, output);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("vendor/inference-skill/CLAUDE.md is required");
    expect(existsSync(output)).toBe(false);
  });
});
