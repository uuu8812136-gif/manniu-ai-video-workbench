import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runOriginalAgentInference } from "../src/main/original-agent-inference";
import { inferenceRuntimePaths } from "../src/main/inference-runtime";
import type { JobExecutionContext } from "../src/main/jobs";

const runRealAgent = process.env.RUN_REAL_CLAUDE_AGENT === "1";

function context(): JobExecutionContext {
  return {
    jobId: "real-claude-agent-probe",
    signal: new AbortController().signal,
    updateProgress: () => {},
    emit: () => {},
    complete: () => {},
  };
}

describe.skipIf(!runRealAgent)("bundled Claude file Agent", () => {
  it("executes the real Write/Edit/Bash loop through the local OpenAI-compatible probe", async () => {
    const resourcesRoot = resolve("vendor");
    const workDir = await mkdtemp(join(tmpdir(), "ai-tool-real-agent-"));
    try {
      const result = await runOriginalAgentInference({
        text: "雨夜里，林夏推开旧车站的门。她看见管理员周叔留下的信，决定天亮前赶往北城码头。",
        title: "协议探针推理",
        genre: "都市悬疑",
        workDir,
        runtime: inferenceRuntimePaths(resourcesRoot),
        agent: {
          claudePath: join(resourcesRoot, "claude", "bin", "claude.exe"),
          baseUrl: process.env.ORIGINAL_AGENT_TEST_BASE_URL ?? "http://127.0.0.1:18765",
          apiKey: "sk-placeholder-test-key",
          model: "local-agent-probe",
        },
        context: context(),
      });

      expect(result.characters.map((character) => character.name)).toContain("林夏");
      expect(result.storyboards).toHaveLength(2);
      expect(result.storyboards.every((storyboard) => storyboard.prompt?.trim())).toBe(true);
      expect(await readFile(result.artifacts.csvPath, "utf8")).toContain("@林夏");
      expect(result.stages).toContain("semantic-review");
    } finally {
      await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 180_000);
});
