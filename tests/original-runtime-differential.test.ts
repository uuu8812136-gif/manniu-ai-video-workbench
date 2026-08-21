import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCsvFile, writeCsvFileAtomic } from "../src/main/file-workflows";
import {
  inferenceRuntimePaths,
  runInferenceScript,
  type InferenceRuntimePaths,
  type InferenceScriptResult,
} from "../src/main/inference-runtime";
import { runOriginalInference, type OriginalInferenceModelCall } from "../src/main/original-inference";
import type { JobExecutionContext } from "../src/main/jobs";
import type { TextModelResult } from "../src/main/model-clients";

const CHARACTER_PROMPT = [
  "一张16:9比例的宽幅图像，画面包含该角色的设定集排版，严格遵循绝对的物理隔离排版规则：",
  "【左侧三分之一区域】：超大面部特写；",
  "【右侧三分之二区域】：依次排列全身正视图、全身侧视图、全身后视图。",
  "青年男性，清俊面容，黑色高马尾，白色劲装，",
  "100%纯正的顶级3D国漫风格，顶级3D国漫渲染风格，虚幻引擎5渲染，辛烷渲染，高级材质质感，",
  "绝对标准的人体比例严禁大头娃娃，双眼平视镜头，绝对无表情，不准笑，双臂自然下垂，",
  "纯白干净的背景，绝对没有任何环境杂物，绝对禁止2D动漫、绝对禁止赛璐璐、绝对禁止真人摄影、绝对禁止低模。",
].join("，");

const ROSTER = ["江青羽", "宗门弟子 | 男性 | 青年", CHARACTER_PROMPT].join("\n");
const SOURCE = "江青羽缓缓推开沉重木门，抬头看见殿内灯火骤然亮起。";
const MARKED = "江青羽缓缓推开沉重木门，|抬头看见殿内灯火骤然亮起。";
const BYTE_IDENTICAL_RUNTIME_FILES = [
  "scripts/segment.py",
  "scripts/check_dcol.py",
  "scripts/build_storyboard_skeleton.py",
  "scripts/error_protocol.py",
  "scripts/quality_score.py",
  "scripts/spectacle_semantics.py",
  "references/asset-extraction.md",
  "references/quick-lookup.md",
  "references/emotion-tone.md",
  "references/effect-triggers.txt",
  "references/roster-template.txt",
  "references/fantasy-pack.md",
  "references/prompt-assembly.md",
  "references/visual-reasoning.md",
] as const;
const ORIGINAL_RUNTIME_SKILL = resolve(
  process.env.AI_TOOL_ORIGINAL_RUNTIME_ROOT?.trim()
    || resolve(process.cwd(), "../original-runtime-3.5.0-live/agent_skill"),
);
const describeOriginalRuntime = existsSync(join(ORIGINAL_RUNTIME_SKILL, "scripts", "check_dcol.py"))
  ? describe
  : describe.skip;

type JsonReport = {
  checker?: string;
  status?: string;
  source?: string;
  error_count?: number;
  warning_count?: number;
  issues: Array<{ code: string; owner?: string; message?: string }>;
  summary?: Record<string, unknown>;
  [key: string]: unknown;
};

type ChainResult = {
  segment: InferenceScriptResult;
  skeleton: InferenceScriptResult;
  bcol: InferenceScriptResult;
  roster: InferenceScriptResult;
  dcol: InferenceScriptResult;
  sentences: Buffer;
  skeletonCsv: Buffer;
  segmentReport: JsonReport;
  bcolReport: JsonReport;
  rosterReport: JsonReport;
  dcolReport: JsonReport;
  directory: string;
  csvPath: string;
};

function originalRuntime(): InferenceRuntimePaths {
  const bundled = inferenceRuntimePaths(join(process.cwd(), "vendor"));
  const skill = ORIGINAL_RUNTIME_SKILL;
  return {
    ...bundled,
    skill,
    scripts: join(skill, "scripts"),
    references: join(skill, "references"),
  };
}

function currentRuntime(): InferenceRuntimePaths {
  return inferenceRuntimePaths(join(process.cwd(), "vendor"));
}

function normalizeOriginalBrand(value: string): string {
  return value
    .replaceAll("manniu-fenjing", "ai-tool-fenjing")
    .replaceAll("漫牛分镜", "AI工具分镜");
}

function normalizeBcolSource(value: string): string {
  return value
    .replaceAll("manniu-fenjing 适配版", "AI工具适配版")
    .replaceAll("manniu 适配版", "AI工具适配版")
    .replaceAll("\r\n", "\n");
}

