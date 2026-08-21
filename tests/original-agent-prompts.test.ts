import { describe, expect, it } from "vitest";
import {
  originalInferenceBatchPrompt,
  originalInferenceBatchRepairPrompt,
  originalInferenceFullRepairPrompt,
  originalInferenceSemanticReviewPrompt,
  originalInferenceSkeletonPrompt,
  originalInferenceSkeletonRepairPrompt,
  originalOpeningAgentPrompt,
  originalOpeningRepairPrompt,
} from "../src/main/original-agent-prompts";

describe("original file-agent prompts", () => {
  it("keeps skeleton generation separate from D-column generation", () => {
    const prompt = originalInferenceSkeletonPrompt({ title: "测试小说", genre: "悬疑" });
    expect(prompt).toContain("/ai-tool-fenjing");
    expect(prompt).toContain("check_bcol.py 测试小说.csv --origin=测试小说.txt");
    expect(prompt).toContain("check_dcol.py --roster-only 测试小说.csv");
    expect(prompt).toContain("禁止填写D列");
  });

  it("locks D-column work and repair to the current batch", () => {
    const batch = originalInferenceBatchPrompt({
      title: "测试小说",
      total: 40,
      remaining: 30,
      indexes: [11, 12, 13],
    });
    expect(batch).toContain("唯一允许填写的镜号：11、12、13");
    expect(batch).toContain("仍有 30 镜 D列(画面提示词)为空");
    expect(batch).toContain("N个空D=N次Edit");
    expect(batch).toContain("禁止 Write 全表");
    expect(batch).toContain("通用反应替代核心内容和连续镜头同质化");

    const repair = originalInferenceBatchRepairPrompt({
      title: "测试小说",
      indexes: [11, 13],
      report: "STRUCTURED_VALIDATION_REPORT",
      repeated: true,
    });
    expect(repair).toContain("--rows=11,13");
    expect(repair).toContain("从头重写报告中的整格D列");
    expect(repair).toContain("STRUCTURED_VALIDATION_REPORT");

    const fullRepair = originalInferenceFullRepairPrompt({
      title: "测试小说",
      report: "DCOL.PRONOUN",
      repeated: true,
    });
    expect(fullRepair).toContain("步骤5：校验修复");
    expect(fullRepair).toContain("code、row、row_end、target、strategy");
    expect(fullRepair).toContain("从头重写整格D列");
  });

  it("keeps skeleton repair and semantic review scoped", () => {
    expect(originalInferenceSkeletonRepairPrompt({ title: "测试小说", report: "BCOL.EMPTY" }))
      .toContain("D列全部留空");
    const review = originalInferenceSemanticReviewPrompt("测试小说");
    expect(review).toContain("全表语义复核");
    expect(review).toContain("匿名能量层级、光影、轮廓、投影、虚影或半透明推演");
    expect(review).toContain("只修改明确需要修正的D列");
  });

  it("drives opening output through the original file contract", () => {
    expect(originalOpeningAgentPrompt("general")).toContain("5 个备选开头");
    expect(originalOpeningAgentPrompt("enhanced")).toContain("10 个备选开头");
    expect(originalOpeningRepairPrompt("general", ["缺少开头 5"])).toContain("缺少开头 5");
    expect(originalOpeningRepairPrompt("general", [])).toContain("output_kaitou.txt");
  });
});
