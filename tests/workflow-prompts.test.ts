import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ORIGINAL_POLISH_INSTRUCTIONS } from "../src/main/original-polish-prompt";
import {
  buildOpeningPrompt,
  buildPolishPrompt,
  buildStoryboardPrompt,
  finalizeOpeningOutput,
  formatCharacterRoster,
  missingCharacterProfiles,
  parseInferenceResponse,
  parseStoryboardResponse,
} from "../src/main/workflow-prompts";

describe("workflow prompts", () => {
  it("keeps the dynamically captured original polish instructions byte-for-byte", () => {
    expect(ORIGINAL_POLISH_INSTRUCTIONS).toHaveLength(3334);
    expect(ORIGINAL_POLISH_INSTRUCTIONS.endsWith("\n")).toBe(true);
    expect(createHash("sha256").update(ORIGINAL_POLISH_INSTRUCTIONS).digest("hex"))
      .toBe("ad356241f480828481cf1cb25662c9c4f765ba96526f2e63c6053362f2162291");
  });

  it("parses a fenced storyboard envelope and normalizes fields", () => {
    const parsed = parseStoryboardResponse(`结果如下：
      \`\`\`json
      {"storyboards":[
        {"original_text":"第一句","subjects":"小李、店员","prompt":"中景，小李推门进入商店","duration":4.4},
        {"text":"第二句","subjects":["小李"],"prompt":"特写，小李看向柜台"}
      ]}
      \`\`\`
    `);
    expect(parsed).toEqual([
      {
        index: 0,
        originalText: "第一句",
        subjects: ["小李", "店员"],
        prompt: "中景，小李推门进入商店",
        duration: 2,
      },
      {
        index: 1,
        originalText: "第二句",
        subjects: ["小李"],
        prompt: "特写，小李看向柜台",
        duration: 2,
      },
    ]);
  });

  it("parses character profiles and formats complete role inference prompts", () => {
    const parsed = parseInferenceResponse(JSON.stringify({
      characters: [
        {
          name: "江青羽",
          aliases: "小羽、江少爷",
          identity: "宗门弟子",
          gender: "男性",
          age: "青年",
          appearance: "清俊面容，身形修长",
          hair: "黑色长发，高束马尾",
          clothing: "白色劲装，银色护腕",
          personality: "克制坚毅",
          visual_prompt: "青年男性，清俊面容，身形修长，黑色高马尾，白色劲装和银色护腕，克制坚毅",
        },
      ],
      storyboards: [
        { original_text: "江青羽入场", subjects: ["江青羽"], prompt: "中景，江青羽走入大殿", duration: 4 },
      ],
    }));

    expect(parsed.characters).toMatchObject([{
      name: "江青羽",
      aliases: ["小羽", "江少爷"],
      identity: "宗门弟子",
      gender: "男性",
      age: "青年",
    }]);
    expect(missingCharacterProfiles(parsed.characters, parsed.storyboards)).toEqual([]);
    expect(formatCharacterRoster(parsed.characters).split(/\r?\n/)).toEqual([
      "江青羽",
      "宗门弟子 | 男性 | 青年",
      "青年男性，清俊面容，身形修长，黑色高马尾，白色劲装和银色护腕，克制坚毅",
      "",
      "# 角色别名 | 江青羽 | 小羽、江少爷",
    ]);
  });

  it("keeps legacy storyboard arrays parseable but reports their missing character profiles", () => {
    const parsed = parseInferenceResponse(JSON.stringify([
      { original_text: "旧分镜", subjects: ["旧主角"], prompt: "旧画面", duration: 4 },
    ]));
    expect(parsed.characters).toEqual([]);
    expect(parseStoryboardResponse(JSON.stringify([
      { original_text: "旧分镜", subjects: ["旧主角"], prompt: "旧画面", duration: 4 },
    ]))).toHaveLength(1);
    expect(missingCharacterProfiles(parsed.characters, parsed.storyboards)).toEqual(["旧主角"]);
  });

  it("rejects malformed or incomplete model output", () => {
    expect(() => parseStoryboardResponse("没有结构化数据")).toThrow("没有 JSON");
    expect(() => parseStoryboardResponse('[{"original_text":"缺提示词"}]')).toThrow("结构校验失败");
    expect(() => parseStoryboardResponse("[]")).toThrow("没有返回任何分镜");
  });

  it("builds prompts that preserve the source text and output contracts", () => {
    expect(buildStoryboardPrompt("原始小说", "悬疑")).toContain("original_text");
    expect(buildStoryboardPrompt("原始小说", "悬疑")).toContain("visual_prompt");
    expect(buildStoryboardPrompt("原始小说", "悬疑")).toContain("角色推理词");
    expect(buildStoryboardPrompt("原始小说", "悬疑")).toContain("原始小说");
    expect(buildOpeningPrompt("开场文字", "variants")).toContain("10 个");
    expect(buildOpeningPrompt("开场文字", "variants")).toContain("—— 开头 1");
    expect(buildPolishPrompt("待润色文字")).toContain("待润色文字");
    expect(buildPolishPrompt("待润色文字")).toContain("优先级0：剧情与代入感绝对红线");
    expect(buildPolishPrompt("待润色文字")).toContain("优先级2：对话标签自然化");
    expect(buildPolishPrompt("待润色文字")).toContain("11. 一级主线段落仅少量修改");
  });

  it("builds the original five-candidate general and ten-candidate enhanced opening prompts", () => {
    const general = buildOpeningPrompt("原文内容", "general", "测试书名");
    const enhanced = buildOpeningPrompt("原文内容", "enhanced", "测试书名");

    for (const prompt of [general, enhanced]) {
      expect(prompt).toContain("方向");
      expect(prompt).toContain("结构");
      expect(prompt).toContain("得分");
      expect(prompt).toContain("书名：测试书名");
      expect(prompt).toContain("逐字追加完整原文");
    }
    expect(general).toContain("生成 5 个");
    expect(general).toContain("开头 5");
    expect(enhanced).toContain("生成 10 个");
    expect(enhanced).toContain("章节衔接标注");
    expect(enhanced).toContain("增强要求");
    expect(general).toContain("通用要求");
    expect(enhanced).not.toBe(general);
    expect(buildOpeningPrompt("旧输入", "variants")).toContain("生成 10 个");
    expect(buildOpeningPrompt("旧输入", "rewrite")).toContain("重写开头");
    expect(buildPolishPrompt("待捋文", "文案甲")).toContain("文案名称：文案甲");
  });

  it("appends the untouched source text after model-generated openings", () => {
    const original = "第一章\r\n原文  保留空格";
    expect(finalizeOpeningOutput("【题材】 都市\n备选开头\n开头内容", original))
      .toBe(`【题材】 都市\n备选开头\n开头内容\n抓取正文（原文，未优化）\n========\n\n${original}`);
    expect(finalizeOpeningOutput("开头内容\n抓取正文（原文，未优化）\n========\n模型乱写正文", original))
      .toContain(`========\n\n${original}`);
    expect(finalizeOpeningOutput("开头内容\n抓取正文（原文，未优化）\n========\n模型乱写正文", original))
      .not.toContain("模型乱写正文");
  });
});