function scrubReport(report: JsonReport): JsonReport {
  return typeof report.source === "string"
    ? { ...report, source: basename(report.source) }
    : report;
}

function scrubOutput(value: string, directory: string): string {
  return value
    .replaceAll(directory, "<WORKDIR>")
    .replaceAll("manniu 适配版", "AI工具适配版");
}

async function jsonReport(path: string): Promise<JsonReport> {
  return JSON.parse(await readFile(path, "utf8")) as JsonReport;
}

async function executeValidChain(runtime: InferenceRuntimePaths, directory: string): Promise<ChainResult> {
  const sourcePath = join(directory, "边界样例.txt");
  const markedPath = join(directory, "边界样例_marked.txt");
  const sentencesPath = join(directory, "边界样例_sentences.txt");
  const segmentReportPath = join(directory, "边界样例_segment_report.json");
  const csvPath = join(directory, "边界样例.csv");
  const bcolReportPath = join(directory, "bcol.json");
  const rosterReportPath = join(directory, "roster.json");
  const dcolReportPath = join(directory, "dcol.json");
  await writeFile(sourcePath, `\ufeff${SOURCE}`, "utf8");
  await writeFile(markedPath, `\ufeff${MARKED}`, "utf8");
  await writeFile(join(directory, "角色表.txt"), `\ufeff${ROSTER}`, "utf8");

  const segment = await runInferenceScript(runtime, "segment.py", [
    markedPath,
    `--origin=${sourcePath}`,
    `--out=${sentencesPath}`,
  ], { cwd: directory });
  const skeleton = await runInferenceScript(runtime, "build_storyboard_skeleton.py", [
    sentencesPath,
    `--origin=${sourcePath}`,
    `--csv-out=${csvPath}`,
  ], { cwd: directory });
  const skeletonCsv = await readFile(csvPath);
  const bcol = await runInferenceScript(runtime, "check_bcol.py", [
    csvPath,
    `--origin=${sourcePath}`,
    `--json-report=${bcolReportPath}`,
  ], { cwd: directory });
  const roster = await runInferenceScript(runtime, "check_dcol.py", [
    "--roster-only",
    csvPath,
    `--json-report=${rosterReportPath}`,
  ], { cwd: directory });

  const parsed = await readCsvFile(csvPath);
  parsed.rows[0]["画面提示词"] = "@江青羽 缓缓推开沉重木门，中动态，固定镜头，中景";
  parsed.rows[1]["画面提示词"] = "@江青羽 缓缓抬头看向殿内灯火，小动态，固定镜头，中景";
  await writeCsvFileAtomic(csvPath, parsed.rows, { columns: parsed.columns, bom: true });
  const dcol = await runInferenceScript(runtime, "check_dcol.py", [
    csvPath,
    `--json-report=${dcolReportPath}`,
  ], { cwd: directory });

  return {
    segment,
    skeleton,
    bcol,
    roster,
    dcol,
    sentences: await readFile(sentencesPath),
    skeletonCsv,
    segmentReport: await jsonReport(segmentReportPath),
    bcolReport: await jsonReport(bcolReportPath),
    rosterReport: await jsonReport(rosterReportPath),
    dcolReport: await jsonReport(dcolReportPath),
    directory,
    csvPath,
  };
}

async function executeInvalidBcol(runtime: InferenceRuntimePaths, directory: string): Promise<{
  result: InferenceScriptResult;
  report: JsonReport;
}> {
  const chain = await executeValidChain(runtime, directory);
  const parsed = await readCsvFile(chain.csvPath);
  parsed.rows[0]["秒数"] = "5";
  await writeCsvFileAtomic(chain.csvPath, parsed.rows, { columns: parsed.columns, bom: true });
  const reportPath = join(directory, "bcol-invalid.json");
  const result = await runInferenceScript(runtime, "check_bcol.py", [
    chain.csvPath,
    `--origin=${join(directory, "边界样例.txt")}`,
    `--json-report=${reportPath}`,
  ], { cwd: directory });
  return { result, report: await jsonReport(reportPath) };
}

async function executeInvalidRoster(runtime: InferenceRuntimePaths, directory: string): Promise<{
  result: InferenceScriptResult;
  report: JsonReport;
}> {
  const chain = await executeValidChain(runtime, directory);
  await writeFile(join(directory, "角色表.txt"), "\ufeff江\n宗门弟子 | 男性 | 青年\n不完整提示词", "utf8");
  const reportPath = join(directory, "roster-invalid.json");
  const result = await runInferenceScript(runtime, "check_dcol.py", [
    "--roster-only",
    chain.csvPath,
    `--json-report=${reportPath}`,
  ], { cwd: directory });
  return { result, report: await jsonReport(reportPath) };
}

