import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { load } from "cheerio";
import JSZip from "jszip";

export type OriginalOpeningMode = "general" | "enhanced";

type WorkbookSheet = { name: string; rows: string[] };

const coreRulesCache = new Map<string, Promise<string>>();
const workbookCache = new Map<string, Promise<WorkbookSheet[]>>();
const COMMON_BIGRAMS = new Set([
  "一个", "这个", "那个", "自己", "他们", "我们", "什么", "没有", "就是", "不是", "可以", "已经", "因为", "所以",
  "然后", "但是", "还是", "时候", "知道", "看到", "现在", "怎么", "这么", "这样", "起来", "开始", "直接", "只是", "如果",
]);

function xmlText(value: string): string {
  const $ = load(value, { xmlMode: true });
  return $.root().text();
}

function sourceBigrams(source: string): Set<string> {
  const normalized = source.replace(/[^\p{Script=Han}A-Za-z0-9]+/gu, "").slice(0, 30_000);
  const values = new Set<string>();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    const pair = normalized.slice(index, index + 2);
    if (!COMMON_BIGRAMS.has(pair)) values.add(pair);
  }
  return values;
}

function rankedExcerpts(values: string[], source: string, limit: number): string[] {
  const terms = sourceBigrams(source);
  const ranked = values
    .map((value, index) => {
      let score = 0;
      for (const term of terms) if (value.includes(term)) score += 1;
      return { value, index, score };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = ranked.slice(0, Math.min(limit, ranked.length)).map(({ value }) => value.trim()).filter(Boolean);
  if (selected.some((_, index) => ranked[index]?.score)) return selected;
  if (values.length <= limit) return values;
  return Array.from({ length: limit }, (_, index) => values[Math.floor(index * values.length / limit)]!).filter(Boolean);
}

async function readWorkbook(path: string): Promise<WorkbookSheet[]> {
  let cached = workbookCache.get(path);
  if (cached) return cached;
  cached = (async () => {
    const archive = await JSZip.loadAsync(await readFile(path));
    const workbookXml = await archive.file("xl/workbook.xml")?.async("string");
    const relationshipsXml = await archive.file("xl/_rels/workbook.xml.rels")?.async("string");
    if (!workbookXml || !relationshipsXml) throw new Error("开头参考库缺少 workbook.xml");
    const sharedXml = await archive.file("xl/sharedStrings.xml")?.async("string");
    const shared: string[] = [];
    if (sharedXml) {
      const $shared = load(sharedXml, { xmlMode: true });
      $shared("si").each((_index, element) => {
        shared.push($shared(element).find("t").toArray().map((node) => $shared(node).text()).join(""));
      });
    }
    const $relations = load(relationshipsXml, { xmlMode: true });
    const targets = new Map<string, string>();
    $relations("Relationship").each((_index, element) => {
      const id = $relations(element).attr("Id");
      const target = $relations(element).attr("Target");
      if (id && target) targets.set(id, target.replace(/^\//, ""));
    });
    const $workbook = load(workbookXml, { xmlMode: true });
    const sheets: WorkbookSheet[] = [];
    for (const element of $workbook("sheet").toArray()) {
      const name = $workbook(element).attr("name")?.trim();
      const relationId = $workbook(element).attr("r:id") ?? $workbook(element).attr("id");
      const target = relationId ? targets.get(relationId) : undefined;
      if (!name || !target) continue;
      const normalizedTarget = target.startsWith("xl/") ? target : `xl/${target.replace(/^\.\.\//, "")}`;
      const worksheetXml = await archive.file(normalizedTarget)?.async("string");
      if (!worksheetXml) continue;
      const $worksheet = load(worksheetXml, { xmlMode: true });
      const rows: string[] = [];
      $worksheet("row").each((_rowIndex, row) => {
        const cells: string[] = [];
        $worksheet(row).find("c").each((_cellIndex, cell) => {
          const type = $worksheet(cell).attr("t");
          const raw = $worksheet(cell).find("v").first().text();
          if (type === "s") cells.push(shared[Number(raw)] ?? "");
          else if (type === "inlineStr") cells.push($worksheet(cell).find("t").toArray().map((node) => $worksheet(node).text()).join(""));
          else cells.push(xmlText(raw));
        });
        const value = cells.map((cell) => cell.trim()).filter(Boolean).join(" | ");
        if (value) rows.push(value);
      });
      sheets.push({ name, rows });
    }
    return sheets;
  })();
  workbookCache.set(path, cached);
  return cached;
}

function generalSheetPreference(source: string): string[] {
  if (/女频|总裁|离婚|追妻|虐恋|婚姻/u.test(source)) return ["女频发疯文", "女频都市", "女频穿越", "女频悬疑"];
  if (/斗罗|斗破|同人|武魂|魂环|原著/u.test(source)) return ["男频同人"];
  if (/规则怪谈|怪谈/u.test(source)) return ["男频规则怪谈", "男频悬疑文"];
  if (/悬疑|凶案|诡异|推理/u.test(source)) return ["男频悬疑文"];
  if (/重生/u.test(source)) return ["男频重生文"];
  if (/穿越/u.test(source)) return ["男频穿越文"];
  if (/异能|系统|脑洞|末世/u.test(source)) return ["男频异能文", "男频爽文"];
  if (/古代|王朝|皇帝|将军|江湖/u.test(source)) return ["男频古风文"];
  return ["男频爽文", "男频异能文"];
}

async function generalReferences(root: string, source: string): Promise<string> {
  const workbook = await readWorkbook(join(root, "general", "references", "文案大全.xlsx"));
  const preferences = generalSheetPreference(source);
  const preferred = preferences.flatMap((name) => workbook.filter((sheet) => sheet.name.includes(name)));
  const candidates = (preferred.length > 0 ? preferred : workbook.slice(0, 2))
    .flatMap((sheet) => sheet.rows.slice(1).map((row) => `[${sheet.name}] ${row}`));
  return rankedExcerpts(candidates, source, 15).join("\n\n");
}

function enhancedReferenceFiles(source: string): string[] {
  const genre = /斗罗|武魂|魂环/u.test(source)
    ? "框架库_01_斗罗.md"
    : /斗破|斗气|异火/u.test(source)
      ? "框架库_02_斗破.md"
      : /西游|孙悟空|取经|洪荒/u.test(source)
        ? "框架库_03_西游.md"
        : /末世|丧尸|异能/u.test(source)
          ? "框架库_06_末世异能.md"
          : /女频|总裁|离婚|追妻|虐恋/u.test(source)
            ? "框架库_07_女频虐文.md"
            : /都市|重生|高考|公司|豪门/u.test(source)
              ? "框架库_05_都市重生.md"
              : "框架库_04_其他IP.md";
  return [genre, "框架库_08_通用荒诞.md"];
}

async function enhancedReferences(root: string, source: string): Promise<string> {
  const directory = join(root, "enhanced", "references");
  const values: string[] = [];
  for (const name of enhancedReferenceFiles(source)) {
    const content = await readFile(join(directory, name), "utf8");
    const blocks = content.split(/(?=^###\s+\[\d+\])/gmu).filter((block) => /^###\s+\[\d+\]/u.test(block));
    values.push(...rankedExcerpts(blocks, source, name.includes("通用荒诞") ? 4 : 10));
  }
  return values.join("\n\n");
}

async function coreRules(root: string, mode: OriginalOpeningMode): Promise<string> {
  const key = `${root}:${mode}`;
  let cached = coreRulesCache.get(key);
  if (cached) return cached;
  cached = (async () => {
    const directory = join(root, mode);
    const values = await Promise.all([
      readFile(join(directory, "CLAUDE.md"), "utf8"),
      readFile(join(directory, ".claude", "skills", "novel-optimizer", "SKILL.md"), "utf8"),
      ...(mode === "enhanced"
        ? [
            readFile(join(directory, "rules_check.md"), "utf8"),
            readFile(join(directory, "rules_step3_detail.md"), "utf8"),
            readFile(join(directory, "techniques.md"), "utf8"),
            readFile(join(directory, "best_complete_openings.txt"), "utf8"),
          ]
        : []),
    ]);
    return values.join("\n\n");
  })();
  coreRulesCache.set(key, cached);
  return cached;
}

export async function loadOriginalOpeningSystem(
  resourcesRoot: string,
  mode: OriginalOpeningMode,
  source: string,
): Promise<string> {
  const root = join(resolve(resourcesRoot), "opening-skill");
  const [rules, references] = await Promise.all([
    coreRules(root, mode),
    mode === "enhanced" ? enhancedReferences(root, source) : generalReferences(root, source),
  ]);
  const expected = mode === "enhanced" ? 10 : 5;
  return [
    `你正在执行原版 ${mode === "enhanced" ? "增强版" : "通用版"}小说开头文件工作流。完整执行规则中的分析、选材、自检和评分，但不要在回复中展示中间凭证。你的唯一回复必须是 output_kaitou.txt 的文件内容，恰好 ${expected} 个开头，不得包含完整原文；软件会逐字追加原文。`,
    rules,
    "以下是程序从原版参考库按当前原文筛选出的候选材料，只学习结构、网感和手法，禁止照抄具体人物或情节：",
    references,
  ].join("\n\n");
}

export function validateOriginalOpeningDraft(
  draft: string,
  mode: OriginalOpeningMode,
  source: string,
): string[] {
  const errors: string[] = [];
  const expected = mode === "enhanced" ? 10 : 5;
  const header = /^——\s*开头\s*(\d+)\s*[（(]([^）)]*)[）)]\s*——\s*$/gmu;
  const matches = [...draft.matchAll(header)];
  if (matches.length !== expected) errors.push(`必须恰好输出 ${expected} 个开头，当前识别到 ${matches.length} 个`);
  const numbers = matches.map((match) => Number(match[1]));
  if (numbers.some((value, index) => value !== index + 1)) errors.push(`开头编号必须从 1 到 ${expected} 连续`);
  if (!/^【题材】\s*\S+/mu.test(draft)) errors.push("缺少【题材】标记");
  if (/抓取正文（原文，未优化）/u.test(draft)) errors.push("模型产物不得自行追加原文");
  for (let index = 0; index < matches.length; index += 1) {
    const start = (matches[index]!.index ?? 0) + matches[index]![0].length;
    const end = matches[index + 1]?.index ?? draft.length;
    const body = draft.slice(start, end).trim();
    if (!body) errors.push(`开头 ${index + 1} 没有正文`);
    if (mode !== "enhanced") continue;
    if (!body.includes("【过渡句】")) errors.push(`开头 ${index + 1} 缺少【过渡句】`);
    const anchor = body.match(/【衔接：[^】]+】\s*原文第一句[：:]\s*([^\r\n]+)/u)?.[1]?.trim();
    if (!anchor) errors.push(`开头 ${index + 1} 缺少【衔接】原文第一句`);
    else if (!source.includes(anchor)) errors.push(`开头 ${index + 1} 的衔接锚点不是原文原句`);
  }
  return [...new Set(errors)];
}
