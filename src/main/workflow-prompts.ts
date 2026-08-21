import { z } from "zod";
import { originalStoryboardDuration } from "../shared/storyboard-duration";
import { ORIGINAL_POLISH_INSTRUCTIONS } from "./original-polish-prompt";
import type { StoryboardDraft } from "../shared/contracts";

export type CharacterProfile = {
  name: string;
  assetType: "character" | "scene" | "special-space";
  aliases: string[];
  identity: string;
  gender: string;
  age: string;
  appearance: string;
  hair: string;
  clothing: string;
  personality: string;
  visualPrompt: string;
};

export type StoryboardInference = {
  characters: CharacterProfile[];
  storyboards: StoryboardDraft[];
};

const storyboardItem = z.object({
  index: z.number().int().nonnegative().optional(),
  originalText: z.string().optional(),
  original_text: z.string().optional(),
  text: z.string().optional(),
  subjects: z.union([z.array(z.string()), z.string()]).optional(),
  prompt: z.string().min(1),
  duration: z.number().positive().max(600).optional(),
});

const characterItem = z.object({
  name: z.string().optional(),
  character_name: z.string().optional(),
  role_name: z.string().optional(),
  "角色名": z.string().optional(),
  "姓名": z.string().optional(),
  aliases: z.union([z.array(z.string()), z.string()]).optional(),
  "别名": z.union([z.array(z.string()), z.string()]).optional(),
  identity: z.string().optional(),
  "身份": z.string().optional(),
  position: z.string().optional(),
  "定位": z.string().optional(),
  gender: z.string().optional(),
  sex: z.string().optional(),
  "性别": z.string().optional(),
  age: z.union([z.string(), z.number()]).optional(),
  "年龄": z.union([z.string(), z.number()]).optional(),
  gender_age: z.string().optional(),
  genderAge: z.string().optional(),
  age_gender: z.string().optional(),
  "年龄性别": z.string().optional(),
  appearance: z.string().optional(),
  "外貌": z.string().optional(),
  hair: z.string().optional(),
  "发型": z.string().optional(),
  clothing: z.string().optional(),
  outfit: z.string().optional(),
  "服装": z.string().optional(),
  personality: z.string().optional(),
  "性格": z.string().optional(),
  "性格气质": z.string().optional(),
  visual_prompt: z.string().optional(),
  visualPrompt: z.string().optional(),
  character_prompt: z.string().optional(),
  "角色推理词": z.string().optional(),
  "角色提示词": z.string().optional(),
  asset_type: z.enum(["character", "scene", "special-space"]).optional(),
  assetType: z.enum(["character", "scene", "special-space"]).optional(),
});

const inferenceEnvelope = z.union([
  z.array(storyboardItem),
  z.object({ characters: z.array(characterItem).optional(), storyboards: z.array(storyboardItem) }),
  z.object({ characters: z.array(characterItem).optional(), scenes: z.array(storyboardItem) }),
]);