async function executeInvalidDcol(runtime: InferenceRuntimePaths, directory: string): Promise<{
  result: InferenceScriptResult;
  report: JsonReport;
}> {
  const chain = await executeValidChain(runtime, directory);
  const parsed = await readCsvFile(chain.csvPath);
  parsed.rows[0]["画面提示词"] = "固定镜头，中景";
  await writeCsvFileAtomic(chain.csvPath, parsed.rows, { columns: parsed.columns, bom: true });
  const reportPath = join(directory, "dcol-invalid.json");
  const result = await runInferenceScript(runtime, "check_dcol.py", [
    chain.csvPath,
    "--rows=1",
    `--json-report=${reportPath}`,
  ], { cwd: directory });
  return { result, report: await jsonReport(reportPath) };
}

async function executeSegmentBoundary(
  runtime: InferenceRuntimePaths,
  directory: string,
  source: string,
  marked: string,
): Promise<{ result: InferenceScriptResult; output: Buffer | null; report: JsonReport | null }> {
  const sourcePath = join(directory, "segment-boundary.txt");
  const markedPath = join(directory, "segment-boundary_marked.txt");
  const outputPath = join(directory, "segment-boundary_sentences.txt");
  const reportPath = join(directory, "segment-boundary_segment_report.json");
  await writeFile(sourcePath, `\ufeff${source}`, "utf8");
  await writeFile(markedPath, `\ufeff${marked}`, "utf8");
  const result = await runInferenceScript(runtime, "segment.py", [
    markedPath,
    `--origin=${sourcePath}`,
    `--out=${outputPath}`,
  ], { cwd: directory });
  return {
    result,
    output: await readFile(outputPath).catch(() => null),
    report: await jsonReport(reportPath).catch(() => null),
  };
}

function modelResult(text: string): TextModelResult {
  return { text, id: "differential", model: "deterministic", usage: {}, raw: {} };
}

function jobContext(): JobExecutionContext {
  return {
    jobId: "differential",
    signal: new AbortController().signal,
    updateProgress: vi.fn(),
    emit: vi.fn(),
    complete: vi.fn(),
  };
}

