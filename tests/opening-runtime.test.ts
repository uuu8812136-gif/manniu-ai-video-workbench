import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { loadOriginalOpeningSystem, validateOriginalOpeningDraft } from "../src/main/opening-runtime";

const resourcesRoot = join(process.cwd(), "vendor");

function generalDraft(count = 5): string {
  return [
    "【题材】 都市重生",
    "备选开头",
    ...Array.from({ length: count }, (_, index) => [
      `—— 开头 ${index + 1}（方向：方向${index + 1}，结构：结构${index + 1}，得分：${90 - index}） ——`,
      `这是第${index + 1}个完整开头。`,
    ].join("\n")),
  ].join("\n");
}

function enhancedDraft(sourceSentence: string): string {
  return [
    "【题材】 都市重生",
    "备选开头",
    ...Array.from({ length: 10 }, (_, index) => [
      `—— 开头 ${index + 1}（方向：方向${index + 1}，结构：框架[${index + 1}]，得分：${90 - index}） ——`,
      `这是第${index + 1}个完整开头。`,
      "【过渡句】自然转入原文章节。",
      `【衔接：第1章 开场】原文第一句：${sourceSentence}`,
    ].join("\n")),
  ].join("\n");
}

describe("original opening runtime", () => {
  it("loads the original general skill and workbook examples", async () => {
    const system = await loadOriginalOpeningSystem(resourcesRoot, "general", "重生后，他回到高考前。公司里没人相信他。");
    expect(system).toContain("通用版小说推文开头");
    expect(system).toContain("唯一参考库");
    expect(system).toContain("程序从原版参考库");
    expect(system.length).toBeGreaterThan(10_000);
  });

  it("loads the enhanced hard rules and selected numbered frameworks", async () => {
    const system = await loadOriginalOpeningSystem(resourcesRoot, "enhanced", "斗罗大陆上，他觉醒了九尾天狐武魂和紫色魂环。");
    expect(system).toContain("增强版小说推文开头");
    expect(system).toContain("39条自检");
    expect(system).toMatch(/###\s+\[\d+\]/u);
  });

  it("enforces candidate counts and enhanced transition anchors", () => {
    expect(validateOriginalOpeningDraft(generalDraft(), "general", "原文")).toEqual([]);
    expect(validateOriginalOpeningDraft(generalDraft(4), "general", "原文")).toContain("必须恰好输出 5 个开头，当前识别到 4 个");
    const sourceSentence = "醒来时，窗外的雨还在下。";
    expect(validateOriginalOpeningDraft(enhancedDraft(sourceSentence), "enhanced", `第一章\n${sourceSentence}\n后文`)).toEqual([]);
    expect(validateOriginalOpeningDraft(enhancedDraft("模型编造的句子"), "enhanced", `第一章\n${sourceSentence}`))
      .toContain("开头 1 的衔接锚点不是原文原句");
  });
});
