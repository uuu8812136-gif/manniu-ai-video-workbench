import { describe, expect, it } from "vitest";
import type { WorkflowJob } from "../src/shared/contracts";
import {
  clampImageConcurrency,
  clampImageCount,
  hasConfiguredImageApiKey,
  normalizeImageSelection,
  normalizeEditedImagePrompt,
  parsePromptBatches,
  restoreStandaloneImageBatch,
  summarizeImageBatchCompletion,
} from "../src/renderer/src/pages/image-workbench-state";

describe("image workbench state", () => {
  it("detects public masked primary and pooled image API keys", () => {
    expect(hasConfiguredImageApiKey({})).toBe(false);
    expect(hasConfiguredImageApiKey({ imagegen_api_key: "********" })).toBe(true);
    expect(hasConfiguredImageApiKey({ imagegen_api_keys: "\n********\n" })).toBe(true);
  });

  it("parses original prompt batches and ignores comments", () => {
    expect(parsePromptBatches("# 备注\n角色甲\n红衣少女\n###\n角色乙\n\n白发少年")).toEqual([
      { name: "角色甲", prompt: "红衣少女" },
      { name: "角色乙", prompt: "白发少年" },
    ]);
  });

  it("limits parsed prompt batches to one hundred", () => {
    const source = Array.from({ length: 120 }, (_, index) => `名称${index}\n提示${index}`).join("\n###\n");
    expect(parsePromptBatches(source)).toHaveLength(100);
  });

  it("trims edited prompts and rejects empty saves", () => {
    expect(normalizeEditedImagePrompt("  雨夜中的红衣少女  ")).toBe("雨夜中的红衣少女");
    expect(normalizeEditedImagePrompt(" \n\t ")).toBeNull();
  });

  it("normalizes model sizes and clamps controls", () => {
    expect(normalizeImageSelection("gpt-image-2-pro", "16:9", "4K")).toEqual({ aspect: "16:9", resolution: "4K", size: "3840x2160" });
    expect(normalizeImageSelection("banana-pro", "missing", "4K")).toEqual({ aspect: "16:9", resolution: "1K", size: "1024x576" });
    expect(normalizeImageSelection("custom-image-model", "9:16", "4K")).toEqual({ aspect: "9:16", resolution: "默认", size: "" });
    expect(clampImageCount("gpt-image-2", 20)).toBe(10);
    expect(clampImageConcurrency("gpt-image-2-pro", 4)).toBe(2);
  });

  it("restores a tracked batch and keeps only the latest regeneration per card", () => {
    const makeJob = (id: string, createdAt: string, status: WorkflowJob["status"], output: unknown = null): WorkflowJob => ({
      id,
      type: "image.standalone",
      status,
      progress: status === "done" ? 100 : 40,
      input: { name: "角色甲", prompt: "红衣少女", batchName: "批次甲", workbenchKey: "card-1" },
      output,
      error: status === "error" ? "生成失败" : null,
      attempts: 1,
      createdAt,
      updatedAt: createdAt,
    });
    const restored = restoreStandaloneImageBatch([
      makeJob("old", "2026-01-01T00:00:00.000Z", "error"),
      makeJob("new", "2026-01-01T00:00:01.000Z", "done", {
        imagePath: "D:\\图\\one.png",
        imagePaths: ["D:\\图\\one.png"],
        outputDirectory: "D:\\图",
        provider: "openai",
      }),
    ], "批次甲");
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ key: "card-1", jobId: "new", status: "done", imagePaths: ["D:\\图\\one.png"] });
  });

  it("does not report saved results when every image job failed", () => {
    expect(summarizeImageBatchCompletion(["error", "error"])).toEqual({
      done: 0,
      failed: 2,
      cancelled: 0,
      notice: null,
      error: "本批次没有生成成功：失败 2，已停止 0",
    });
    expect(summarizeImageBatchCompletion(["done", "error"])).toMatchObject({
      done: 1,
      failed: 1,
      notice: expect.stringContaining("成功 1"),
    });
  });
});
