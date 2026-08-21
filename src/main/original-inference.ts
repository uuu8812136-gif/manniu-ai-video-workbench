import { mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import type { StoryboardDraft } from "../shared/contracts";
import { readCsvFile, writeCsvFileAtomic, writeTextFileAtomic } from "./file-workflows";
import { PauseJobError, type JobExecutionContext } from "./jobs";
import type { TextModelResult } from "./model-clients";
import {
  readInferenceRule,
  runInferenceScript,
  scriptFailure,
  type InferenceRuntimePaths,
} from "./inference-runtime";
import { parseInferenceResponse, type CharacterProfile, type StoryboardInference } from "./workflow-prompts";

export type OriginalInferenceStage =
  | "blueprint"
  | "assets"
  | "assets-repair"
  | "segmentation"
  | "segmentation-repair"
  | "storyboards"
  | "storyboard-repair"
  | "full-table-repair"
  | "semantic-review";

export type OriginalInferenceModelCall = (request: {
  stage: OriginalInferenceStage;
  system: string;
  user: string;
  progressStart: number;
  progressEnd: number;
  maxOutputTokens?: number;
}) => Promise<TextModelResult>;

export type OriginalInferenceArtifacts = {
  sourcePath: string;
  arcPath: string;
  rosterPath: string;
  markedPath: string;
  sentencesPath: string;
  csvPath: string;
  bcolSnapshotPath: string;
  bcolReportPath: string;
  dcolReportPath: string;
  rosterReportPath: string;
  failureDiagnosticsPath: string;
  workDir: string;
};

export type OriginalInferenceResult = StoryboardInference & {
  artifacts: OriginalInferenceArtifacts;
  model: string | null;
  usage: unknown[];
  stages: OriginalInferenceStage[];
  legacyFastPath: boolean;
};

const rosterEnvelope = z.object({ roster: z.string().min(1) });
const arcEnvelope = z.object({ arc: z.string().min(1) });
const markedEnvelope = z.object({
  marked_text: z.string().min(1).optional(),
  markedText: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
});
const promptPatch = z.object({ index: z.number().int().positive(), prompt: z.string().trim().min(1) });
const promptEnvelope = z.object({ prompts: z.array(promptPatch).optional(), patches: z.array(promptPatch).optional() });

type OriginalValidationIssue = {
  code: string;
  target: string;
  row: number | null;
  rowEnd: number | null;
  reason: string;
  strategy: string;
  fixable: boolean;
};

type OriginalValidationReport = {
  errorCount: number;
  issues: OriginalValidationIssue[];
};

export type OriginalRepairScope = {
  issueRows: number[];
  roster: boolean;
  unregistered: boolean;
  firstCode: string;
};

function cleanModelText(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json|text|txt|csv)?\s*([\s\S]*?)\s*```$/iu);
  return fenced?.[1]?.trim() ?? trimmed;
}

function firstJson(value: string): unknown {
  const source = cleanModelText(value);
  const starts = [source.indexOf("{"), source.indexOf("[")].filter((index) => index >= 0).sort((a, b) => a - b);
  if (starts.length === 0) throw new Error("模型响应中没有 JSON 数据");
  const start = starts[0];
  const opening = source[start];
  const closing = opening === "{" ? "}" : "]";
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
      if (depth === 0) return JSON.parse(source.slice(start, index + 1)) as unknown;
    }
  }
  throw new Error("模型响应中的 JSON 未闭合");
}

function safeTitle(value: string): string {
  const safe = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_").replace(/[. ]+$/u, "").slice(0, 80);
  return safe || "未命名小说";
}

function nonCommentLines(block: string): string[] {
  return block.split(/\r?\n/gu).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
}

function structuredCharacterDetails(visualPrompt: string): Pick<CharacterProfile, "appearance" | "hair" | "clothing" | "personality"> {
  const stableDescription = visualPrompt.match(
    /全身后视图[。．][，,\s]*([\s\S]*?)[，,\s]*(?:(?:100%纯正的)?顶级3D国漫|顶级3D国漫渲染)/u,
  )?.[1]?.replace(/^[，,。；;\s]+|[，,。；;\s]+$/gu, "") ?? "";
  if (!stableDescription) return { appearance: "", hair: "", clothing: "", personality: "" };

  const clauses = stableDescription.split(/[，,；;]/u).map((item) => item.trim()).filter(Boolean);
  const hairClauses = clauses.filter((item) => /(?:头发|发型|发色|长发|短发|卷发|直发|寸头|刘海|马尾|发髻|鬓发|光头)/u.test(item));
  const clothingClauses = clauses.filter((item) => /(?:衣|袍|裙|裤|鞋|靴|甲|服|装|披风|斗篷|腰带|护腕|冠|簪|耳饰|项链|配饰)/u.test(item));
  const personalityClauses = clauses.filter((item) => /(?:气质|沉稳|冷峻|克制|坚毅|温和|儒雅|威严|警觉|灵动|活泼|阴郁|凌厉|从容)/u.test(item));
  const claimed = new Set([...hairClauses, ...clothingClauses, ...personalityClauses]);
  const appearanceClauses = clauses.filter((item) => !claimed.has(item));

  return {
    appearance: (appearanceClauses.length > 0 ? appearanceClauses : clauses).join("，"),
    hair: hairClauses.join("，"),
    clothing: clothingClauses.join("，"),
    personality: personalityClauses.join("，"),
  };
}

export function parseOriginalRoster(value: string): CharacterProfile[] {
  const normalized = value.replace(/^\ufeff/u, "").replace(/\r\n?/gu, "\n").trim();
  const assetSection = normalized.split(/\n(?=#(?!##))/u)[0]?.trim() ?? "";
  const blocks = assetSection.split(/^\s*###\s*$/gmu).map((block) => block.trim()).filter(Boolean);
  const aliases = new Map<string, string[]>();
  for (const line of normalized.split("\n")) {
    const match = line.match(/^#\s*角色别名\s*\|\s*([^|]+)\|\s*(.+)$/u);
    if (!match) continue;
    aliases.set(match[1].trim(), match[2].split(/[、,，]/u).map((item) => item.trim()).filter(Boolean));
  }
  if (blocks.length === 0) throw new Error("角色表没有任何人物、场景或特殊空间资产块");
  return blocks.map((block, blockIndex) => {
    const lines = nonCommentLines(block);
    if (lines.length !== 3) throw new Error(`角色表第 ${blockIndex + 1} 块必须严格包含 3 个非空内容行`);
    const [name, descriptor, visualPrompt] = lines;
    if (!name || !descriptor || !visualPrompt) throw new Error(`角色表第 ${blockIndex + 1} 块存在空行`);
    if (/^资产\s*\|\s*场景$/u.test(descriptor)) {
      if (!visualPrompt.startsWith("一张16:9比例的宽幅图像")) throw new Error(`场景“${name}”参考图提示词开头不符合原版模板`);
      if (!visualPrompt.includes("纯场景无人物")) throw new Error(`场景“${name}”缺少“纯场景无人物”约束`);
      return {
        name,
        aliases: [],
        identity: "资产",
        gender: "",
        age: "",
        appearance: "",
        hair: "",
        clothing: "",
        personality: "",
        visualPrompt,
        assetType: "scene",
      };
    }
    if (/^资产\s*\|\s*特殊空间$/u.test(descriptor)) {
      if (!visualPrompt.startsWith("一张16:9比例的宽幅图像")) throw new Error(`特殊空间“${name}”参考图提示词开头不符合原版模板`);
      if (!visualPrompt.includes("纯场景无人物")) throw new Error(`特殊空间“${name}”缺少“纯场景无人物”约束`);
      return {
        name,
        aliases: [],
        identity: "资产",
        gender: "",
        age: "",
        appearance: "",
        hair: "",
        clothing: "",
        personality: "",
        visualPrompt,
        assetType: "special-space",
      };
    }
    const parts = descriptor.split("|").map((item) => item.trim());
    if (parts.length < 3 || parts.some((item) => !item)) {
      throw new Error(`人物“${name}”第 2 行必须是“定位 | 性别 | 年龄描述”`);
    }
    const requiredPromptTerms = [
      "一张16:9比例的宽幅图像",
      "物理隔离排版规则",
      "左侧三分之一区域",
      "面部特写",
      "右侧三分之二区域",
      "全身正视图",
      "全身侧视图",
      "全身后视图",
      "顶级3D国漫",
      "虚幻引擎5渲染",
      "辛烷渲染",
      "高级材质质感",
      "绝对标准的人体比例严禁大头娃娃",
      "双眼平视镜头",
      "绝对无表情",
      "不准笑",
      "双臂自然下垂",
      "纯白干净的背景",
      "绝对没有任何环境杂物",
      "绝对禁止2D动漫",
      "绝对禁止赛璐璐",
      "绝对禁止真人摄影",
      "绝对禁止低模",
    ];
    const missing = requiredPromptTerms.filter((term) => !visualPrompt.includes(term));
    if (missing.length > 0) throw new Error(`人物“${name}”定妆照提示词缺少: ${missing.join("、")}`);
    const details = structuredCharacterDetails(visualPrompt);
    return {
      name,
      aliases: aliases.get(name) ?? [],
      identity: parts[0],
      gender: parts[1],
      age: parts.slice(2).join(" | "),
      ...details,
      visualPrompt,
      assetType: "character",
    };
  });
}

function rosterTextFromResponse(value: string): string {
  try {
    const parsed = rosterEnvelope.safeParse(firstJson(value));
    if (parsed.success) return parsed.data.roster.replace(/\\n/gu, "\n").trim();
  } catch {
    // Raw three-line roster output is accepted for providers without JSON mode.
  }
  return cleanModelText(value);
}

function arcTextFromResponse(value: string): string {
  let arc: string;
  try {
    const parsed = arcEnvelope.safeParse(firstJson(value));
    arc = parsed.success ? parsed.data.arc.replace(/\\n/gu, "\n").trim() : cleanModelText(value);
  } catch {
    arc = cleanModelText(value);
  }
  const required = ["开场", "高潮", "收尾"];
  const missing = required.filter((term) => !arc.includes(term));
  if (missing.length > 0) throw new Error(`视觉蓝图缺少必填锚点: ${missing.join("、")}`);
  return arc;
}

function markedTextFromResponse(value: string): string {
  try {
    const parsed = markedEnvelope.safeParse(firstJson(value));
    if (parsed.success) return (parsed.data.marked_text ?? parsed.data.markedText ?? parsed.data.text ?? "").trim();
  } catch {
    // Raw marked text is accepted for providers without JSON mode.
  }
  return cleanModelText(value);
}

function promptPatches(value: string): Array<z.infer<typeof promptPatch>> {
  const parsedValue = firstJson(value);
  if (Array.isArray(parsedValue)) return z.array(promptPatch).parse(parsedValue);
  const parsed = promptEnvelope.parse(parsedValue);
  return parsed.prompts ?? parsed.patches ?? [];
}

function validationReport(value: string): OriginalValidationReport {
  const parsed = JSON.parse(value) as { error_count?: unknown; issues?: unknown };
  const rawIssues = Array.isArray(parsed.issues) ? parsed.issues : [];
  const issues = rawIssues.flatMap((raw): OriginalValidationIssue[] => {
    if (!raw || typeof raw !== "object") return [];
    const issue = raw as Record<string, unknown>;
    if (typeof issue.code !== "string" || typeof issue.target !== "string") return [];
    const row = Number.isInteger(issue.row) && Number(issue.row) > 0 ? Number(issue.row) : null;
    const rowEnd = Number.isInteger(issue.row_end) && Number(issue.row_end) >= (row ?? 1)
      ? Number(issue.row_end)
      : row;
    return [{
      code: issue.code,
      target: issue.target,
      row,
      rowEnd,
      reason: typeof issue.reason === "string" ? issue.reason : "",
      strategy: typeof issue.strategy === "string" ? issue.strategy : "",
      fixable: issue.fixable !== false,
    }];
  });
  return {
    errorCount: Number.isInteger(parsed.error_count) ? Number(parsed.error_count) : issues.length,
    issues,
  };
}

export function originalRepairScope(
  report: string,
  allowed?: ReadonlySet<number>,
): OriginalRepairScope {
  let parsed: OriginalValidationReport;
  try {
    parsed = validationReport(report);
  } catch {
    return { issueRows: [], roster: false, unregistered: true, firstCode: "REPORT.INVALID" };
  }
  const issueRows = new Set<number>();
  let roster = false;
  let unregistered = parsed.issues.length === 0 && parsed.errorCount > 0;
  for (const issue of parsed.issues) {
    roster ||= issue.target === "roster";
    unregistered ||= !issue.fixable
      || issue.target === "runtime"
      || issue.target === "fallback"
      || issue.code.endsWith(".UNCLASSIFIED");
    if (issue.row === null) {
      if (issue.target !== "roster") unregistered = true;
      continue;
    }
    const end = issue.rowEnd ?? issue.row;
    for (let row = issue.row; row <= end; row += 1) {
      if (!allowed || allowed.has(row)) issueRows.add(row);
    }
  }
  return {
    issueRows: [...issueRows].sort((a, b) => a - b),
    roster,
    unregistered,
    firstCode: parsed.issues[0]?.code ?? (parsed.errorCount > 0 ? "REPORT.EMPTY" : ""),
  };
}

function assertPromptPatchContract(
  patches: Array<z.infer<typeof promptPatch>>,
  allowed: ReadonlySet<number>,
  required: readonly number[],
): void {
  const seen = new Set<number>();
  for (const patch of patches) {
    if (seen.has(patch.index)) throw new Error(`模型重复返回了镜号 ${patch.index}`);
    seen.add(patch.index);
    if (!allowed.has(patch.index)) throw new Error(`模型越权修改了批次外镜号 ${patch.index}`);
  }
  const missing = required.filter((index) => !seen.has(index));
  if (missing.length > 0) throw new Error(`模型没有返回要求修复的镜号：${missing.join(",")}`);
}

function patchContractReport(message: string, rows: readonly number[]): string {
  return JSON.stringify({
    schema_version: 1,
    checker: "model_patch_contract",
    status: "failed",
    error_count: rows.length || 1,
    issues: (rows.length > 0 ? rows : [null]).map((row) => ({
      code: "MODEL.PATCH_CONTRACT",
      scope: row === null ? "global" : "shot",
      row,
      row_end: row,
      target: "d_col",
      reason: message,
      strategy: "严格返回当前允许镜号，每个镜号恰好一次。",
      fixable: true,
    })),
  }, null, 2);
}

function legacyCombinedResponse(value: string): StoryboardInference | null {
  try {
    const decoded = firstJson(value);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
    const candidate = decoded as Record<string, unknown>;
    if (!Array.isArray(candidate.storyboards) && !Array.isArray(candidate.scenes)) return null;
    return parseInferenceResponse(JSON.stringify(decoded));
  } catch {
    return null;
  }
}

function progress(context: JobExecutionContext, value: number, message: string, detail?: unknown): void {
  context.updateProgress(value, message, detail);
}

function compactFailure(result: { stdout: string; stderr: string }): string {
  return [result.stderr, result.stdout].filter(Boolean).join("\n").trim().slice(-12_000);
}

async function existingText(path: string): Promise<string | null> {
  return readFile(path, "utf8")
    .then((value) => value.replace(/^\ufeff/u, "").trim())
    .catch(() => null);
}

async function csvRows(csvPath: string): Promise<Array<Record<string, string>>> {
  const parsed = await readCsvFile(csvPath);
  const expected = ["编号", "原声", "秒数", "画面提示词"];
  if (expected.some((column) => !parsed.columns.includes(column))) {
    throw new Error(`CSV 缺少固定表头: ${expected.join(",")}`);
  }
  return parsed.rows;
}

async function writeRows(csvPath: string, rows: Array<Record<string, string>>): Promise<void> {
  await writeCsvFileAtomic(csvPath, rows, { columns: ["编号", "原声", "秒数", "画面提示词"], bom: true });
}

export function restoreOriginalAbcRows(
  snapshotRows: Array<Record<string, string>>,
  currentRows: Array<Record<string, string>>,
): Array<Record<string, string>> {
  const prompts = new Map<number, string>();
  for (const row of currentRows) {
    const index = Number(row["编号"]);
    if (!Number.isInteger(index) || prompts.has(index)) continue;
    prompts.set(index, row["画面提示词"] ?? "");
  }
  return snapshotRows.map((row) => {
    const index = Number(row["编号"]);
    return {
      编号: row["编号"] ?? "",
      原声: row["原声"] ?? "",
      秒数: row["秒数"] ?? "",
      画面提示词: prompts.get(index) ?? "",
    };
  });
}

export function applyOriginalPromptPatches(
  rows: Array<Record<string, string>>,
  patches: Array<z.infer<typeof promptPatch>>,
  allowed?: Set<number>,
): void {
  const byIndex = new Map(rows.map((row) => [Number(row["编号"]), row]));
  const seen = new Set<number>();
  for (const patch of patches) {
    if (seen.has(patch.index)) throw new Error(`模型重复返回了镜号 ${patch.index}`);
    seen.add(patch.index);
    if (allowed && !allowed.has(patch.index)) throw new Error(`模型越权修改了批次外镜号 ${patch.index}`);
    const row = byIndex.get(patch.index);
    if (!row) throw new Error(`模型返回了不存在的镜号 ${patch.index}`);
    row["画面提示词"] = patch.prompt.trim();
  }
}

function missingBatchRows(rows: Array<Record<string, string>>, expected: number[]): number[] {
  const byIndex = new Map(rows.map((row) => [Number(row["编号"]), row]));
  return expected.filter((index) => !byIndex.get(index)?.["画面提示词"]?.trim());
}

function fantasyGenre(genre: string): boolean {
  return /(?:玄幻|修真|修仙|仙侠|斗罗)/u.test(genre);
}

function compactStoryboardRows(rows: Array<Record<string, string>>): Array<{ index: number; original: string; prompt: string }> {
  return rows.map((row) => ({
    index: Number(row["编号"]),
    original: row["原声"] ?? "",
    prompt: row["画面提示词"] ?? "",
  }));
}

function physicalSceneContext(
  rows: Array<Record<string, string>>,
  assets: CharacterProfile[],
): { current: string[]; recentTransitions: Array<{ index: number; scenes: string[] }> } {
  const sceneNames = assets.filter((asset) => asset.assetType === "scene").map((asset) => asset.name);
  let current: string[] = [];
  const transitions: Array<{ index: number; scenes: string[] }> = [];
  for (const row of rows) {
    const prompt = row["画面提示词"] ?? "";
    const mentioned = sceneNames.filter((name) => prompt.includes(`@${name}`));
    if (mentioned.length > 0) {
      current = mentioned;
      transitions.push({ index: Number(row["编号"]), scenes: [...current] });
    } else if (/(?:离开|离去|走出|退出|驶离)/u.test(row["原声"] ?? "")) {
      current = [];
      transitions.push({ index: Number(row["编号"]), scenes: [] });
    }
  }
  return { current, recentTransitions: transitions.slice(-10) };
}

async function validate(
  runtime: InferenceRuntimePaths,
  script: string,
  args: string[],
  workDir: string,
  signal: AbortSignal,
  label: string,
): Promise<void> {
  const result = await runInferenceScript(runtime, script, args, { cwd: workDir, signal });
  if (result.code !== 0) throw scriptFailure(label, result);
}

async function pauseOriginalInference(options: {
  message: string;
  stage: string;
  workDir: string;
  diagnosticsPath: string;
  reportPaths: string[];
  errorCategory: string;
  rows: Array<Record<string, string>>;
  context: JobExecutionContext;
}): Promise<never> {
  const completedIndexes = options.rows
    .filter((row) => row["画面提示词"]?.trim())
    .map((row) => Number(row["编号"]))
    .filter((index) => Number.isInteger(index) && index > 0);
  const existingReports = (await Promise.all(options.reportPaths.map(async (path) =>
    (await existingText(path)) === null ? null : path))).filter((path): path is string => path !== null);
  await writeTextFileAtomic(options.diagnosticsPath, [
    "AI工具 novel inference failure diagnostics",
    `work_dir=${options.workDir}`,
    `stage=${options.stage}`,
    `error_category=${options.errorCategory}`,
    `completed_indexes=${completedIndexes.join(",")}`,
    `reports=${existingReports.join(";")}`,
    `reason=${options.message}`,
    "",
  ].join("\n"));
  const detail = {
    stage: options.stage,
    workDir: options.workDir,
    reportPaths: [...new Set([...existingReports, options.diagnosticsPath])],
    errorCategory: options.errorCategory,
    completedIndexes,
  };
  options.context.emit("warning", "推理任务已暂停，工作文件和诊断报告已保留", detail);
  throw new PauseJobError(`${options.message}。工作目录已保留：${options.workDir}`, detail);
}

export async function runOriginalInference(options: {
  text: string;
  title: string;
  genre: string;
  workDir: string;
  runtime: InferenceRuntimePaths;
  context: JobExecutionContext;
  callModel: OriginalInferenceModelCall;
  allowLegacyFastPath?: boolean;
}): Promise<OriginalInferenceResult> {
  const title = safeTitle(options.title);
  const workDir = options.workDir;
  const sourcePath = join(workDir, `${title}.txt`);
  const arcPath = join(workDir, `${title}_arc.txt`);
  const rosterPath = join(workDir, "角色表.txt");
  const markedPath = join(workDir, `${title}_marked.txt`);
  const sentencesPath = join(workDir, `${title}_sentences.txt`);
  const csvPath = join(workDir, `${title}.csv`);
  const bcolSnapshotPath = join(workDir, `${title}_bcol_snapshot.csv`);
  const bcolReportPath = join(workDir, "bcol_validation_report.json");
  const dcolReportPath = join(workDir, "dcol_validation_report.json");
  const rosterReportPath = join(workDir, "roster_validation_report.json");
  const failureDiagnosticsPath = join(workDir, "failure_diagnostics.txt");
  const artifacts = {
    sourcePath,
    arcPath,
    rosterPath,
    markedPath,
    sentencesPath,
    csvPath,
    bcolSnapshotPath,
    bcolReportPath,
    dcolReportPath,
    rosterReportPath,
    failureDiagnosticsPath,
    workDir,
  };
  await mkdir(workDir, { recursive: true });
  await writeTextFileAtomic(sourcePath, options.text);

  const [
    skill,
    assetRules,
    promptRules,
    visualRules,
    quickLookup,
    emotionTone,
    effectTriggers,
    rosterTemplate,
    fantasyRules,
  ] = await Promise.all([
    readInferenceRule(options.runtime, "SKILL.md"),
    readInferenceRule(options.runtime, "references/asset-extraction.md"),
    readInferenceRule(options.runtime, "references/prompt-assembly.md"),
    readInferenceRule(options.runtime, "references/visual-reasoning.md"),
    readInferenceRule(options.runtime, "references/quick-lookup.md"),
    readInferenceRule(options.runtime, "references/emotion-tone.md"),
    readInferenceRule(options.runtime, "references/effect-triggers.txt"),
    readInferenceRule(options.runtime, "references/roster-template.txt"),
    readInferenceRule(options.runtime, "references/fantasy-pack.md"),
  ]);
  const assetSystem = `${skill}\n\n# 角色表详规\n${assetRules}\n\n# 原版角色表模板\n${rosterTemplate}`;
  const segmentationSystem = `${skill}\n\n# 角色表与分句完整细则\n${assetRules}`;
  const results: TextModelResult[] = [];
  const stages: OriginalInferenceStage[] = [];
  const call = async (request: Parameters<OriginalInferenceModelCall>[0]): Promise<TextModelResult> => {
    stages.push(request.stage);
    const result = await options.callModel(request);
    results.push(result);
    return result;
  };

  let arcText = "";
  if (!options.allowLegacyFastPath) {
    const recoveredArc = await existingText(arcPath);
    if (recoveredArc) {
      try {
        arcText = arcTextFromResponse(recoveredArc);
        options.context.emit("info", "已从断点恢复视觉蓝图", { arcPath });
      } catch {
        arcText = "";
      }
    }
    if (!arcText) {
      progress(options.context, 3, "正在建立原版视觉蓝图");
      const blueprintResult = await call({
        stage: "blueprint",
        progressStart: 3,
        progressEnd: 8,
        maxOutputTokens: 4_000,
        system: skill,
        user: [
          "只执行原版步骤0：通读全文，确定开场氛围、高潮区间和收尾意境三个视觉锚点。",
          "不得改写原文，不得提前生成角色表或分镜。",
          "只返回 JSON：{\"arc\":\"开场氛围：...\\n高潮区间：...\\n收尾意境：...\"}。",
          `题材：${options.genre || "自动判断"}`,
          "小说原文：",
          options.text,
        ].join("\n"),
      });
      arcText = arcTextFromResponse(blueprintResult.text);
      await writeTextFileAtomic(arcPath, arcText);
    }
  }

  let rosterText = options.allowLegacyFastPath ? "" : await existingText(rosterPath) ?? "";
  let assets: CharacterProfile[] = [];
  if (rosterText) {
    try {
      assets = parseOriginalRoster(rosterText);
      options.context.emit("info", "已从断点恢复角色与场景资产", { rosterPath, assets: assets.length });
    } catch {
      rosterText = "";
    }
  }
  if (!rosterText) {
    progress(options.context, 9, "正在读取原版角色与分镜规则");
    let assetFailure = "";
    for (let attempt = 0; attempt < 3 && !rosterText; attempt += 1) {
      const assetResult = await call({
        stage: attempt === 0 ? "assets" : "assets-repair",
        progressStart: 9,
        progressEnd: 18,
        maxOutputTokens: 24_000,
        system: assetSystem,
        user: [
          `本文题材为「${options.genre || "自动判断"}」。只执行原版流程步骤1：通读全文并生成角色表。`,
          "必须提取实际出场人物、物理场景、特殊空间；每个资产严格3行，以单独一行 ### 分隔；最后才写 # 注释。",
          "人物第3行必须逐项保留原版模板中的完整物理隔离排版、渲染、姿态、背景和禁止项，不得缩写。",
          assetFailure ? `上一版角色表未通过硬校验，必须逐项修复：\n${assetFailure}` : "",
          "只返回 JSON：{\"roster\":\"角色表.txt 的完整内容\"}，不要返回分镜。",
          "小说原文：",
          options.text,
        ].filter(Boolean).join("\n"),
      });
      const legacy = options.allowLegacyFastPath ? legacyCombinedResponse(assetResult.text) : null;
      if (legacy) {
        if (legacy.characters.length === 0) throw new Error("模型没有返回角色资产，已阻止假完成");
        return {
          ...legacy,
          artifacts,
          model: assetResult.model,
          usage: [assetResult.usage],
          stages,
          legacyFastPath: true,
        };
      }
      const candidate = rosterTextFromResponse(assetResult.text);
      try {
        const parsedAssets = parseOriginalRoster(candidate);
        if (!parsedAssets.some((asset) => asset.assetType === "character")) {
          throw new Error("角色表没有实际出场人物，已阻止假完成");
        }
        rosterText = candidate;
        assets = parsedAssets;
      } catch (error) {
        assetFailure = error instanceof Error ? error.message : String(error);
      }
    }
    if (!rosterText) {
      await pauseOriginalInference({
        message: `原版角色表连续校验失败：${assetFailure}`,
        stage: "assets",
        workDir,
        diagnosticsPath: failureDiagnosticsPath,
        reportPaths: [rosterReportPath],
        errorCategory: "ROSTER.GENERATION_FAILED",
        rows: [],
        context: options.context,
      });
    }
  }
  if (!assets.some((asset) => asset.assetType === "character")) throw new Error("角色表没有实际出场人物，已阻止假完成");
  await writeTextFileAtomic(rosterPath, rosterText);

  progress(options.context, 20, "正在按原版规则智能分句", { assets: assets.length });
  let segmentFailure = "";
  let segmented = false;
  const recoveredMarked = await existingText(markedPath);
  if (recoveredMarked && await existingText(sentencesPath)) {
    const recovered = await runInferenceScript(
      options.runtime,
      "segment.py",
      [markedPath, `--origin=${sourcePath}`, `--out=${sentencesPath}`],
      { cwd: workDir, signal: options.context.signal },
    );
    if (recovered.code === 0) {
      segmented = true;
      options.context.emit("info", "已从断点恢复并验证分句结果", { sentencesPath });
    }
  }
  for (let attempt = 0; attempt < 3 && !segmented; attempt += 1) {
    const segmentResult = await call({
      stage: attempt === 0 ? "segmentation" : "segmentation-repair",
      progressStart: 20,
      progressEnd: 32,
      maxOutputTokens: Math.max(16_000, Math.min(64_000, Math.ceil(options.text.length * 1.4))),
      system: segmentationSystem,
      user: [
        "只执行原版步骤2。必须逐字保留原文，只能插入强切标记 ‖ 或弱切标记 |，禁止删字、改字、换序。",
        "每镜必须形成可独立配画面的动作、原因、状态或结果，避免切断主干和必要补语。",
        segmentFailure ? `上次 segment.py 校验失败，按错误重新标记：\n${segmentFailure}` : "",
        "只返回 JSON：{\"marked_text\":\"插入标记后的完整原文\"}。",
        "原文：",
        options.text,
      ].filter(Boolean).join("\n"),
    });
    await writeTextFileAtomic(markedPath, markedTextFromResponse(segmentResult.text));
    const segmentCheck = await runInferenceScript(
      options.runtime,
      "segment.py",
      [markedPath, `--origin=${sourcePath}`, `--out=${sentencesPath}`],
      { cwd: workDir, signal: options.context.signal },
    );
    if (segmentCheck.code === 0) segmented = true;
    else segmentFailure = compactFailure(segmentCheck);
  }
  if (!segmented) {
    await pauseOriginalInference({
      message: `原版分句校验连续失败：${segmentFailure}`,
      stage: "segmentation",
      workDir,
      diagnosticsPath: failureDiagnosticsPath,
      reportPaths: [bcolReportPath],
      errorCategory: "BCOL.SEGMENTATION_FAILED",
      rows: [],
      context: options.context,
    });
  }

  progress(options.context, 34, "正在建立并校验四列分镜骨架");
  let recoveredCsv = false;
  if (await existingText(csvPath)) {
    const recoveredB = await runInferenceScript(
      options.runtime,
      "check_bcol.py",
      [csvPath, `--origin=${sourcePath}`],
      { cwd: workDir, signal: options.context.signal },
    );
    const recoveredRoster = await runInferenceScript(
      options.runtime,
      "check_dcol.py",
      ["--roster-only", csvPath, `--json-report=${rosterReportPath}`],
      { cwd: workDir, signal: options.context.signal },
    );
    recoveredCsv = recoveredB.code === 0 && recoveredRoster.code === 0;
    if (recoveredCsv) options.context.emit("info", "已从断点恢复四列 CSV", { csvPath });
  }
  if (!recoveredCsv) {
    await validate(
      options.runtime,
      "build_storyboard_skeleton.py",
      [sentencesPath, `--origin=${sourcePath}`, `--csv-out=${csvPath}`],
      workDir,
      options.context.signal,
      "CSV 骨架生成",
    );
    await validate(
      options.runtime,
      "check_bcol.py",
      [csvPath, `--origin=${sourcePath}`],
      workDir,
      options.context.signal,
      "B列原文一致性校验",
    );
  }

  let rosterCheck = await runInferenceScript(
    options.runtime,
    "check_dcol.py",
    ["--roster-only", csvPath, `--json-report=${rosterReportPath}`],
    { cwd: workDir, signal: options.context.signal },
  );
  let rosterFailure = rosterCheck.code === 0
    ? ""
    : await readFile(rosterReportPath, "utf8").catch(() => compactFailure(rosterCheck));
  for (let attempt = 0; attempt < 3 && rosterCheck.code !== 0; attempt += 1) {
    progress(options.context, 35, "角色表脚本校验未通过，正在按原版步骤1修复", { attempt: attempt + 1 });
    const repairResult = await call({
      stage: "assets-repair",
      progressStart: 35,
      progressEnd: 38,
      maxOutputTokens: 24_000,
      system: assetSystem,
      user: [
        `本文题材为「${options.genre || "自动判断"}」。角色表未通过原版 check_dcol.py --roster-only。`,
        "只按原版步骤1重写角色表，不得修改原文、分句或 CSV。",
        `脚本报告：\n${rosterFailure}`,
        `待修角色表：\n${rosterText}`,
        "只返回 JSON：{\"roster\":\"修复后的角色表.txt完整内容\"}。",
        "小说原文：",
        options.text,
      ].join("\n\n"),
    });
    const candidate = rosterTextFromResponse(repairResult.text);
    try {
      const parsedAssets = parseOriginalRoster(candidate);
      if (!parsedAssets.some((asset) => asset.assetType === "character")) {
        throw new Error("角色表没有实际出场人物");
      }
      rosterText = candidate;
      assets = parsedAssets;
      await writeTextFileAtomic(rosterPath, rosterText);
      rosterCheck = await runInferenceScript(
        options.runtime,
        "check_dcol.py",
        ["--roster-only", csvPath, `--json-report=${rosterReportPath}`],
        { cwd: workDir, signal: options.context.signal },
      );
      rosterFailure = rosterCheck.code === 0
        ? ""
        : await readFile(rosterReportPath, "utf8").catch(() => compactFailure(rosterCheck));
    } catch (error) {
      rosterFailure = error instanceof Error ? error.message : String(error);
    }
  }
  if (rosterCheck.code !== 0) {
    await pauseOriginalInference({
      message: `角色表完整性连续修复失败：${rosterFailure}`,
      stage: "assets-repair",
      workDir,
      diagnosticsPath: failureDiagnosticsPath,
      reportPaths: [rosterReportPath],
      errorCategory: originalRepairScope(rosterFailure).firstCode || "ROSTER.VALIDATION_FAILED",
      rows: await csvRows(csvPath),
      context: options.context,
    });
  }

  let rows = await csvRows(csvPath);
  let snapshotRows: Array<Record<string, string>> | null = null;
  if (await existingText(bcolSnapshotPath)) {
    const snapshotCheck = await runInferenceScript(
      options.runtime,
      "check_bcol.py",
      [bcolSnapshotPath, `--origin=${sourcePath}`],
      { cwd: workDir, signal: options.context.signal },
    );
    if (snapshotCheck.code === 0) snapshotRows = await csvRows(bcolSnapshotPath);
  }
  if (!snapshotRows) {
    snapshotRows = rows.map((row) => ({ ...row, 画面提示词: "" }));
    await writeRows(bcolSnapshotPath, snapshotRows);
    options.context.emit("info", "已保存生成前 ABC 只读骨架快照", { bcolSnapshotPath });
  }

  const ensureAbcIntegrity = async (stage: string): Promise<Array<Record<string, string>>> => {
    const check = await runInferenceScript(
      options.runtime,
      "check_bcol.py",
      [csvPath, `--origin=${sourcePath}`, `--json-report=${bcolReportPath}`],
      { cwd: workDir, signal: options.context.signal },
    );
    if (check.code === 0) return csvRows(csvPath);
    const current = await readCsvFile(csvPath).then((parsed) => parsed.rows).catch(() => []);
    const restored = restoreOriginalAbcRows(snapshotRows!, current);
    await writeRows(csvPath, restored);
    const restoredCheck = await runInferenceScript(
      options.runtime,
      "check_bcol.py",
      [csvPath, `--origin=${sourcePath}`, `--json-report=${bcolReportPath}`],
      { cwd: workDir, signal: options.context.signal },
    );
    if (restoredCheck.code !== 0) {
      await pauseOriginalInference({
        message: "ABC 骨架自动恢复后仍未通过 B 列校验",
        stage,
        workDir,
        diagnosticsPath: failureDiagnosticsPath,
        reportPaths: [bcolReportPath],
        errorCategory: "BCOL.RESTORE_FAILED",
        rows: restored,
        context: options.context,
      });
    }
    options.context.emit("warning", "检测到 ABC 或数据行漂移，已按生成前快照恢复并保留同编号 D 列", {
      stage,
      bcolSnapshotPath,
      bcolReportPath,
    });
    return csvRows(csvPath);
  };

  const total = rows.length;
  let cursor = 0;
  let batchSize = 10;
  const dSystem = [
    skill,
    `# 提示词装配规则\n${promptRules}`,
    `# 视觉推理规则\n${visualRules}`,
    `# 速查表\n${quickLookup}`,
    `# 情绪基调\n${emotionTone}`,
    `# 特效触发规则\n${effectTriggers}`,
    fantasyGenre(options.genre) ? `# 玄幻题材增强规则\n${fantasyRules}` : "",
  ].filter(Boolean).join("\n\n");

  const repairRosterFromValidationReport = async (
    report: string,
    progressStart: number,
    progressEnd: number,
  ): Promise<boolean> => {
    const repair = await call({
      stage: "assets-repair",
      progressStart,
      progressEnd,
      maxOutputTokens: 20_000,
      system: assetSystem,
      user: [
        "原版可信校验器把以下错误归属为 roster。只修角色表.txt，不得修改原文、分句或 CSV。",
        "人物身份保持不变；缺少物理场景或特殊空间时，只按报告和原文明示内容补齐合法三行资产块。",
        "报告中的 issues 是完整错误清单，逐项按 code、target、reason、strategy 修复。",
        `结构化报告：\n${report}`,
        `当前角色表：\n${rosterText}`,
        `小说原文：\n${options.text}`,
        "只返回 JSON：{\"roster\":\"修复后的角色表.txt完整内容\"}。",
      ].join("\n\n"),
    });
    try {
      const candidate = rosterTextFromResponse(repair.text);
      const parsedAssets = parseOriginalRoster(candidate);
      if (!parsedAssets.some((asset) => asset.assetType === "character")) return false;
      await writeTextFileAtomic(rosterPath, candidate);
      const check = await runInferenceScript(
        options.runtime,
        "check_dcol.py",
        ["--roster-only", csvPath, `--json-report=${rosterReportPath}`],
        { cwd: workDir, signal: options.context.signal },
      );
      if (check.code !== 0) return false;
      rosterText = candidate;
      assets = parsedAssets;
      return true;
    } catch {
      return false;
    }
  };

  while (cursor < total) {
    const selectedRows = rows.slice(cursor, cursor + batchSize);
    const indexes = selectedRows.map((row) => Number(row["编号"]));
    const allowed = new Set(indexes);
    const completedRows = rows.slice(0, cursor);
    const previousBoundary = rows.slice(Math.max(0, cursor - 3), cursor);
    const nextBoundary = rows.slice(cursor + selectedRows.length, cursor + selectedRows.length + 3);
    const sceneState = physicalSceneContext(completedRows, assets);
    const rangeStart = 38 + Math.floor((cursor / Math.max(1, total)) * 42);
    const rangeEnd = 38 + Math.floor(((cursor + selectedRows.length) / Math.max(1, total)) * 42);
    let report = "";
    let passed = false;
    const reportPath = join(workDir, `dcol-batch-${indexes[0]}-${indexes.at(-1)}.json`);
    if (missingBatchRows(rows, indexes).length === 0) {
      const recoveredBatch = await runInferenceScript(
        options.runtime,
        "check_dcol.py",
        [csvPath, `--rows=${indexes.join(",")}`, `--json-report=${reportPath}`],
        { cwd: workDir, signal: options.context.signal },
      );
      if (recoveredBatch.code === 0) {
        passed = true;
        options.context.emit("info", "已从断点恢复通过校验的分镜批次", { batch: indexes });
      } else {
        report = await readFile(reportPath, "utf8").catch(() => compactFailure(recoveredBatch));
      }
    }
    let zeroProgressStreak = 0;
    for (let attempt = 0; attempt < 4 && !passed; attempt += 1) {
      let requiredIndexes = indexes;
      if (report) {
        let scope = originalRepairScope(report, allowed);
        if (scope.unregistered) {
          await pauseOriginalInference({
            message: "当前批次存在未登记或不可安全自动修复的错误，已停止盲目重试",
            stage: "dfill-batch",
            workDir,
            diagnosticsPath: failureDiagnosticsPath,
            reportPaths: [reportPath, rosterReportPath],
            errorCategory: scope.firstCode,
            rows,
            context: options.context,
          });
        }
        if (scope.roster) {
          const repaired = await repairRosterFromValidationReport(report, rangeStart, rangeEnd);
          const recheck = await runInferenceScript(
            options.runtime,
            "check_dcol.py",
            [csvPath, `--rows=${indexes.join(",")}`, `--json-report=${reportPath}`],
            { cwd: workDir, signal: options.context.signal },
          );
          if (recheck.code === 0) {
            passed = true;
            break;
          }
          report = await readFile(reportPath, "utf8").catch(() => compactFailure(recheck));
          scope = originalRepairScope(report, allowed);
          if (!repaired && scope.roster && scope.issueRows.length === 0) continue;
          if (scope.unregistered) {
            await pauseOriginalInference({
              message: "角色表修复后仍存在未登记错误，已停止盲目重试",
              stage: "dfill-batch",
              workDir,
              diagnosticsPath: failureDiagnosticsPath,
              reportPaths: [reportPath, rosterReportPath],
              errorCategory: scope.firstCode,
              rows,
              context: options.context,
            });
          }
        }
        requiredIndexes = originalRepairScope(report, allowed).issueRows;
        if (requiredIndexes.length === 0) continue;
      }
      const patchScope = new Set(requiredIndexes);
      progress(options.context, rangeStart, attempt === 0 ? "正在逐镜生成画面" : "正在按校验报告修复分镜", {
        current: cursor + 1,
        total,
        batch: requiredIndexes,
        attempt: attempt + 1,
      });
      const batchResult = await call({
        stage: report ? "storyboard-repair" : "storyboards",
        progressStart: rangeStart,
        progressEnd: rangeEnd,
        maxOutputTokens: 32_000,
        system: dSystem,
        user: [
          "按原版步骤4只填写本批次D列。每镜独立构思，必须含合法@资产、实际主体动作、动态关键词、基础运镜和景别。",
          "不得修改编号、原声、秒数；不得写批次外镜号；不得追加固定画质后缀。",
          report ? `上轮结构化校验报告如下，只修改报告涉及镜号且同镜多错一次清完：\n${report}` : "",
          `唯一允许镜号：${requiredIndexes.join(",")}`,
          `本文题材：${options.genre || "自动判断"}`,
          `视觉蓝图：\n${arcText}`,
          `角色表：\n${rosterText}`,
          `当前物理场景状态（只用于连续性，不得据此新增原文没有的地点）：\n${JSON.stringify(sceneState, null, 2)}`,
          `本批前边界：\n${JSON.stringify(compactStoryboardRows(previousBoundary), null, 2)}`,
          `已完成 D 列：\n${JSON.stringify(compactStoryboardRows(completedRows), null, 2)}`,
          `本批数据：\n${JSON.stringify(compactStoryboardRows(selectedRows), null, 2)}`,
          `本批后边界（只用于判断切镜连续性，禁止把后镜首次信息写入当前镜）：\n${JSON.stringify(compactStoryboardRows(nextBoundary), null, 2)}`,
          "只返回 JSON：{\"prompts\":[{\"index\":1,\"prompt\":\"完整D列\"}]}。数组必须覆盖所有允许镜号，且每个镜号恰好一次。",
        ].filter(Boolean).join("\n\n"),
      });
      const before = rows.map((row) => ({ ...row }));
      let patches: Array<z.infer<typeof promptPatch>> = [];
      try {
        patches = promptPatches(batchResult.text);
        assertPromptPatchContract(patches, patchScope, requiredIndexes);
        applyOriginalPromptPatches(rows, patches, patchScope);
      } catch (error) {
        rows = before;
        zeroProgressStreak += 1;
        report = patchContractReport(error instanceof Error ? error.message : String(error), requiredIndexes);
        if (zeroProgressStreak >= 2) {
          await writeTextFileAtomic(reportPath, report);
          await pauseOriginalInference({
            message: `连续 ${zeroProgressStreak} 轮零进展，模型没有按批次契约写入 D 列`,
            stage: "dfill",
            workDir,
            diagnosticsPath: failureDiagnosticsPath,
            reportPaths: [reportPath],
            errorCategory: "MODEL.PATCH_CONTRACT",
            rows,
            context: options.context,
          });
        }
        continue;
      }
      const changed = patches.some((patch) => {
        const previous = before.find((row) => Number(row["编号"]) === patch.index)?.["画面提示词"]?.trim() ?? "";
        return previous !== patch.prompt.trim();
      });
      if (!changed) {
        rows = before;
        zeroProgressStreak += 1;
        report = patchContractReport("模型返回内容与当前 D 列完全相同，没有产生修复进展", requiredIndexes);
        if (zeroProgressStreak >= 2) {
          await writeTextFileAtomic(reportPath, report);
          await pauseOriginalInference({
            message: `连续 ${zeroProgressStreak} 轮零进展，剩余批次没有任何 D 列变化`,
            stage: "dfill",
            workDir,
            diagnosticsPath: failureDiagnosticsPath,
            reportPaths: [reportPath],
            errorCategory: "MODEL.ZERO_PROGRESS",
            rows,
            context: options.context,
          });
        }
        continue;
      }
      zeroProgressStreak = 0;
      const missing = missingBatchRows(rows, indexes);
      if (missing.length > 0) {
        rows = before;
        report = `以下镜号没有返回D列：${missing.join(",")}`;
        continue;
      }
      await writeRows(csvPath, rows);
      const batchCheck = await runInferenceScript(
        options.runtime,
        "check_dcol.py",
        [csvPath, `--rows=${indexes.join(",")}`, `--json-report=${reportPath}`],
        { cwd: workDir, signal: options.context.signal },
      );
      if (batchCheck.code === 0) passed = true;
      else {
        rows = before;
        await writeRows(csvPath, rows);
        report = await readFile(reportPath, "utf8").catch(() => compactFailure(batchCheck));
      }
    }
    if (!passed) {
      if (batchSize > 10) {
        batchSize = 10;
        continue;
      }
      const scope = originalRepairScope(report, allowed);
      await pauseOriginalInference({
        message: `分镜 ${indexes.join(",")} 连续校验失败，尚未达到导出标准`,
        stage: "dfill-batch",
        workDir,
        diagnosticsPath: failureDiagnosticsPath,
        reportPaths: [reportPath, rosterReportPath],
        errorCategory: scope.firstCode || "DCOL.BATCH_FAILED",
        rows,
        context: options.context,
      });
    }
    cursor += selectedRows.length;
    if (batchSize === 10) batchSize = 20;
    else if (batchSize === 20) batchSize = 30;
  }

  progress(options.context, 82, "正在按生成前快照复验 ABC 骨架");
  rows = await ensureAbcIntegrity("bcol-restore");
  for (let reviewStart = 0; reviewStart < rows.length; reviewStart += 30) {
    const reviewRows = rows.slice(reviewStart, reviewStart + 30);
    const reviewIndexes = new Set(reviewRows.map((row) => Number(row["编号"])));
    progress(options.context, 86 + Math.floor((reviewStart / Math.max(1, rows.length)) * 5), "正在语义复核分镜");
    let patches: Array<{ index: number; prompt: string }> = [];
    try {
      const review = await call({
        stage: "semantic-review",
        progressStart: 86,
        progressEnd: 91,
        maxOutputTokens: 20_000,
        system: dSystem,
        user: [
          "对以下B-D做独立语义复核。只修高置信问题：核心事件遗漏、假设变现实、通用反应替代核心事实、无依据新增事实。",
          `本轮只允许修改镜号：${[...reviewIndexes].join(",")}。不要修改已合格内容。`,
          "只返回 JSON：{\"patches\":[{\"index\":1,\"prompt\":\"修正后完整D列\"}]}；没有问题返回空数组。",
          `本文题材：${options.genre || "自动判断"}`,
          `角色表：\n${rosterText}`,
          `视觉蓝图：\n${arcText}`,
          `全表 B-D 连续上下文：\n${JSON.stringify(compactStoryboardRows(rows), null, 2)}`,
          `本轮复核范围：\n${JSON.stringify(compactStoryboardRows(reviewRows), null, 2)}`,
        ].join("\n\n"),
      });
      patches = promptPatches(review.text);
    } catch (error) {
      options.context.emit("warning", "语义审片异常，继续硬校验", {
        rows: [...reviewIndexes],
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (patches.length === 0) continue;
    for (const patch of patches) {
      if (!reviewIndexes.has(patch.index)) {
        options.context.emit("warning", "语义复核返回了范围外镜号，已忽略", { row: patch.index });
        continue;
      }
      const row = rows.find((item) => Number(item["编号"]) === patch.index);
      if (!row) {
        options.context.emit("warning", "语义复核返回了不存在的镜号，已忽略", { row: patch.index });
        continue;
      }
      const beforePrompt = row["画面提示词"] ?? "";
      row["画面提示词"] = patch.prompt.trim();
      await writeRows(csvPath, rows);
      const check = await runInferenceScript(
        options.runtime,
        "check_dcol.py",
        [csvPath, `--rows=${patch.index}`],
        { cwd: workDir, signal: options.context.signal },
      );
      if (check.code !== 0) {
        row["画面提示词"] = beforePrompt;
        await writeRows(csvPath, rows);
        options.context.emit("warning", "语义复核修改未通过硬校验，已自动回退", { rows: [patch.index] });
      }
    }
  }

  progress(options.context, 91, "正在恢复并复验语义审片后的 ABC 骨架");
  rows = await ensureAbcIntegrity("semantic-bcol-restore");

  let fullTablePassed = false;
  let previousErrorCount = Number.POSITIVE_INFINITY;
  let stagnantRounds = 0;
  for (let attempt = 0; attempt < 6 && !fullTablePassed; attempt += 1) {
    progress(options.context, 92, attempt === 0 ? "正在执行全表硬错误校验" : "正在闭环修复全表硬错误", {
      attempt: attempt + 1,
    });
    const check = await runInferenceScript(
      options.runtime,
      "check_dcol.py",
      [csvPath, `--json-report=${dcolReportPath}`],
      { cwd: workDir, signal: options.context.signal },
    );
    if (check.code === 0) {
      fullTablePassed = true;
      break;
    }
    const report = await readFile(dcolReportPath, "utf8").catch(() => compactFailure(check));
    const scope = originalRepairScope(report);
    if (scope.unregistered) {
      await pauseOriginalInference({
        message: "全表校验存在未登记或不可安全自动修复的错误，已停止盲目重试",
        stage: "dfill-fix",
        workDir,
        diagnosticsPath: failureDiagnosticsPath,
        reportPaths: [dcolReportPath, rosterReportPath, bcolReportPath],
        errorCategory: scope.firstCode,
        rows,
        context: options.context,
      });
    }
    let errorCount = scope.issueRows.length + (scope.roster ? 1 : 0);
    try {
      errorCount = validationReport(report).errorCount;
    } catch {
      // originalRepairScope already classified malformed reports as unregistered.
    }
    if (errorCount >= previousErrorCount) stagnantRounds += 1;
    else stagnantRounds = 0;
    previousErrorCount = errorCount;
    if (stagnantRounds >= 3) {
      await pauseOriginalInference({
        message: `全表硬错误连续 ${stagnantRounds} 轮没有减少，已停止局部盲目打补丁`,
        stage: "dfill-fix",
        workDir,
        diagnosticsPath: failureDiagnosticsPath,
        reportPaths: [dcolReportPath, rosterReportPath, bcolReportPath],
        errorCategory: scope.firstCode || "DCOL.ZERO_PROGRESS",
        rows,
        context: options.context,
      });
    }
    if (scope.roster) {
      await repairRosterFromValidationReport(report, 92, 94);
      continue;
    }
    if (scope.issueRows.length === 0) {
      await pauseOriginalInference({
        message: "全表报告没有可确定定位的报错镜号",
        stage: "dfill-fix",
        workDir,
        diagnosticsPath: failureDiagnosticsPath,
        reportPaths: [dcolReportPath],
        errorCategory: scope.firstCode || "DCOL.SCOPE_MISSING",
        rows,
        context: options.context,
      });
    }
    const repairIndexes = scope.issueRows;
    const repairAllowed = new Set(repairIndexes);
    const repair = await call({
      stage: "full-table-repair",
      progressStart: 92,
      progressEnd: 94,
      maxOutputTokens: 32_000,
      system: dSystem,
      user: [
        stagnantRounds > 0
          ? "前轮修复没有减少错误。不要继续在旧句上局部打补丁，按对应 B 列、相邻镜和角色表从头重写报告中的整格 D 列。"
          : "进入原版步骤5全表硬错误闭环；同镜多错一次清完，只重写报告明确列出的报错镜。",
        "禁止修改未报错镜、角色表、编号、原声和秒数。",
        `唯一允许镜号：${repairIndexes.join(",")}`,
        `完整结构化报告：\n${report}`,
        `角色表：\n${rosterText}`,
        `视觉蓝图：\n${arcText}`,
        `全表 B-D 上下文：\n${JSON.stringify(compactStoryboardRows(rows), null, 2)}`,
        "只返回 JSON：{\"patches\":[{\"index\":1,\"prompt\":\"重写后完整D列\"}]}，必须覆盖全部允许镜号且每个镜号恰好一次。",
      ].join("\n\n"),
    });
    const before = rows.map((row) => ({ ...row }));
    try {
      const patches = promptPatches(repair.text);
      assertPromptPatchContract(patches, repairAllowed, repairIndexes);
      applyOriginalPromptPatches(rows, patches, repairAllowed);
      const changed = patches.some((patch) => {
        const previous = before.find((row) => Number(row["编号"]) === patch.index)?.["画面提示词"]?.trim() ?? "";
        return previous !== patch.prompt.trim();
      });
      if (!changed) stagnantRounds += 1;
      await writeRows(csvPath, rows);
    } catch (error) {
      rows = before;
      stagnantRounds += 1;
      options.context.emit("warning", "全表修复响应未满足严格镜号契约", {
        attempt: attempt + 1,
        error: error instanceof Error ? error.message : String(error),
        repairIndexes,
      });
    }
  }
  if (!fullTablePassed) {
    const report = await readFile(dcolReportPath, "utf8").catch(() => "");
    const scope = originalRepairScope(report);
    await pauseOriginalInference({
      message: "全表硬错误多轮修复后仍未清零，草稿未导出",
      stage: "dfill-fix",
      workDir,
      diagnosticsPath: failureDiagnosticsPath,
      reportPaths: [dcolReportPath, rosterReportPath, bcolReportPath],
      errorCategory: scope.firstCode || "DCOL.FULL_TABLE_FAILED",
      rows,
      context: options.context,
    });
  }

  rows = await ensureAbcIntegrity("final-bcol");
  await validate(options.runtime, "check_dcol.py", [csvPath], workDir, options.context.signal, "最终D列校验");

  rows = await csvRows(csvPath);
  const characterNames = assets.filter((asset) => asset.assetType === "character").map((asset) => asset.name);
  const storyboards: StoryboardDraft[] = rows.map((row, index) => ({
    index,
    originalText: row["原声"] ?? "",
    subjects: characterNames.filter((name) => (row["画面提示词"] ?? "").includes(`@${name}`)),
    prompt: row["画面提示词"] ?? "",
    duration: Number(row["秒数"]) || 4,
  }));
  progress(options.context, 92, "原版推理工作流已通过全部校验", { assets: assets.length, storyboards: storyboards.length });
  return {
    characters: assets,
    storyboards,
    artifacts,
    model: results.at(-1)?.model ?? results.find((result) => result.model)?.model ?? null,
    usage: results.map((result) => result.usage),
    stages,
    legacyFastPath: false,
  };
}

export function inferenceArtifactName(path: string): string {
  return basename(path);
}
