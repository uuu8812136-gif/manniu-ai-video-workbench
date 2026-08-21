import { describe, expect, it } from "vitest";
import type { Project, Storyboard, WorkflowJob } from "../src/shared/contracts";
import {
  STORYBOARD_CSV_COLUMNS,
  activeMediaJobsForStoryboards,
  buildJianyingExportInput,
  buildSrtDrivenJianyingExportPlan,
  latestImagePath,
  matchStoryboardsToSrt,
  safeExportName,
  storyboardCsvRecords,
  storyboardPlainText,
  storyboardReplacementConfirmation,
  storyboardRowsFromCsv,
} from "../src/renderer/src/lib/project-files";

const project: Project = {
  id: 1,
  name: "中文 项目",
  folderPath: "",
  csvPath: "",
  rosterPath: "",
  subtitlePath: "",
  audioPath: "D:\\素材\\旁白.wav",
  createdAt: "2026-07-26T00:00:00.000Z",
  updatedAt: "2026-07-26T00:00:00.000Z",
};

const storyboards: Storyboard[] = [
  {
    id: 10,
    projectId: 1,
    index: 0,
    originalText: "第一幕",
    subjects: ["主角", "朋友"],
    prompt: "雨夜街道",
    duration: 4,
    status: "done",
    taskId: null,
    videoTaskId: null,
    videoProvider: "custom-api",
    videoAccountId: null,
    videoSubmissionState: "idle",
    videoRecoveryState: "idle",
    videoRecoveryMessage: null,
    videoPath: null,
    imagePaths: ["D:\\素材\\画面一.png"],
    submitCount: 0,
    updatedAt: "2026-07-26T00:00:00.000Z",
  },
  {
    id: 11,
    projectId: 1,
    index: 1,
    originalText: "第二幕",
    subjects: ["主角"],
    prompt: "室内对话",
    duration: 6,
    status: "pending",
    taskId: null,
    videoTaskId: null,
    videoProvider: "custom-api",
    videoAccountId: null,
    videoSubmissionState: "idle",
    videoRecoveryState: "idle",
    videoRecoveryMessage: null,
    videoPath: "D:\\素材\\镜头二.mp4",
    imagePaths: [],
    submitCount: 0,
    updatedAt: "2026-07-26T00:00:00.000Z",
  },
];

