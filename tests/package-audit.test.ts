import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

type SkillResourceAudit = {
  files: number;
  textFiles: number;
};

type PackageAuditModule = {
  auditSkillResources(resourcesDirectory: string): SkillResourceAudit;
  findLocalWindowsUserPath(content: string): string | null;
  inferenceRuntimeFiles: string[];
  inferenceRuntimeAssetHashes: Map<string, string>;
};

const require = createRequire(import.meta.url);
const {
  auditSkillResources,
  findLocalWindowsUserPath,
  inferenceRuntimeFiles,
  inferenceRuntimeAssetHashes,
} = require("../scripts/audit-package.cjs") as PackageAuditModule;

describe("packaged skill resource audit", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function resourcesFixture(): string {
    const resources = mkdtempSync(join(tmpdir(), "ai-tool-package-audit-"));
    cleanup.push(resources);
    for (const name of ["inference-skill", "opening-skill", "hook-skill"]) {
      mkdirSync(join(resources, name, "nested"), { recursive: true });
      writeFileSync(join(resources, name, "nested", "rules.md"), "portable rules\n", "utf8");
    }
    return resources;
  }

  it("recursively accepts portable text resources and generic Windows examples", () => {
    const resources = resourcesFixture();
    writeFileSync(
      join(resources, "opening-skill", "nested", "examples.txt"),
      [
        String.raw`C:\Users\demo\Documents\AI工具`,
        String.raw`C:\Users\<username>\Documents\AI工具`,
        String.raw`C:/Users/example/Documents/AI工具`,
      ].join("\n"),
      "utf8",
    );

    expect(auditSkillResources(resources)).toEqual({ files: 4, textFiles: 4 });
  });

  it("requires the file-agent executable and protocol proxy in every package", () => {
    const normalized = inferenceRuntimeFiles.map((entry) => entry.replace(/\\/gu, "/"));
    expect(normalized).toContain("claude/bin/claude.exe");
    expect(normalized).toContain("inference-skill/claude_openai_proxy.py");
    expect(normalized).toContain("inference-skill/CLAUDE.md");
    expect(normalized).toContain("inference-skill/verify_split_extreme.py");
    expect(inferenceRuntimeAssetHashes.size).toBe(2);
  });

  it("rejects __pycache__ directories and pyc files at any depth", () => {
    const cacheResources = resourcesFixture();
    mkdirSync(join(cacheResources, "inference-skill", "nested", "__pycache__"));
    writeFileSync(join(cacheResources, "inference-skill", "nested", "__pycache__", "rules.pyc"), "cache");
    expect(() => auditSkillResources(cacheResources)).toThrow(/Python cache directory/u);

    const pycResources = resourcesFixture();
    writeFileSync(join(pycResources, "hook-skill", "nested", "rules.PYC"), "cache");
    expect(() => auditSkillResources(pycResources)).toThrow(/Python cache file/u);
  });

  it("rejects machine-specific Windows user paths in nested text resources", () => {
    const resources = resourcesFixture();
    writeFileSync(
      join(resources, "hook-skill", "nested", "generated.py"),
      String.raw`source = "C:\Users\uu\Documents\Codex\private.py"`,
      "utf8",
    );

    expect(() => auditSkillResources(resources)).toThrow(/Local Windows user path/u);
    expect(findLocalWindowsUserPath(String.raw`C:\Users\uu\Documents\Codex`)).toBeTruthy();
    expect(findLocalWindowsUserPath(String.raw`C:\Users\demo\Documents\example`)).toBeNull();
  });
});
