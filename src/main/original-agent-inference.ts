import { cp, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { StoryboardDraft } from "../shared/contracts";
import { readCsvFile, writeCsvFileAtomic, writeTextFileAtomic } from "./file-workflows";
import { PauseJobError, type JobExecutionContext } from "./jobs";
import {
  runClaudeAgent,
  type ClaudeAgentRuntimeOptions,
  type ClaudeAgentRuntimeResult,
} from "./claude-agent-runtime";
import {
  runInferenceScript,
  type InferenceRuntimePaths,
  type InferenceScriptResult,
} from "./inference-runtime";
import {
  originalInferenceBatchPrompt,
  originalInferenceBatchRepairPrompt,
  originalInferenceFullRepairPrompt,
  originalInferenceSemanticReviewPrompt,
  originalInferenceSkeletonPrompt,
  originalInferenceSkeletonRepairPrompt,
} from "./original-agent-prompts";
import {
  originalRepairScope,
  parseOriginalRoster,
  restoreOriginalAbcRows,
  type OriginalInferenceArtifacts,
  type OriginalInferenceResult,
  type OriginalInferenceStage,
} from "./original-inference";

const CSV_COLUMNS = ["编号", "原声", "秒数", "画面提示词"] as const;
const SKELETON_REPAIR_LIMIT = 3;
const BATCH_REPAIR_LIMIT = 3;
const FULL_TABLE_REPAIR_LIMIT = 3;

export type OriginalAgentRuntimeConfig = Omit<
  ClaudeAgentRuntimeOptions,
  "pythonPath" | "proxyPath" | "cwd" | "prompt" | "context" | "progressStart" | "progressEnd"
> & {
  pythonPath?: string;
  proxyPath?: string;
};

export type OriginalAgentCall = (
  options: ClaudeAgentRuntimeOptions,
) => Promise<ClaudeAgentRuntimeResult>;

export type OriginalInferenceScriptCall = typeof runInferenceScript;

export type OriginalAgentInferenceOptions = {
  text: string;
  title: string;
  genre: string;
  workDir: string;
  runtime: InferenceRuntimePaths;
  agent: OriginalAgentRuntimeConfig;
  context: JobExecutionContext;
  runAgent?: OriginalAgentCall;
  runScript?: OriginalInferenceScriptCall;
};

type StoryboardRow = Record<string, string>;

type ValidationState = {
  passed: boolean;
  report: string;
  rows: StoryboardRow[];
};

function safeTitle(value: string): string {
  const safe = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_").replace(/[. ]+$/u, "").slice(0, 80);
  return safe || "未命名小说";
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("推理任务已停止");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function compactFailure(result: InferenceScriptResult): string {
  return [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n").slice(-12_000);
}

async function existingText(path: string): Promise<string | null> {
  return readFile(path, "utf8")
    .then((value) => value.replace(/^\ufeff/u, "").trim())
    .catch(() => null);
}

async function reportText(path: string, result: InferenceScriptResult): Promise<string> {
  return (await existingText(path)) || compactFailure(result) || `validator exited with code ${result.code}`;
}

async function readRows(csvPath: string): Promise<StoryboardRow[]> {
  const parsed = await readCsvFile(csvPath);
  const missing = CSV_COLUMNS.filter((column) => !parsed.columns.includes(column));
  if (missing.length > 0) throw new Error(`CSV 缺少固定表头：${missing.join("、")}`);
  const indexes = new Set<number>();
  for (const row of parsed.rows) {
    const index = Number(row["编号"]);
    if (!Number.isInteger(index) || index <= 0) throw new Error(`CSV 包含无效镜号：${row["编号"] ?? ""}`);
    if (indexes.has(index)) throw new Error(`CSV 镜号重复：${index}`);
    indexes.add(index);
  }
  return parsed.rows;
}

async function writeRows(csvPath: string, rows: StoryboardRow[]): Promise<void> {
  await writeCsvFileAtomic(csvPath, rows, { columns: [...CSV_COLUMNS], bom: true });
}

function rowsEqual(left: StoryboardRow[], right: StoryboardRow[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((row, index) => CSV_COLUMNS.every((column) =>
    (row[column] ?? "") === (right[index]?.[column] ?? "")));
}

function mergeProtectedRows(options: {
  snapshot: StoryboardRow[];
  before: StoryboardRow[];
  current: StoryboardRow[];
  allowedD: ReadonlySet<number>;
}): StoryboardRow[] {
  const abcRestored = restoreOriginalAbcRows(options.snapshot, options.current);
  const beforeByIndex = new Map(options.before.map((row) => [Number(row["编号"]), row]));
  return abcRestored.map((row) => {
    const index = Number(row["编号"]);
    return {
      ...row,
      画面提示词: options.allowedD.has(index)
        ? row["画面提示词"] ?? ""
        : beforeByIndex.get(index)?.["画面提示词"] ?? "",
    };
  });
}

export async function prepareOriginalAgentWorkspace(
  options: Pick<OriginalAgentInferenceOptions, "text" | "workDir" | "runtime">,
  title: string,
): Promise<void> {
  const workDir = resolve(options.workDir);
  const projectSkills = join(workDir, ".claude", "skills");
  const projectSkill = join(projectSkills, "ai-tool-fenjing");
  await mkdir(workDir, { recursive: true });
  await Promise.all([
    cp(options.runtime.skill, projectSkill, { recursive: true, force: true }),
    cp(join(options.runtime.skill, "scripts"), join(workDir, "scripts"), { recursive: true, force: true }),
    cp(join(options.runtime.skill, "references"), join(workDir, "references"), { recursive: true, force: true }),
    cp(join(options.runtime.skill, "SKILL.md"), join(workDir, "SKILL.md"), { force: true }),
    cp(join(options.runtime.skill, "CLAUDE.md"), join(workDir, "CLAUDE.md"), { force: true }),
    cp(join(options.runtime.skill, "verify_split_extreme.py"), join(workDir, "verify_split_extreme.py"), { force: true }),
  ]);
  await writeTextFileAtomic(join(workDir, `${title}.txt`), options.text);
}

function progressRange(start: number, end: number): { progressStart: number; progressEnd: number } {
  return { progressStart: Math.max(0, Math.floor(start)), progressEnd: Math.min(100, Math.ceil(end)) };
}

async function pauseWithDiagnostics(options: {
  message: string;
  stage: string;
  artifacts: OriginalInferenceArtifacts;
  reportPaths: string[];
  rows: StoryboardRow[];
  context: JobExecutionContext;
}): Promise<never> {
  const completedIndexes = options.rows
    .filter((row) => row["画面提示词"]?.trim())
    .map((row) => Number(row["编号"]))
    .filter((index) => Number.isInteger(index) && index > 0);
  const existingReports = (await Promise.all(options.reportPaths.map(async (path) =>
    (await existingText(path)) === null ? null : path))).filter((path): path is string => path !== null);
  await writeTextFileAtomic(options.artifacts.failureDiagnosticsPath, [
    "AI工具 original file-agent inference diagnostics",
    `work_dir=${options.artifacts.workDir}`,
    `stage=${options.stage}`,
    `completed_indexes=${completedIndexes.join(",")}`,
    `reports=${existingReports.join(";")}`,
    `reason=${options.message}`,
    "",
  ].join("\n"));
  const detail = {
    stage: options.stage,
    workDir: options.artifacts.workDir,
    reportPaths: [...new Set([...existingReports, options.artifacts.failureDiagnosticsPath])],
    completedIndexes,
  };
  options.context.emit("warning", "推理任务已暂停，工作文件和诊断报告已保留", detail);
  throw new PauseJobError(`${options.message}。工作目录已保留：${options.artifacts.workDir}`, detail);
}

export async function runOriginalAgentInference(
  options: OriginalAgentInferenceOptions,
): Promise<OriginalInferenceResult> {
  const title = safeTitle(options.title);
  const workDir = resolve(options.workDir);
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
  const artifacts: OriginalInferenceArtifacts = {
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
  const runAgent = options.runAgent ?? runClaudeAgent;
  const runScript = options.runScript ?? runInferenceScript;
  const agentResults: ClaudeAgentRuntimeResult[] = [];
  const stages: OriginalInferenceStage[] = [];

  throwIfAborted(options.context.signal);
  options.context.updateProgress(4, "正在准备原版文件 Agent 工作区");
  await prepareOriginalAgentWorkspace(options, title);

  const callAgent = async (
    stage: OriginalInferenceStage,
    prompt: string,
    progressStart: number,
    progressEnd: number,
  ): Promise<ClaudeAgentRuntimeResult> => {
    throwIfAborted(options.context.signal);
    stages.push(stage);
    const result = await runAgent({
      ...options.agent,
      pythonPath: options.agent.pythonPath ?? options.runtime.python,
      proxyPath: options.agent.proxyPath ?? join(options.runtime.skill, "claude_openai_proxy.py"),
      cwd: workDir,
      prompt,
      context: options.context,
      ...progressRange(progressStart, progressEnd),
    });
    throwIfAborted(options.context.signal);
    agentResults.push(result);
    return result;
  };

  const callScript = async (script: string, args: string[]): Promise<InferenceScriptResult> => {
    throwIfAborted(options.context.signal);
    const result = await runScript(options.runtime, script, args, { cwd: workDir, signal: options.context.signal });
    throwIfAborted(options.context.signal);
    return result;
  };

  const inspectSkeleton = async (): Promise<ValidationState> => {
    const reports: string[] = [];
    const bcol = await callScript("check_bcol.py", [
      csvPath,
      `--origin=${sourcePath}`,
      `--json-report=${bcolReportPath}`,
    ]);
    if (bcol.code !== 0) reports.push(`BCOL_REPORT\n${await reportText(bcolReportPath, bcol)}`);
    const roster = await callScript("check_dcol.py", [
      "--roster-only",
      csvPath,
      `--json-report=${rosterReportPath}`,
    ]);
    if (roster.code !== 0) reports.push(`ROSTER_REPORT\n${await reportText(rosterReportPath, roster)}`);
    let rows: StoryboardRow[] = [];
    try {
      rows = await readRows(csvPath);
      const filledD = rows.filter((row) => row["画面提示词"]?.trim()).map((row) => Number(row["编号"]));
      if (filledD.length > 0) reports.push(`SKELETON.D_NOT_EMPTY rows=${filledD.join(",")}`);
    } catch (error) {
      reports.push(`SKELETON.CSV_INVALID ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const rosterText = await readFile(rosterPath, "utf8");
      const assets = parseOriginalRoster(rosterText);
      if (!assets.some((asset) => asset.assetType === "character")) {
        reports.push("ROSTER.NO_CHARACTER 角色表没有实际出场人物");
      }
    } catch (error) {
      reports.push(`ROSTER.PARSE_FAILED ${error instanceof Error ? error.message : String(error)}`);
    }
    return { passed: reports.length === 0, report: reports.join("\n\n"), rows };
  };

  options.context.updateProgress(7, "正在启动角色表与 ABC 骨架 Agent");
  await callAgent(
    "assets",
    originalInferenceSkeletonPrompt({ title, genre: options.genre || "自动判断" }),
    7,
    28,
  );
  let skeleton = await inspectSkeleton();
  let previousSkeletonReport = skeleton.report;
  for (let attempt = 0; attempt < SKELETON_REPAIR_LIMIT && !skeleton.passed; attempt += 1) {
    options.context.updateProgress(29, "正在按硬校验报告修复角色表与 ABC 骨架", { attempt: attempt + 1 });
    await callAgent(
      "assets-repair",
      originalInferenceSkeletonRepairPrompt({
        title,
        report: skeleton.report,
        repeated: attempt > 0 && skeleton.report === previousSkeletonReport,
      }),
      29,
      36,
    );
    previousSkeletonReport = skeleton.report;
    skeleton = await inspectSkeleton();
  }
  if (!skeleton.passed) {
    await pauseWithDiagnostics({
      message: `角色表或 ABC 骨架连续校验失败：${skeleton.report}`,
      stage: "skeleton",
      artifacts,
      reportPaths: [bcolReportPath, rosterReportPath],
      rows: skeleton.rows,
      context: options.context,
    });
  }

  let rows = skeleton.rows;
  const snapshotRows = rows.map((row) => ({ ...row, 画面提示词: "" }));
  await writeRows(bcolSnapshotPath, snapshotRows);
  const rosterSnapshot = await readFile(rosterPath, "utf8");
  options.context.emit("info", "已保存 Agent 生成前 ABC 与角色表只读快照", {
    bcolSnapshotPath,
    rosterPath,
    rows: rows.length,
  });

  const restoreProtectedState = async (
    before: StoryboardRow[],
    allowedD: ReadonlySet<number>,
    stage: string,
  ): Promise<StoryboardRow[]> => {
    const current = await readRows(csvPath);
    const protectedRows = mergeProtectedRows({ snapshot: snapshotRows, before, current, allowedD });
    const currentRoster = await readFile(rosterPath, "utf8").catch(() => "");
    const changedRows = !rowsEqual(current, protectedRows);
    const changedRoster = currentRoster !== rosterSnapshot;
    if (changedRows) await writeRows(csvPath, protectedRows);
    if (changedRoster) await writeTextFileAtomic(rosterPath, rosterSnapshot);
    if (changedRows || changedRoster) {
      options.context.emit("warning", "检测到 Agent 修改受保护数据，已按快照恢复", {
        stage,
        abcOrOutOfScopeD: changedRows,
        roster: changedRoster,
      });
    }
    const bcol = await callScript("check_bcol.py", [
      csvPath,
      `--origin=${sourcePath}`,
      `--json-report=${bcolReportPath}`,
    ]);
    if (bcol.code !== 0) {
      await pauseWithDiagnostics({
        message: `ABC 骨架恢复后仍未通过 B 列硬校验：${await reportText(bcolReportPath, bcol)}`,
        stage,
        artifacts,
        reportPaths: [bcolReportPath],
        rows: protectedRows,
        context: options.context,
      });
    }
    return protectedRows;
  };

  let cursor = 0;
  let batchSize = 10;
  while (cursor < rows.length) {
    throwIfAborted(options.context.signal);
    const selected = rows.slice(cursor, cursor + batchSize);
    const indexes = selected.map((row) => Number(row["编号"]));
    const allowed = new Set(indexes);
    const beforeBatch = rows.map((row) => ({ ...row }));
    const rangeStart = 38 + Math.floor((cursor / Math.max(1, rows.length)) * 42);
    const rangeEnd = 38 + Math.floor(((cursor + selected.length) / Math.max(1, rows.length)) * 42);
    options.context.updateProgress(rangeStart, "正在按原版文件 Agent 逐镜填写 D 列", {
      current: cursor + 1,
      total: rows.length,
      indexes,
    });
    await callAgent(
      "storyboards",
      originalInferenceBatchPrompt({
        title,
        total: rows.length,
        remaining: rows.slice(cursor).filter((row) => !(row["画面提示词"] ?? "").trim()).length,
        indexes,
      }),
      rangeStart,
      Math.max(rangeStart + 1, rangeEnd),
    );
    rows = await restoreProtectedState(beforeBatch, allowed, "dfill-batch");
    const batchReportPath = join(workDir, `dcol-batch-${indexes[0]}-${indexes.at(-1)}.json`);
    let batchCheck = await callScript("check_dcol.py", [
      csvPath,
      `--rows=${indexes.join(",")}`,
      `--json-report=${batchReportPath}`,
    ]);
    let report = batchCheck.code === 0 ? "" : await reportText(batchReportPath, batchCheck);
    let previousReport = report;
    let hadFailure = batchCheck.code !== 0;
    for (let attempt = 0; attempt < BATCH_REPAIR_LIMIT && batchCheck.code !== 0; attempt += 1) {
      const scope = originalRepairScope(report, allowed);
      const repairIndexes = scope.issueRows.length > 0 ? scope.issueRows : indexes;
      const repairAllowed = new Set(repairIndexes);
      const beforeRepair = rows.map((row) => ({ ...row }));
      options.context.updateProgress(rangeStart, "正在按结构化报告定向修复 D 列", {
        attempt: attempt + 1,
        indexes: repairIndexes,
      });
      await callAgent(
        "storyboard-repair",
        originalInferenceBatchRepairPrompt({
          title,
          indexes: repairIndexes,
          report,
          repeated: attempt > 0 && report === previousReport,
        }),
        rangeStart,
        Math.max(rangeStart + 1, rangeEnd),
      );
      rows = await restoreProtectedState(beforeRepair, repairAllowed, "dfill-batch-repair");
      previousReport = report;
      batchCheck = await callScript("check_dcol.py", [
        csvPath,
        `--rows=${indexes.join(",")}`,
        `--json-report=${batchReportPath}`,
      ]);
      report = batchCheck.code === 0 ? "" : await reportText(batchReportPath, batchCheck);
    }
    if (batchCheck.code !== 0) {
      if (selected.length > 10) {
        rows = beforeBatch;
        await writeRows(csvPath, rows);
        batchSize = 10;
        options.context.emit("warning", "当前批次多轮修复未清零，已缩回 10 镜重试", { indexes });
        continue;
      }
      await pauseWithDiagnostics({
        message: `分镜 ${indexes.join(",")} 多轮修复后仍未通过 D 列硬校验：${report}`,
        stage: "dfill-batch",
        artifacts,
        reportPaths: [batchReportPath, rosterReportPath, bcolReportPath],
        rows,
        context: options.context,
      });
    }
    cursor += selected.length;
    batchSize = hadFailure ? 10 : batchSize === 10 ? 20 : 30;
  }

  options.context.updateProgress(84, "正在启动独立语义审片 Agent");
  const beforeReview = rows.map((row) => ({ ...row }));
  await callAgent("semantic-review", originalInferenceSemanticReviewPrompt(title), 84, 91);
  rows = await restoreProtectedState(beforeReview, new Set(rows.map((row) => Number(row["编号"]))), "semantic-review");

  let fullCheck = await callScript("check_dcol.py", [csvPath, `--json-report=${dcolReportPath}`]);
  let fullReport = fullCheck.code === 0 ? "" : await reportText(dcolReportPath, fullCheck);
  let previousFullReport = fullReport;
  for (let attempt = 0; attempt < FULL_TABLE_REPAIR_LIMIT && fullCheck.code !== 0; attempt += 1) {
    const scope = originalRepairScope(fullReport);
    const repairIndexes = scope.issueRows.length > 0
      ? scope.issueRows
      : rows.map((row) => Number(row["编号"]));
    const beforeRepair = rows.map((row) => ({ ...row }));
    options.context.updateProgress(92, "正在闭环修复全表硬校验错误", {
      attempt: attempt + 1,
      indexes: repairIndexes,
    });
    await callAgent(
      "full-table-repair",
      originalInferenceFullRepairPrompt({
        title,
        report: fullReport,
        repeated: attempt > 0 && fullReport === previousFullReport,
      }),
      92,
      95,
    );
    rows = await restoreProtectedState(beforeRepair, new Set(repairIndexes), "full-table-repair");
    previousFullReport = fullReport;
    fullCheck = await callScript("check_dcol.py", [csvPath, `--json-report=${dcolReportPath}`]);
    fullReport = fullCheck.code === 0 ? "" : await reportText(dcolReportPath, fullCheck);
  }
  if (fullCheck.code !== 0) {
    await pauseWithDiagnostics({
      message: `语义审片后的全表硬校验多轮修复仍未清零：${fullReport}`,
      stage: "full-table-repair",
      artifacts,
      reportPaths: [dcolReportPath, rosterReportPath, bcolReportPath],
      rows,
      context: options.context,
    });
  }

  rows = await restoreProtectedState(rows, new Set(rows.map((row) => Number(row["编号"]))), "final");
  const finalRoster = await callScript("check_dcol.py", [
    "--roster-only",
    csvPath,
    `--json-report=${rosterReportPath}`,
  ]);
  const finalDcol = await callScript("check_dcol.py", [csvPath, `--json-report=${dcolReportPath}`]);
  if (finalRoster.code !== 0 || finalDcol.code !== 0) {
    await pauseWithDiagnostics({
      message: "最终角色表或 D 列硬校验未通过",
      stage: "final",
      artifacts,
      reportPaths: [rosterReportPath, dcolReportPath, bcolReportPath],
      rows,
      context: options.context,
    });
  }

  const rosterText = await readFile(rosterPath, "utf8");
  const characters = parseOriginalRoster(rosterText);
  const characterNames = characters
    .filter((asset) => asset.assetType === "character")
    .map((asset) => asset.name);
  const storyboards: StoryboardDraft[] = rows.map((row, index) => ({
    index,
    originalText: row["原声"] ?? "",
    subjects: characterNames.filter((name) => (row["画面提示词"] ?? "").includes(`@${name}`)),
    prompt: row["画面提示词"] ?? "",
    duration: Number(row["秒数"]) || 4,
  }));
  options.context.updateProgress(98, "原版文件 Agent 推理已通过全部硬校验", {
    assets: characters.length,
    storyboards: storyboards.length,
  });
  return {
    characters,
    storyboards,
    artifacts,
    model: options.agent.model,
    usage: agentResults.map((result) => ({
      sessionId: result.sessionId,
      model: result.model,
      eventCount: result.eventCount,
      exitCode: result.exitCode,
    })),
    stages,
    legacyFastPath: false,
  };
}