describe("project file UI transformations", () => {
  it("round-trips structured storyboard CSV fields and media paths", () => {
    const records = storyboardCsvRecords(storyboards);
    const parsed = storyboardRowsFromCsv({ columns: [...STORYBOARD_CSV_COLUMNS], rows: records });
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      draft: { originalText: "第一幕", subjects: ["主角", "朋友"], prompt: "雨夜街道", duration: 4 },
      mediaPath: "D:\\素材\\画面一.png",
      mediaKind: "photo",
    });
    expect(parsed[1]).toMatchObject({ mediaKind: "video", mediaPath: "D:\\素材\\镜头二.mp4" });
  });

  it("accepts common external CSV column aliases", () => {
    const parsed = storyboardRowsFromCsv({
      columns: ["text", "image_prompt", "duration_seconds", "角色"],
      rows: [{ text: "开场", image_prompt: "远景", duration_seconds: "3", 角色: "甲，乙" }],
    });
    expect(parsed[0].draft).toEqual({
      index: 0,
      originalText: "开场",
      prompt: "远景",
      subjects: ["甲", "乙"],
      duration: 3,
    });
  });

  it("recovers asset subjects from at-names in a four-column CSV prompt", () => {
    const parsed = storyboardRowsFromCsv({
      columns: ["编号", "原声", "秒数", "画面提示词"],
      rows: [{ 编号: "1", 原声: "众人走进林地", 秒数: "7", 画面提示词: "@万浩 与 @斜月 进入 @落叶林地，@万浩 回头" }],
    });

    expect(parsed[0].draft.originalText).toBe("众人走进林地");
    expect(parsed[0].draft.duration).toBe(7);
    expect(parsed[0].draft.subjects).toEqual(["万浩", "斜月", "落叶林地"]);
  });

  it("preserves original one-based CSV indexes and allocates duplicates or invalid values", () => {
    const parsed = storyboardRowsFromCsv({
      columns: ["序号", "原文", "时长", "画面提示词"],
      rows: [
        { 序号: "3", 原文: "第三镜", 时长: "4", 画面提示词: "画面三" },
        { 序号: "3", 原文: "重复编号", 时长: "4", 画面提示词: "自动编号" },
        { 序号: "0", 原文: "非法编号", 时长: "4", 画面提示词: "自动编号" },
        { 序号: "5", 原文: "再次重复", 时长: "4", 画面提示词: "自动编号" },
        { 序号: "2", 原文: "保留跳号", 时长: "4", 画面提示词: "画面二" },
      ],
    });

    expect(parsed.map((row) => row.draft.index)).toEqual([2, 3, 4, 5, 1]);
  });

  it("normalizes CSV duration with the original 1 to 60 second floor rule", () => {
    const parsed = storyboardRowsFromCsv({
      columns: ["序号", "原文", "时长", "画面提示词"],
      rows: [
        { 序号: "1", 原文: "小数", 时长: "3.9", 画面提示词: "画面一" },
        { 序号: "2", 原文: "超长", 时长: "61", 画面提示词: "画面二" },
        { 序号: "3", 原文: "非法", 时长: "0", 画面提示词: "画面三" },
      ],
    });

    expect(parsed.map((row) => row.draft.duration)).toEqual([3, 60, 2]);
  });

  it("derives missing CSV durations from the original formula instead of defaulting to four", () => {
    const parsed = storyboardRowsFromCsv({
      columns: ["编号", "原声", "画面提示词"],
      rows: [
        { 编号: "1", 原声: "一二三四五六", 画面提示词: "近景" },
        { 编号: "2", 原声: "一二三四五六七八九十十一十二十三十四十五十六十七十八十九二十廿一廿二廿三廿四廿五廿六廿七", 画面提示词: "远景" },
      ],
    });

    expect(parsed.map((row) => row.draft.duration)).toEqual([2, 5]);
  });

  it("builds a continuous Jianying timeline from persisted media", () => {
    const input = buildJianyingExportInput(project, storyboards, "D:\\剪映草稿");
    expect(input).toMatchObject({ timelineDurationUs: 10_000_000, preserveVisualSpeed: true });
    expect(input.visualClips).toEqual([
      { filePath: "D:\\素材\\画面一.png", durationUs: 4_000_000, startUs: 0, kind: "photo" },
      { filePath: "D:\\素材\\镜头二.mp4", durationUs: 6_000_000, startUs: 4_000_000, kind: "video" },
    ]);
    expect(input.audioClips).toEqual([{ filePath: "D:\\素材\\旁白.wav", durationUs: 10_000_000, startUs: 0 }]);
    expect(input.subtitles).toBeUndefined();
  });

  it("preserves sparse numbering in CSV while keeping the Jianying timeline continuous", () => {
    const sparse = [storyboards[0], { ...storyboards[1], index: 4 }];

    expect(storyboardCsvRecords(sparse).map((row) => row.序号)).toEqual(["1", "5"]);
    expect(buildJianyingExportInput(project, sparse, "D:\\剪映草稿").visualClips).toEqual([
      { filePath: "D:\\素材\\画面一.png", durationUs: 4_000_000, startUs: 0, kind: "photo" },
      { filePath: "D:\\素材\\镜头二.mp4", durationUs: 6_000_000, startUs: 4_000_000, kind: "video" },
    ]);
  });

  it("uses the newest generated image consistently for CSV and Jianying exports", () => {
    const versions: Storyboard[] = [{
      ...storyboards[0],
      imagePaths: ["D:\\素材\\旧画面.png", "D:\\素材\\最新画面.png"],
    }];
    expect(latestImagePath(versions[0])).toBe("D:\\素材\\最新画面.png");
    expect(storyboardCsvRecords(versions)[0].素材路径).toBe("D:\\素材\\最新画面.png");
    expect(buildJianyingExportInput(project, versions, "D:\\剪映草稿").visualClips?.[0].filePath)
      .toBe("D:\\素材\\最新画面.png");
  });

  it("keeps image-only Jianying export available when videoPath is an empty string", () => {
    const imageOnly: Storyboard[] = [{
      ...storyboards[0],
      videoPath: "",
      imagePaths: ["D:\\素材\\图片分镜.png"],
    }];
    expect(buildJianyingExportInput(project, imageOnly, "D:\\剪映草稿").visualClips).toEqual([
      { filePath: "D:\\素材\\图片分镜.png", durationUs: 4_000_000, startUs: 0, kind: "photo" },
    ]);
  });

  it("builds explicit black placeholders when every storyboard has no visual", () => {
    const emptyVisuals = storyboards.map((item) => ({ ...item, videoPath: null, imagePaths: [] }));
    const input = buildJianyingExportInput(project, emptyVisuals, "D:\\剪映草稿");

    expect(input.visualClips).toEqual([]);
    expect(input.blackClips).toEqual([
      { durationUs: 4_000_000, startUs: 0 },
      { durationUs: 6_000_000, startUs: 4_000_000 },
    ]);
  });

  it("matches normalized SRT text and drives Jianying timing and video speed", () => {
    const cues = [
      { text: "第一幕！", startUs: 500_000, endUs: 4_500_000 },
      { text: "第二幕。", startUs: 4_500_000, endUs: 10_500_000 },
    ];
    const match = matchStoryboardsToSrt(storyboards, cues);
    expect(match.matchRate).toBe(1);
    expect(match.unmatchedStoryboardIndexes).toEqual([]);

    const plan = buildSrtDrivenJianyingExportPlan(project, storyboards, "D:\\剪映草稿", cues);
    expect(plan.input).toMatchObject({ timelineDurationUs: 10_500_000 });
    expect(plan.input.preserveVisualSpeed).toBeUndefined();
    expect(plan.input.visualClips).toEqual([
      { filePath: "D:\\素材\\画面一.png", durationUs: 4_000_000, sourceDurationUs: 4_000_000, startUs: 500_000, kind: "photo" },
      { filePath: "D:\\素材\\镜头二.mp4", durationUs: 6_000_000, sourceDurationUs: 6_000_000, startUs: 4_500_000, kind: "video" },
    ]);
    expect(plan.input.subtitles).toEqual(cues);
    expect(plan.input.audioClips).toEqual([{ filePath: "D:\\素材\\旁白.wav", durationUs: 10_500_000, startUs: 0 }]);
  });

  it("keeps SRT-driven visual clips sequential when an unmatched leading storyboard crosses a matched cue", () => {
    const leadingUnmatched: Storyboard[] = [
      { ...storyboards[0], index: 0, originalText: "", duration: 4 },
      { ...storyboards[1], index: 1, originalText: "第二幕", duration: 6 },
    ];
    const plan = buildSrtDrivenJianyingExportPlan(project, leadingUnmatched, "D:\\剪映草稿", [
      { text: "第二幕", startUs: 2_000_000, endUs: 8_000_000 },
    ]);
    const clips = [...(plan.input.visualClips ?? []), ...(plan.input.blackClips ?? [])]
      .sort((left, right) => (left.startUs ?? 0) - (right.startUs ?? 0));

    expect(clips).toMatchObject([
      { startUs: 0, durationUs: 4_000_000 },
      { startUs: 4_000_000, durationUs: 4_000_000 },
    ]);
    for (let index = 1; index < clips.length; index += 1) {
      expect(clips[index].startUs).toBeGreaterThanOrEqual((clips[index - 1].startUs ?? 0) + clips[index - 1].durationUs);
    }
  });

  it("rejects the wrong subtitle file instead of exporting a misaligned draft", () => {
    expect(() => buildSrtDrivenJianyingExportPlan(project, storyboards, "D:\\剪映草稿", [
      { text: "完全无关的字幕内容", startUs: 0, endUs: 2_000_000 },
    ])).toThrow(/匹配度/);
  });

  it("aligns long near-identical text without allocating a quadratic matrix", () => {
    const repeated = "这是长篇字幕测试内容".repeat(2_000);
    const largeStoryboard = [{ ...storyboards[0], originalText: repeated }];
    const match = matchStoryboardsToSrt(largeStoryboard, [{ text: `${repeated.slice(0, 10_000)}插入${repeated.slice(10_000)}`, startUs: 0, endUs: 60_000_000 }]);
    expect(match.matchRate).toBeGreaterThan(0.99);
    expect(match.timings).toHaveLength(1);
  });

  it("finds only active image and video jobs linked to affected storyboards", () => {
    const job = (id: string, type: WorkflowJob["type"], status: WorkflowJob["status"], storyboardId: number): WorkflowJob => ({
      id,
      type,
      status,
      progress: 0,
      input: { storyboardId },
      output: null,
      error: null,
      attempts: 0,
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z",
    });
    const jobs = [
      job("queued-image", "image.generate", "queued", 10),
      job("paused-video", "video.generate", "paused", 11),
      job("done-image", "image.generate", "done", 10),
      job("other-storyboard", "video.generate", "running", 99),
      job("text-job", "text.polish", "running", 10),
    ];
    expect(activeMediaJobsForStoryboards(jobs, [10, 11]).map((item) => item.id))
      .toEqual(["queued-image", "paused-video"]);
  });

  it("requires confirmation only when replacement would overwrite existing storyboards", () => {
    expect(storyboardReplacementConfirmation(0, 3, "文本")).toBeNull();
    expect(storyboardReplacementConfirmation(2, 3, "文本")).toBe("用文本生成的 3 个分镜替换当前 2 个分镜？");
    expect(storyboardReplacementConfirmation(2, 4, "CSV")).toBe("用CSV生成的 4 个分镜替换当前 2 个分镜？");
  });

  it("exports readable text and safe default names", () => {
    expect(storyboardPlainText(storyboards)).toBe("第一幕\r\n\r\n第二幕");
    expect(safeExportName("A/B:项目", "csv")).toBe("A_B_项目.csv");
    expect(safeExportName("CON", "txt")).toBe("_CON.txt");
  });
});