describeOriginalRuntime("original Python runtime differential baseline", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
  });

  async function pair(prefix: string): Promise<[string, string]> {
    const original = await mkdtemp(join(tmpdir(), `ai-tool-${prefix}-original-`));
    const current = await mkdtemp(join(tmpdir(), `ai-tool-${prefix}-current-`));
    directories.push(original, current);
    return [original, current];
  }

  it("keeps active Python and rule content equal except for product naming and patched line endings", async () => {
    const original = originalRuntime();
    const current = currentRuntime();
    for (const relativePath of BYTE_IDENTICAL_RUNTIME_FILES) {
      expect(await readFile(join(current.skill, relativePath)), relativePath)
        .toEqual(await readFile(join(original.skill, relativePath)));
    }

    const [originalBcol, currentBcol] = await Promise.all([
      readFile(join(original.scripts, "check_bcol.py"), "utf8"),
      readFile(join(current.scripts, "check_bcol.py"), "utf8"),
    ]);
    expect(normalizeBcolSource(currentBcol)).toBe(normalizeBcolSource(originalBcol));
    const [originalSkill, currentSkill] = await Promise.all([
      readFile(join(original.skill, ".claude/skills/manniu-fenjing/SKILL.md"), "utf8"),
      readFile(join(current.skill, "SKILL.md"), "utf8"),
    ]);
    expect(currentSkill).toBe(normalizeOriginalBrand(originalSkill));
  });

  it("keeps valid segmentation, skeleton bytes, exit codes and machine reports equal", async () => {
    const [originalDirectory, currentDirectory] = await pair("valid-diff");
    const [original, current] = await Promise.all([
      executeValidChain(originalRuntime(), originalDirectory),
      executeValidChain(currentRuntime(), currentDirectory),
    ]);

    expect([original.segment.code, original.skeleton.code, original.bcol.code, original.roster.code, original.dcol.code])
      .toEqual([0, 0, 0, 0, 0]);
    expect([current.segment.code, current.skeleton.code, current.bcol.code, current.roster.code, current.dcol.code])
      .toEqual([0, 0, 0, 0, 0]);
    expect(current.sentences).toEqual(original.sentences);
    expect(current.skeletonCsv).toEqual(original.skeletonCsv);
    expect(scrubReport(current.segmentReport)).toEqual(scrubReport(original.segmentReport));
    expect(scrubReport(current.bcolReport)).toEqual(scrubReport(original.bcolReport));
    expect(scrubReport(current.rosterReport)).toEqual(scrubReport(original.rosterReport));
    expect(scrubReport(current.dcolReport)).toEqual(scrubReport(original.dcolReport));
    expect(scrubOutput(current.bcol.stdout, currentDirectory))
      .toBe(scrubOutput(original.bcol.stdout, originalDirectory));
  }, 120_000);

  it("keeps B-column, roster and D-column failure classifications equal", async () => {
    const [originalB, currentB] = await pair("bcol-diff");
    const [originalRoster, currentRoster] = await pair("roster-diff");
    const [originalD, currentD] = await pair("dcol-diff");
    const [bcolOriginal, bcolCurrent, rosterOriginal, rosterCurrent, dcolOriginal, dcolCurrent] = await Promise.all([
      executeInvalidBcol(originalRuntime(), originalB),
      executeInvalidBcol(currentRuntime(), currentB),
      executeInvalidRoster(originalRuntime(), originalRoster),
      executeInvalidRoster(currentRuntime(), currentRoster),
      executeInvalidDcol(originalRuntime(), originalD),
      executeInvalidDcol(currentRuntime(), currentD),
    ]);

    expect(bcolCurrent.result.code).toBe(bcolOriginal.result.code);
    expect(rosterCurrent.result.code).toBe(rosterOriginal.result.code);
    expect(dcolCurrent.result.code).toBe(dcolOriginal.result.code);
    expect(scrubReport(bcolCurrent.report)).toEqual(scrubReport(bcolOriginal.report));
    expect(scrubReport(rosterCurrent.report)).toEqual(scrubReport(rosterOriginal.report));
    expect(scrubReport(dcolCurrent.report)).toEqual(scrubReport(dcolOriginal.report));
    expect(bcolCurrent.report.issues.map(({ code }) => code)).toContain("BCOL.DURATION_MISMATCH");
    expect(rosterCurrent.report.issues.map(({ code }) => code).some((code) => code.startsWith("ROSTER."))).toBe(true);
    expect(dcolCurrent.report.issues.map(({ code }) => code).some((code) => code.startsWith("DCOL."))).toBe(true);
  }, 120_000);

  it("keeps segment boundary exits, bytes and reports equal", async () => {
    const [originalThirtyOne, currentThirtyOne] = await pair("segment-31");
    const [originalDrift, currentDrift] = await pair("segment-drift");
    const thirtyOneCharacters = "甲".repeat(31);
    const [thirtyOneOriginal, thirtyOneCurrent, driftOriginal, driftCurrent] = await Promise.all([
      executeSegmentBoundary(originalRuntime(), originalThirtyOne, thirtyOneCharacters, thirtyOneCharacters),
      executeSegmentBoundary(currentRuntime(), currentThirtyOne, thirtyOneCharacters, thirtyOneCharacters),
      executeSegmentBoundary(originalRuntime(), originalDrift, thirtyOneCharacters, `${thirtyOneCharacters}乙`),
      executeSegmentBoundary(currentRuntime(), currentDrift, thirtyOneCharacters, `${thirtyOneCharacters}乙`),
    ]);

    expect(thirtyOneCurrent.result.code).toBe(thirtyOneOriginal.result.code);
    expect(thirtyOneCurrent.result.code).toBe(0);
    expect(thirtyOneCurrent.output).toEqual(thirtyOneOriginal.output);
    expect(thirtyOneCurrent.report).toEqual(thirtyOneOriginal.report);
    expect(thirtyOneCurrent.report?.issues).toEqual([]);
    expect(driftCurrent.result.code).toBe(driftOriginal.result.code);
    expect(driftCurrent.result.code).toBe(3);
    expect(driftCurrent.output).toBeNull();
    expect(driftOriginal.output).toBeNull();
    expect(scrubOutput(driftCurrent.result.stderr, currentDrift))
      .toBe(scrubOutput(driftOriginal.result.stderr, originalDrift));
  }, 120_000);

  it("keeps TypeScript orchestration names and Python-derived artifacts compatible with the original runtime", async () => {
    const workDirectory = await mkdtemp(join(tmpdir(), "ai-tool-orchestration-current-"));
    const oracleDirectory = await mkdtemp(join(tmpdir(), "ai-tool-orchestration-original-"));
    directories.push(workDirectory, oracleDirectory);
    const title = "编排差分";
    const sentences = Array.from({ length: 10 }, (_, index) => `江青羽第${index + 1}次缓缓抬起右手凝视前方。`);
    const source = sentences.join("");
    const marked = sentences.join("‖");
    const allowed = (user: string): number[] => {
      const match = user.match(/唯一允许镜号：([\d,]+)/u);
      if (!match) throw new Error("缺少批次镜号");
      return match[1].split(",").map(Number);
    };
    const callModel: OriginalInferenceModelCall = async (request) => {
      if (request.stage === "blueprint") return modelResult(JSON.stringify({ arc: "开场氛围：肃静\n高潮区间：抬手\n收尾意境：平静" }));
      if (request.stage === "assets" || request.stage === "assets-repair") return modelResult(JSON.stringify({ roster: ROSTER }));
      if (request.stage === "segmentation" || request.stage === "segmentation-repair") return modelResult(JSON.stringify({ marked_text: marked }));
      if (request.stage === "storyboards" || request.stage === "storyboard-repair") {
        return modelResult(JSON.stringify({
          prompts: allowed(request.user).map((index) => ({
            index,
            prompt: `@江青羽 第${index}次缓缓抬起右手凝视前方，小动态，固定镜头，中景`,
          })),
        }));
      }
      return modelResult(JSON.stringify({ patches: [] }));
    };

    const result = await runOriginalInference({
      text: source,
      title,
      genre: "玄幻",
      workDir: workDirectory,
      runtime: currentRuntime(),
      context: jobContext(),
      callModel,
    });

    expect(Object.fromEntries(Object.entries(result.artifacts).map(([key, path]) => [key, basename(path)]))).toEqual({
      sourcePath: `${title}.txt`,
      arcPath: `${title}_arc.txt`,
      rosterPath: "角色表.txt",
      markedPath: `${title}_marked.txt`,
      sentencesPath: `${title}_sentences.txt`,
      csvPath: `${title}.csv`,
      bcolSnapshotPath: `${title}_bcol_snapshot.csv`,
      bcolReportPath: "bcol_validation_report.json",
      dcolReportPath: "dcol_validation_report.json",
      rosterReportPath: "roster_validation_report.json",
      failureDiagnosticsPath: "failure_diagnostics.txt",
      workDir: basename(workDirectory),
    });
    await writeFile(join(oracleDirectory, `${title}.txt`), await readFile(result.artifacts.sourcePath));
    await writeFile(join(oracleDirectory, `${title}_marked.txt`), await readFile(result.artifacts.markedPath));
    await writeFile(join(oracleDirectory, "角色表.txt"), await readFile(result.artifacts.rosterPath));
    const oracleSentences = join(oracleDirectory, `${title}_sentences.txt`);
    const oracleCsv = join(oracleDirectory, `${title}.csv`);
    const segment = await runInferenceScript(originalRuntime(), "segment.py", [
      join(oracleDirectory, `${title}_marked.txt`),
      `--origin=${join(oracleDirectory, `${title}.txt`)}`,
      `--out=${oracleSentences}`,
    ], { cwd: oracleDirectory });
    const skeleton = await runInferenceScript(originalRuntime(), "build_storyboard_skeleton.py", [
      oracleSentences,
      `--origin=${join(oracleDirectory, `${title}.txt`)}`,
      `--csv-out=${oracleCsv}`,
    ], { cwd: oracleDirectory });
    expect([segment.code, skeleton.code]).toEqual([0, 0]);
    expect(await readFile(result.artifacts.sentencesPath)).toEqual(await readFile(oracleSentences));
    const [actualCsv, oracleSkeleton] = await Promise.all([readCsvFile(result.artifacts.csvPath), readCsvFile(oracleCsv)]);
    expect(actualCsv.rows.map(({ 编号, 原声, 秒数 }) => ({ 编号, 原声, 秒数 })))
      .toEqual(oracleSkeleton.rows.map(({ 编号, 原声, 秒数 }) => ({ 编号, 原声, 秒数 })));
    const [bcol, dcol] = await Promise.all([
      runInferenceScript(originalRuntime(), "check_bcol.py", [
        result.artifacts.csvPath,
        `--origin=${result.artifacts.sourcePath}`,
      ], { cwd: workDirectory }),
      runInferenceScript(originalRuntime(), "check_dcol.py", [result.artifacts.csvPath], { cwd: workDirectory }),
    ]);
    expect([bcol.code, dcol.code], `${bcol.stderr}${bcol.stdout}${dcol.stderr}${dcol.stdout}`).toEqual([0, 0]);
  }, 120_000);
});