function fencedJson(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

function firstJsonValue(value: string): string {
  const source = fencedJson(value);
  const arrayStart = source.indexOf("[");
  const objectStart = source.indexOf("{");
  const start = [arrayStart, objectStart].filter((index) => index >= 0).sort((a, b) => a - b)[0];
  if (start === undefined) throw new Error("模型响应中没有 JSON 数据");

  const opening = source[start];
  const closing = opening === "[" ? "]" : "}";
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === opening) depth += 1;
    else if (char === closing) {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error("模型响应中的 JSON 未闭合");
}

function normalizeSubjects(value: string[] | string | undefined): string[] {
  if (Array.isArray(value)) return value.map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/[,，、]/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function firstText(...values: Array<string | undefined>): string {
  return values.map((value) => value?.trim() ?? "").find(Boolean) ?? "";
}

function scalarText(value: string | number | undefined): string {
  return value === undefined ? "" : String(value).trim();
}

function splitGenderAge(value: string): { gender: string; age: string } {
  const gender = value.match(/男性|女性|男孩|女孩|男童|女童|雄性|雌性|无性别|不适用|男|女/)?.[0] ?? "";
  const age = value.replace(gender, "").replace(/^[|/，、,\s]+|[|/，、,\s]+$/g, "");
  return { gender, age };
}

function normalizeCharacter(item: z.infer<typeof characterItem>): CharacterProfile {
  const name = firstText(item.name, item.character_name, item.role_name, item["角色名"], item["姓名"]);
  if (!name) throw new Error("角色结构校验失败: 角色名称不能为空");
  const appearance = firstText(item.appearance, item["外貌"]);
  const hair = firstText(item.hair, item["发型"]);
  const clothing = firstText(item.clothing, item.outfit, item["服装"]);
  const personality = firstText(item.personality, item["性格气质"], item["性格"]);
  const genderAge = firstText(item.gender_age, item.genderAge, item.age_gender, item["年龄性别"]);
  const split = splitGenderAge(genderAge);
  const gender = firstText(item.gender, item.sex, item["性别"], split.gender);
  const age = firstText(scalarText(item.age), scalarText(item["年龄"]), split.age);
  const visualPrompt = firstText(
    item.visual_prompt,
    item.visualPrompt,
    item.character_prompt,
    item["角色推理词"],
    item["角色提示词"],
  ) || [age, gender, appearance, hair, clothing, personality].filter(Boolean).join("，");
  if (!visualPrompt) throw new Error(`角色结构校验失败: “${name}”缺少角色推理词`);
  return {
    name,
    assetType: item.asset_type ?? item.assetType ?? "character",
    aliases: normalizeSubjects(item.aliases ?? item["别名"]),
    identity: firstText(item.identity, item.position, item["定位"], item["身份"]),
    gender,
    age,
    appearance,
    hair,
    clothing,
    personality,
    visualPrompt,
  };
}

function mergeCharacters(items: Array<z.infer<typeof characterItem>>): CharacterProfile[] {
  const characters = new Map<string, CharacterProfile>();
  for (const item of items) {
    const profile = normalizeCharacter(item);
    const key = profile.name.toLocaleLowerCase();
    const current = characters.get(key);
    if (!current) {
      characters.set(key, profile);
      continue;
    }
    characters.set(key, {
      name: current.name,
      assetType: current.assetType,
      aliases: Array.from(new Set([...current.aliases, ...profile.aliases])),
      identity: current.identity || profile.identity,
      gender: current.gender || profile.gender,
      age: current.age || profile.age,
      appearance: current.appearance || profile.appearance,
      hair: current.hair || profile.hair,
      clothing: current.clothing || profile.clothing,
      personality: current.personality || profile.personality,
      visualPrompt: current.visualPrompt || profile.visualPrompt,
    });
  }
  return [...characters.values()];
}

function normalizeStoryboards(items: Array<z.infer<typeof storyboardItem>>): StoryboardDraft[] {
  if (items.length === 0) throw new Error("模型没有返回任何分镜");
  return items.map((item, index) => {
    const originalText = item.originalText ?? item.original_text ?? item.text ?? "";
    return {
      index,
      originalText: originalText.trim(),
      subjects: normalizeSubjects(item.subjects),
      prompt: item.prompt.trim(),
      duration: originalStoryboardDuration(originalText),
    };
  });
}

export function parseInferenceResponse(responseText: string): StoryboardInference {
  let decoded: unknown;
  try {
    decoded = JSON.parse(firstJsonValue(responseText));
  } catch (error) {
    throw new Error(`分镜 JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`);
  }

  const result = inferenceEnvelope.safeParse(decoded);
  if (!result.success) {
    throw new Error(`分镜结构校验失败: ${result.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  const items = Array.isArray(result.data)
    ? result.data
    : "storyboards" in result.data
      ? result.data.storyboards
      : result.data.scenes;
  const characters = Array.isArray(result.data) ? [] : mergeCharacters(result.data.characters ?? []);
  return { characters, storyboards: normalizeStoryboards(items) };
}

export function parseStoryboardResponse(responseText: string): StoryboardDraft[] {
  return parseInferenceResponse(responseText).storyboards;
}

export function missingCharacterProfiles(characters: CharacterProfile[], storyboards: StoryboardDraft[]): string[] {
  const knownNames = new Set(
    characters.filter((character) => character.assetType === "character")
      .flatMap((character) => [character.name, ...character.aliases])
      .map((name) => name.trim().toLocaleLowerCase())
      .filter(Boolean),
  );
  return Array.from(new Set(
    storyboards.flatMap((storyboard) => storyboard.subjects ?? [])
      .map((name) => name.trim())
      .filter((name) => name && !knownNames.has(name.toLocaleLowerCase())),
  ));
}

export function formatCharacterRoster(characters: CharacterProfile[]): string {
  if (characters.length === 0) return "未识别到明确角色";
  const blocks = characters.map((character) => character.assetType === "scene"
    ? [character.name, "资产 | 场景", character.visualPrompt]
    : character.assetType === "special-space"
      ? [character.name, "资产 | 特殊空间", character.visualPrompt]
      : [
        character.name,
        `${character.identity || "原文未明确"} | ${character.gender || "原文未明确"} | ${character.age || "原文未明确"}`,
        character.visualPrompt,
      ]);
  const aliasComments = characters
    .filter((character) => character.assetType === "character" && character.aliases.length > 0)
    .map((character) => `# 角色别名 | ${character.name} | ${character.aliases.join("、")}`);
  const roster = blocks.map((block) => block.join("\r\n")).join("\r\n###\r\n");
  return aliasComments.length > 0 ? `${roster}\r\n\r\n${aliasComments.join("\r\n")}` : roster;
}

export function buildStoryboardPrompt(text: string, genre = "自动判断"): string {
  return [
    "你是影视角色设定师和分镜师。先通读全文提取角色并建立稳定角色档案，再把文案拆成连续、可直接生成画面的分镜。",
    `题材：${genre}`,
    "只输出 JSON，不要 Markdown。格式：",
    '{"characters":[{"name":"角色标准名","aliases":["别名"],"identity":"角色定位或人物关系","gender":"性别","age":"年龄阶段","appearance":"五官、肤色和身形","hair":"固定发型和发色","clothing":"固定服装和配饰","personality":"性格气质","visual_prompt":"完整且可直接用于生图的定妆照提示词"}],"storyboards":[{"original_text":"原文片段","subjects":["角色标准名"],"prompt":"具体画面提示词","duration":4}]}',
    "角色要求：提取所有有姓名、称谓或反复出现的角色；同一角色合并别名；不得只返回角色名称。",
    "角色表对应原版严格三行：标准名；定位 | 性别 | 年龄；完整定妆照提示词。characters 的每个对象必须提供这三行所需信息。",
    "角色推理词要求：visual_prompt 使用中文，独立描述年龄性别、面部、肤色、身形、发型发色、固定服装配饰、气质和辨识特征；保持各镜头外观一致；不要写动作、镜头、背景或画风。原文未明确的信息在对应字段写“原文未明确”，但 visual_prompt 仍需给出不违背原文的稳定视觉方案。",
    "分镜要求：覆盖全部原文；镜头顺序稳定；subjects 只填写 characters 中的角色标准名，不填场景或物品，无角色则为空数组；prompt 包含景别、动作、环境和光线；duration 按原声中文字数计算为 min(5,max(2,floor((字数+3)/6)))。",
    "输入文案：",
    text.trim(),
  ].join("\n");
}

export type OpeningMode = "general" | "enhanced" | "rewrite" | "variants";

export function buildOpeningPrompt(text: string, mode: OpeningMode = "general", title = ""): string {
  if (mode !== "rewrite") {
    const normalizedMode = mode === "enhanced" ? "enhanced" : "general";
    const candidateCount = normalizedMode === "enhanced" || mode === "variants" ? 10 : 5;
    return [
      `任务：分析题材并生成 ${candidateCount} 个风格不同的高留存推文开头。`,
      "每个开头提高前三句话的冲突、悬念和信息密度，保持原文事实、人物和后续情节。",
      normalizedMode === "enhanced"
        ? "增强要求：先通读全文，分别从冲突前置、反常识、结果倒叙、身份反差和限时危机等方向构思；候选之间不得只是同义改写。每个开头必须带自然过渡句和原文章节衔接标注，衔接标注逐字保留所选章节的原文第一句作为定位锚点。"
        : "通用要求：候选方向要有明显差异，语言自然，避免夸大原文没有的事实。",
      "为每个开头给出方向、结构和 0-100 的得分，并严格使用以下纯文本格式：",
      "【题材】 题材名称",
      "备选开头",
      "—— 开头 1（方向：方向名称，结构：结构名称，得分：90） ——",
      "开头正文",
      `（依次输出到开头 ${candidateCount}）`,
      "只输出题材和备选开头，不要复制、概括、改写或续写原文；软件会在生成后逐字追加完整原文。",
      "不要使用 Markdown 代码块。",
      `书名：${title.trim() || "未命名文案"}`,
      "原文：",
      text.trim(),
    ].join("\n");
  }
  return [
    "任务：重写开头，提高前三句话的冲突、悬念和信息密度。",
    "保持原文事实、人物和后续情节，不添加无法验证的信息。",
    "直接输出可用正文，不要解释修改过程。",
    `书名：${title.trim() || "未命名文案"}`,
    "原文：",
    text.trim(),
  ].join("\n");
}

export function finalizeOpeningOutput(generated: string, originalText: string): string {
  const marker = /(?:\r?\n)?抓取正文（原文，未优化）[\s\S]*$/u;
  const openings = generated.replace(marker, "").trim();
  if (!openings) throw new Error("模型没有返回开头正文");
  return `${openings}\n抓取正文（原文，未优化）\n========\n\n${originalText}`;
}

export function buildPolishPrompt(text: string, title = ""): string {
  return [
    ORIGINAL_POLISH_INSTRUCTIONS,
    `文案名称：${title.trim() || "未命名小说"}`,
    "原文：",
    text,
  ].join("\n");
}
