import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inferenceRuntimePaths } from "../src/main/inference-runtime";
import { prepareOriginalAgentWorkspace } from "../src/main/original-agent-inference";

const RUNTIME_ASSET_HASHES = {
  "CLAUDE.md": "50c4a08eb4c3e32f3000a7d1febc1cdc72608e6366be8d19521482083ebdf7e5",
  "verify_split_extreme.py": "745dd18ccf2a894c4fae04812bc6638029cc500a5e869ff91cfab29dbb2ab510",
} as const;
const ORIGINAL_CLAUDE_HASH = "edca24a4a65adc613a0753535d272856984e0f93730025c1c880c6c7c421e6b6";

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("original inference runtime assets", () => {
  const temporaryDirectories: string[] = [];
  const runtime = inferenceRuntimePaths(resolve("vendor"));

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
  });

  it("preserves the original verifier and the brand-normalized instruction contract", async () => {
    for (const [relativePath, expectedHash] of Object.entries(RUNTIME_ASSET_HASHES)) {
      expect(sha256(await readFile(join(runtime.skill, relativePath)))).toBe(expectedHash);
    }

    const normalized = await readFile(join(runtime.skill, "CLAUDE.md"), "utf8");
    const legacyBrand = String.fromCodePoint(0x6f2b, 0x725b);
    const legacyCommand = `/${["man", "niu", "-fenjing"].join("")}`;
    const restored = normalized
      .replace("AI工具分镜系统", `${legacyBrand}分镜系统`)
      .replace("/ai-tool-fenjing", legacyCommand);
    expect(sha256(Buffer.from(restored, "utf8"))).toBe(ORIGINAL_CLAUDE_HASH);
  });

  it("places the normalized CLAUDE.md at cwd and exposes only the AI工具 skill command", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "ai-tool-original-runtime-"));
    temporaryDirectories.push(workDir);
    await prepareOriginalAgentWorkspace({
      text: "测试小说正文。",
      workDir,
      runtime,
    }, "运行时资产");

    for (const relativePath of ["CLAUDE.md", "verify_split_extreme.py"] as const) {
      expect(sha256(await readFile(join(workDir, relativePath)))).toBe(RUNTIME_ASSET_HASHES[relativePath]);
    }
    expect(await readFile(join(workDir, ".claude", "skills", "ai-tool-fenjing", "SKILL.md"), "utf8"))
      .toContain("name: ai-tool-fenjing");
    expect(await readFile(join(workDir, "CLAUDE.md"), "utf8")).toContain("/ai-tool-fenjing");
  });

  it("pins the restored verifier's known 30-versus-40-character baseline mismatch", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "ai-tool-original-verifier-"));
    temporaryDirectories.push(workDir);
    await prepareOriginalAgentWorkspace({
      text: "测试小说正文。",
      workDir,
      runtime,
    }, "验证分句");
    await writeFile(join(workDir, "split_extreme_actual.txt"), "测试通过\nEXIT_CODE=0\n", "utf8");

    const result = spawnSync(runtime.python, [join(workDir, "verify_split_extreme.py")], {
      cwd: workDir,
      encoding: "utf8",
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
      windowsHide: true,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("6/7 passed");
    expect(result.stdout).toContain("31 chars seamless");
    expect(result.stdout).toContain("Must produce exactly 1 warning, got 0");
    expect(result.stderr).toBe("");
  });
});
