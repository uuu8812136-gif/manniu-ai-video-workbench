import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inferenceRuntimePaths, runInferenceScript } from "../src/main/inference-runtime";
import {
  applyOriginalPromptPatches,
  originalRepairScope,
  parseOriginalRoster,
  restoreOriginalAbcRows,
  runOriginalInference,
  type OriginalInferenceModelCall,
} from "../src/main/original-inference";
import { readCsvFile, writeCsvFileAtomic } from "../src/main/file-workflows";
import { PauseJobError, type JobEventLevel, type JobExecutionContext } from "../src/main/jobs";
import type { TextModelResult } from "../src/main/model-clients";

const VALID_CHARACTER_PROMPT = [
  "一张16:9比例的宽幅图像，画面包含该角色的设定集排版，严格遵循绝对的物理隔离排版规则：",
  "【左侧三分之一区域】：超大面部特写；",
  "【右侧三分之二区域】：依次排列全身正视图、全身侧视图、全身后视图。",
  "青年男性，清俊面容，黑色高马尾，白色劲装，",
  "100%纯正的顶级3D国漫风格，顶级3D国漫渲染风格，虚幻引擎5渲染，辛烷渲染，高级材质质感，",
  "绝对标准的人体比例严禁大头娃娃，双眼平视镜头，绝对无表情，不准笑，双臂自然下垂，",
  "纯白干净的背景，绝对没有任何环境杂物，绝对禁止2D动漫、绝对禁止赛璐璐、绝对禁止真人摄影、绝对禁止低模。",
].join("，");

const VALID_ROSTER = [
  "江青璃",
  "宗门弟子 | 女性 | 青年",
  VALID_CHARACTER_PROMPT,
].join("\n");

function validStoryboardPrompt(index: number): string {
  return `@江青璃 第${index}次缓缓抬起右手凝视前方，小动态，固定镜头，中景`;
}

function reviewedStoryboardPrompt(index: number): string {
  return `@江青璃 第${index}次缓缓放下右手凝视前方，小动态，固定镜头，中景`;
}

function modelResult(text: string): TextModelResult {
  return { text, id: "mock-response", model: "mock-inference", usage: { output_tokens: text.length }, raw: {} };
}

function inferenceText(count: number): { source: string; marked: string } {
  const sentences = Array.from({ length: count }, (_, index) => `江青璃第${index + 1}次缓缓抬起右手凝视前方。`);
  return { source: sentences.join(""), marked: sentences.join("‖") };
}

function allowedIndexes(user: string): number[] {
  const matched = user.match(/唯一允许镜号：([\d,]+)/u);
  if (!matched) throw new Error("测试模型没有收到批次镜号");
  return matched[1].split(",").map(Number);
}

function promptResponse(indexes: number[], prompt?: string): TextModelResult {
  return modelResult(JSON.stringify({
    prompts: indexes.map((index) => ({ index, prompt: prompt ?? validStoryboardPrompt(index) })),
  }));
}

function context(events: Array<{ level: JobEventLevel; message: string; detail: unknown }>): JobExecutionContext {
  return {
    jobId: "test-original-inference",
    signal: new AbortController().signal,
    updateProgress: vi.fn(),
    emit: (level, message, detail) => events.push({ level, message, detail }),
    complete: vi.fn(),
  };
}

describe("original inference compatibility runtime", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
  });

  it("parses strict character, scene and special-space assets", () => {
    const roster = [
      "江青羽",
      "宗门弟子 | 男性 | 青年",
      VALID_CHARACTER_PROMPT,
      "###",
      "宗门大殿",
      "资产 | 场景",
      "一张16:9比例的宽幅图像，纯场景无人物，恢弘宗门大殿，石柱与灯火，顶级3D国漫风格",
      "###",
      "识海",
      "资产 | 特殊空间",
      "一张16:9比例的宽幅图像，纯场景无人物，幽蓝精神空间与光粒，顶级3D国漫风格",
      "",
      "# 角色别名 | 江青羽 | 小羽、江少爷",
    ].join("\n");

    expect(parseOriginalRoster(roster)).toMatchObject([
      {
        name: "江青羽",
        assetType: "character",
        aliases: ["小羽", "江少爷"],
        appearance: "青年男性，清俊面容",
        hair: "黑色高马尾",
        clothing: "白色劲装",
      },
      { name: "宗门大殿", assetType: "scene" },
      { name: "识海", assetType: "special-space" },
    ]);
  });

  it("blocks incomplete character makeup prompts", () => {
    expect(() => parseOriginalRoster([
      "江青羽",
      "宗门弟子 | 男性 | 青年",
      "青年男性，黑色高马尾，白色劲装",
    ].join("\n"))).toThrow(/16:9/u);
  });

  it("returns a roster-only script failure to the asset repair stage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-tool-original-roster-script-repair-"));
    temporaryDirectories.push(directory);
    const runtime = inferenceRuntimePaths(join(process.cwd(), "vendor"));
    const novel = inferenceText(10);
    const stages: string[] = [];
    const scriptInvalidRoster = [
      "江",
      "宗门弟子 | 女性 | 青年",
      VALID_CHARACTER_PROMPT,
    ].join("\n");

    const result = await runOriginalInference({
      text: novel.source,
      title: "角色脚本修复",
      genre: "玄幻",
      workDir: directory,
      runtime,
      context: context([]),
      callModel: async (request) => {
        stages.push(request.stage);
        if (request.stage === "blueprint") {
          return modelResult(JSON.stringify({ arc: "开场氛围：肃静\n高潮区间：抬手\n收尾意境：平静" }));
        }
        if (request.stage === "assets") return modelResult(JSON.stringify({ roster: scriptInvalidRoster }));
        if (request.stage === "assets-repair") {
          expect(request.user).toContain("check_dcol.py --roster-only");
          expect(request.user).toContain("标准名");
          return modelResult(JSON.stringify({ roster: VALID_ROSTER }));
        }
        if (request.stage === "segmentation" || request.stage === "segmentation-repair") {
          return modelResult(JSON.stringify({ marked_text: novel.marked }));
        }
        if (request.stage === "storyboards" || request.stage === "storyboard-repair") {
          return promptResponse(allowedIndexes(request.user));
        }
        return modelResult(JSON.stringify({ patches: [] }));
      },
    });

    expect(stages.filter((stage) => stage === "assets")).toHaveLength(1);
    expect(stages.filter((stage) => stage === "assets-repair")).toHaveLength(1);
    expect(result.characters[0]).toMatchObject({
      name: "江青璃",
      appearance: "青年男性，清俊面容",
      hair: "黑色高马尾",
      clothing: "白色劲装",
    });
    await expect(readFile(result.artifacts.rosterPath, "utf8")).resolves.toContain("江青璃");
  }, 120_000);

  it("blocks model patches outside the active storyboard batch", () => {
    const rows = [
      { 编号: "1", 原声: "第一镜", 秒数: "2", 画面提示词: "" },
      { 编号: "2", 原声: "第二镜", 秒数: "2", 画面提示词: "" },
    ];
    expect(() => applyOriginalPromptPatches(
      rows,
      [{ index: 2, prompt: "越权画面" }],
      new Set([1]),
    )).toThrow(/批次外镜号 2/u);
    expect(rows[1].画面提示词).toBe("");
  });

  it("rejects duplicate patches and limits repair scope to report rows", () => {
    const rows = [
      { 编号: "1", 原声: "第一镜", 秒数: "2", 画面提示词: "" },
      { 编号: "2", 原声: "第二镜", 秒数: "2", 画面提示词: "" },
    ];
    expect(() => applyOriginalPromptPatches(rows, [
      { index: 1, prompt: "第一次" },
      { index: 1, prompt: "第二次" },
    ], new Set([1]))).toThrow(/重复返回了镜号 1/u);

    const report = JSON.stringify({
      error_count: 2,
      issues: [
        { code: "DCOL.EMPTY", target: "d_col", row: 2, row_end: 2, fixable: true },
        { code: "ASSET.SPECIAL_SPACE_MISSING", target: "roster", row: null, row_end: null, fixable: true },
      ],
    });
    expect(originalRepairScope(report, new Set([1, 2]))).toEqual({
      issueRows: [2],
      roster: true,
      unregistered: false,
      firstCode: "DCOL.EMPTY",
    });
    expect(originalRepairScope(JSON.stringify({
      error_count: 1,
      issues: [{ code: "DCOL.UNCLASSIFIED", target: "fallback", row: null, fixable: true }],
    }))).toMatchObject({ unregistered: true, firstCode: "DCOL.UNCLASSIFIED" });
  });

  it("restores authoritative ABC rows while preserving same-index D prompts", () => {
    expect(restoreOriginalAbcRows([
      { 编号: "1", 原声: "原文一", 秒数: "2", 画面提示词: "" },
      { 编号: "2", 原声: "原文二", 秒数: "3", 画面提示词: "" },
    ], [
      { 编号: "2", 原声: "被篡改", 秒数: "99", 画面提示词: "已完成二" },
      { 编号: "3", 原声: "额外行", 秒数: "5", 画面提示词: "应删除" },
    ])).toEqual([
      { 编号: "1", 原声: "原文一", 秒数: "2", 画面提示词: "" },
      { 编号: "2", 原声: "原文二", 秒数: "3", 画面提示词: "已完成二" },
    ]);
  });

  it("runs bundled segmentation, skeleton and B-column validators", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-tool-original-inference-"));
    temporaryDirectories.push(directory);
    const sourcePath = join(directory, "样例.txt");
    const markedPath = join(directory, "样例_marked.txt");
    const sentencesPath = join(directory, "样例_sentences.txt");
    const csvPath = join(directory, "样例.csv");
    const source = "江青羽缓缓推开沉重木门，抬头看见殿内灯火骤然亮起。";
    await writeFile(sourcePath, `\ufeff${source}`, "utf8");
    await writeFile(markedPath, `\ufeff江青羽缓缓推开沉重木门，|抬头看见殿内灯火骤然亮起。`, "utf8");
    await writeFile(join(directory, "角色表.txt"), `\ufeff江青羽\n宗门弟子 | 男性 | 青年\n${VALID_CHARACTER_PROMPT}`, "utf8");

    const runtime = inferenceRuntimePaths(join(process.cwd(), "vendor"));
    const segmented = await runInferenceScript(
      runtime,
      "segment.py",
      [markedPath, `--origin=${sourcePath}`, `--out=${sentencesPath}`],
      { cwd: directory },
    );
    expect(segmented.code, segmented.stderr || segmented.stdout).toBe(0);

    const skeleton = await runInferenceScript(
      runtime,
      "build_storyboard_skeleton.py",
      [sentencesPath, `--origin=${sourcePath}`, `--csv-out=${csvPath}`],
      { cwd: directory },
    );
    expect(skeleton.code, skeleton.stderr || skeleton.stdout).toBe(0);

    const bColumn = await runInferenceScript(
      runtime,
      "check_bcol.py",
      [csvPath, `--origin=${sourcePath}`],
      { cwd: directory },
    );
    expect(bColumn.code, bColumn.stderr || bColumn.stdout).toBe(0);

    const rosterOnly = await runInferenceScript(
      runtime,
      "check_dcol.py",
      ["--roster-only", csvPath],
      { cwd: directory },
    );
    expect(rosterOnly.code, rosterOnly.stderr || rosterOnly.stdout).toBe(0);

    const parsed = await readCsvFile(csvPath);
    expect(parsed.columns).toEqual(["编号", "原声", "秒数", "画面提示词"]);
    expect(parsed.rows.map((row) => row.秒数)).toEqual(["2", "2"]);
    expect((await readFile(sentencesPath, "utf8")).replace(/^\ufeff/u, "").split(/\r?\n/u).filter(Boolean)).toHaveLength(2);
  });

  it("runs the production multi-stage pipeline, repairs early stages, expands 10/20/30 batches, rolls back invalid semantic patches and resumes from checkpoints", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-tool-original-inference-e2e-"));
    temporaryDirectories.push(directory);
    const runtime = inferenceRuntimePaths(join(process.cwd(), "vendor"));
    const novel = inferenceText(60);
    const calls: Array<{ stage: string; indexes: number[] }> = [];
    const modelRequests: Array<Parameters<OriginalInferenceModelCall>[0]> = [];
    const events: Array<{ level: JobEventLevel; message: string; detail: unknown }> = [];
    let assetAttempts = 0;
    let segmentationAttempts = 0;
    let semanticReviews = 0;

    const callModel: OriginalInferenceModelCall = async (request) => {
      modelRequests.push(request);
      if (request.stage === "blueprint") {
        return modelResult(JSON.stringify({ arc: "开场氛围：肃静\n高潮区间：抬手\n收尾意境：平静" }));
      }
      if (request.stage === "assets" || request.stage === "assets-repair") {
        assetAttempts += 1;
        return modelResult(JSON.stringify({
          roster: assetAttempts === 1 ? "江青璃\n宗门弟子 | 女性 | 青年\n不完整提示词" : VALID_ROSTER,
        }));
      }
      if (request.stage === "segmentation" || request.stage === "segmentation-repair") {
        segmentationAttempts += 1;
        return modelResult(JSON.stringify({
          marked_text: segmentationAttempts === 1 ? `${novel.marked}篡改` : novel.marked,
        }));
      }
      if (request.stage === "storyboards" || request.stage === "storyboard-repair") {
        const indexes = allowedIndexes(request.user);
        calls.push({ stage: request.stage, indexes });
        return promptResponse(indexes);
      }
      semanticReviews += 1;
      if (semanticReviews === 1) {
        return modelResult(JSON.stringify({
          patches: [
            { index: 1, prompt: reviewedStoryboardPrompt(1) },
            { index: 2, prompt: "固定镜头，中景" },
          ],
        }));
      }
      throw new Error("provider unavailable during semantic review");
    };

    const result = await runOriginalInference({
      text: novel.source,
      title: "完整推理",
      genre: "玄幻",
      workDir: directory,
      runtime,
      context: context(events),
      callModel,
    });

    expect(assetAttempts).toBe(2);
    expect(segmentationAttempts).toBe(2);
    expect(calls.map((entry) => entry.indexes.length)).toEqual([10, 20, 30]);
    expect(result.stages).toEqual([
      "blueprint",
      "assets",
      "assets-repair",
      "segmentation",
      "segmentation-repair",
      "storyboards",
      "storyboards",
      "storyboards",
      "semantic-review",
      "semantic-review",
    ]);
    expect(result.legacyFastPath).toBe(false);
    expect(result.storyboards).toHaveLength(60);
    expect(result.storyboards[0]?.prompt).toBe(reviewedStoryboardPrompt(1));
    expect(result.storyboards.slice(1).every((item) => item.prompt === validStoryboardPrompt(item.index + 1))).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({
      level: "warning",
      message: "语义复核修改未通过硬校验，已自动回退",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      level: "warning",
      message: "语义审片异常，继续硬校验",
    }));

    const assetRequest = modelRequests.find((request) => request.stage === "assets");
    expect(assetRequest?.system).toContain("# 原版角色表模板");
    expect(assetRequest?.system).toContain("李小龙");
    const segmentationRequest = modelRequests.find((request) => request.stage === "segmentation");
    expect(segmentationRequest?.system).toContain("## 分句详细步骤");
    const storyboardRequests = modelRequests.filter((request) => request.stage === "storyboards");
    expect(storyboardRequests[0]?.system).toContain("# 速查表");
    expect(storyboardRequests[0]?.system).toContain("# 情绪基调");
    expect(storyboardRequests[0]?.system).toContain("# 特效触发词库");
    expect(storyboardRequests[0]?.system).toContain("# 玄幻题材增强包");
    expect(storyboardRequests[1]?.user).toContain("本文题材：玄幻");
    expect(storyboardRequests[1]?.user).toContain("当前物理场景状态");
    expect(storyboardRequests[1]?.user).toContain("本批前边界");
    expect(storyboardRequests[1]?.user).toContain("已完成 D 列");
    expect(storyboardRequests[1]?.user).toContain(validStoryboardPrompt(1));
    expect(storyboardRequests[1]?.user).toContain("本批后边界");
    const semanticRequest = modelRequests.find((request) => request.stage === "semantic-review");
    expect(semanticRequest?.user).toContain("全表 B-D 连续上下文");

    const parsed = await readCsvFile(result.artifacts.csvPath);
    expect(parsed.columns).toEqual(["编号", "原声", "秒数", "画面提示词"]);
    expect(parsed.rows).toHaveLength(60);
    expect(parsed.rows.every((row) => row["秒数"] === "3")).toBe(true);
    await expect(readFile(result.artifacts.rosterPath, "utf8")).resolves.toContain("江青璃");
    await expect(readFile(result.artifacts.sentencesPath, "utf8")).resolves.toContain("江青璃第1次缓缓抬起右手凝视前方");

    const resumedStages: string[] = [];
    const resumedEvents: Array<{ level: JobEventLevel; message: string; detail: unknown }> = [];
    const resumed = await runOriginalInference({
      text: novel.source,
      title: "完整推理",
      genre: "玄幻",
      workDir: directory,
      runtime,
      context: context(resumedEvents),
      callModel: async (request) => {
        resumedStages.push(request.stage);
        if (request.stage !== "semantic-review") throw new Error(`断点恢复不应再次调用 ${request.stage}`);
        return modelResult(JSON.stringify({ patches: [] }));
      },
    });

    expect(resumedStages).toEqual(["semantic-review", "semantic-review"]);
    expect(resumed.storyboards).toHaveLength(60);
    expect(resumedEvents.map((event) => event.message)).toEqual(expect.arrayContaining([
      "已从断点恢复视觉蓝图",
      "已从断点恢复角色与场景资产",
      "已从断点恢复并验证分句结果",
      "已从断点恢复四列 CSV",
      "已从断点恢复通过校验的分镜批次",
    ]));
  }, 120_000);

  it("pauses with diagnostics after consecutive zero-progress storyboard responses", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-tool-original-zero-progress-"));
    temporaryDirectories.push(directory);
    const runtime = inferenceRuntimePaths(join(process.cwd(), "vendor"));
    const novel = inferenceText(10);
    const events: Array<{ level: JobEventLevel; message: string; detail: unknown }> = [];
    let storyboardCalls = 0;

    await expect(runOriginalInference({
      text: novel.source,
      title: "零进展暂停",
      genre: "玄幻",
      workDir: directory,
      runtime,
      context: context(events),
      callModel: async (request) => {
        if (request.stage === "blueprint") return modelResult(JSON.stringify({ arc: "开场氛围：肃静\n高潮区间：抬手\n收尾意境：平静" }));
        if (request.stage === "assets") return modelResult(JSON.stringify({ roster: VALID_ROSTER }));
        if (request.stage === "segmentation" || request.stage === "segmentation-repair") {
          return modelResult(JSON.stringify({ marked_text: novel.marked }));
        }
        if (request.stage === "storyboards" || request.stage === "storyboard-repair") {
          storyboardCalls += 1;
          return modelResult(JSON.stringify({ prompts: [] }));
        }
        return modelResult(JSON.stringify({ patches: [] }));
      },
    })).rejects.toBeInstanceOf(PauseJobError);

    expect(storyboardCalls).toBe(2);
    await expect(readFile(join(directory, "failure_diagnostics.txt"), "utf8")).resolves.toContain("error_category=MODEL.PATCH_CONTRACT");
    expect(events).toContainEqual(expect.objectContaining({
      level: "warning",
      message: "推理任务已暂停，工作文件和诊断报告已保留",
      detail: expect.objectContaining({
        stage: "dfill",
        errorCategory: "MODEL.PATCH_CONTRACT",
        completedIndexes: [],
      }),
    }));
  }, 120_000);

  it("restores drifted ABC, repairs a damaged roster and closes remaining full-table D errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-tool-original-closed-loop-"));
    temporaryDirectories.push(directory);
    const runtime = inferenceRuntimePaths(join(process.cwd(), "vendor"));
    const novel = inferenceText(10);
    const title = "闭环恢复";
    const events: Array<{ level: JobEventLevel; message: string; detail: unknown }> = [];
    const stages: string[] = [];
    let corrupted = false;

    const result = await runOriginalInference({
      text: novel.source,
      title,
      genre: "玄幻",
      workDir: directory,
      runtime,
      context: context(events),
      callModel: async (request) => {
        stages.push(request.stage);
        if (request.stage === "blueprint") return modelResult(JSON.stringify({ arc: "开场氛围：肃静\n高潮区间：抬手\n收尾意境：平静" }));
        if (request.stage === "assets") return modelResult(JSON.stringify({ roster: VALID_ROSTER }));
        if (request.stage === "assets-repair") return modelResult(JSON.stringify({ roster: VALID_ROSTER }));
        if (request.stage === "segmentation" || request.stage === "segmentation-repair") {
          return modelResult(JSON.stringify({ marked_text: novel.marked }));
        }
        if (request.stage === "storyboards" || request.stage === "storyboard-repair" || request.stage === "full-table-repair") {
          return promptResponse(allowedIndexes(request.user));
        }
        if (!corrupted) {
          corrupted = true;
          const csvPath = join(directory, `${title}.csv`);
          const parsed = await readCsvFile(csvPath);
          parsed.rows[0].原声 = "被篡改的原声";
          parsed.rows[0].秒数 = "99";
          parsed.rows[0].画面提示词 = "固定镜头，中景";
          await writeCsvFileAtomic(csvPath, parsed.rows, { columns: parsed.columns, bom: true });
          await writeFile(join(directory, "角色表.txt"), "\ufeff江青璃\n宗门弟子 | 女性 | 青年\n损坏的角色推理词", "utf8");
        }
        return modelResult(JSON.stringify({ patches: [] }));
      },
    });

    expect(stages).toContain("assets-repair");
    expect(stages).toContain("full-table-repair");
    expect(events).toContainEqual(expect.objectContaining({
      level: "warning",
      message: "检测到 ABC 或数据行漂移，已按生成前快照恢复并保留同编号 D 列",
    }));
    const parsed = await readCsvFile(result.artifacts.csvPath);
    expect(parsed.rows[0]).toMatchObject({
      原声: "江青璃第1次缓缓抬起右手凝视前方。",
      秒数: "3",
      画面提示词: validStoryboardPrompt(1),
    });
    await expect(readFile(result.artifacts.rosterPath, "utf8")).resolves.toContain(VALID_CHARACTER_PROMPT);
    await expect(readFile(result.artifacts.bcolSnapshotPath, "utf8")).resolves.toContain("编号,原声,秒数,画面提示词");
  }, 120_000);

  it("shrinks a failing 20-row storyboard batch back to 10 without retaining rejected prompts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-tool-original-inference-shrink-"));
    temporaryDirectories.push(directory);
    const runtime = inferenceRuntimePaths(join(process.cwd(), "vendor"));
    const novel = inferenceText(40);
    const batchSizes: number[] = [];
    let rejectedAttempts = 0;

    const events: Array<{ level: JobEventLevel; message: string; detail: unknown }> = [];
    const storyboardSystems: string[] = [];
    const result = await runOriginalInference({
      text: novel.source,
      title: "缩批推理",
      genre: "现实",
      workDir: directory,
      runtime,
      context: context(events),
      callModel: async (request) => {
        if (request.stage === "blueprint") {
          return modelResult(JSON.stringify({ arc: "开场氛围：肃静\n高潮区间：抬手\n收尾意境：平静" }));
        }
        if (request.stage === "assets") return modelResult(JSON.stringify({ roster: VALID_ROSTER }));
        if (request.stage === "segmentation" || request.stage === "segmentation-repair") {
          return modelResult(JSON.stringify({ marked_text: novel.marked }));
        }
        if (request.stage === "semantic-review") return modelResult("not-json");

        const indexes = allowedIndexes(request.user);
        storyboardSystems.push(request.system);
        batchSizes.push(indexes.length);
        if (indexes[0] === 11 && indexes.length === 20 && rejectedAttempts < 4) {
          rejectedAttempts += 1;
          return promptResponse(indexes, "@江青璃 抬起右手");
        }
        return promptResponse(indexes);
      },
    });

    expect(rejectedAttempts).toBe(4);
    expect(batchSizes).toEqual([10, 20, 20, 20, 20, 10, 20]);
    expect(result.stages.filter((stage) => stage === "storyboard-repair")).toHaveLength(3);
    expect(result.storyboards).toHaveLength(40);
    expect(result.storyboards.every((item) => item.prompt === validStoryboardPrompt(item.index + 1))).toBe(true);
    expect(storyboardSystems.every((system) => !system.includes("# 玄幻题材增强包"))).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ message: "语义审片异常，继续硬校验" }));
  }, 120_000);
});
