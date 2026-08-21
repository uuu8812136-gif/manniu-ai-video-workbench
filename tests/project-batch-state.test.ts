import { describe, expect, it } from "vitest";
import type { Storyboard, WorkflowJob, WorkflowJobEvent } from "../src/shared/contracts";
import {
  DEFAULT_PROJECT_BATCH_EDIT_SCOPE,
  activeSubjectPreparation,
  freshProjectBatchEditState,
  missingVideoStoryboards,
  parseProjectBatchItems,
  partitionVideoGenerationSelection,
  previewProjectBatchEdit,
  videoGenerationTargets,
  workflowStoryboardId,
} from "../src/renderer/src/pages/project-batch-state";

const storyboard = (id: number, videoPath: string | null = null): Storyboard => ({
  id,
  projectId: 1,
  index: id - 1,
  originalText: `scene ${id}`,
  subjects: [],
  prompt: `prompt ${id}`,
  duration: 4,
  status: "pending",
  taskId: null,
  videoTaskId: null,
  videoProvider: "custom-api",
  videoAccountId: null,
  videoSubmissionState: "idle",
  videoRecoveryState: "idle",
  videoRecoveryMessage: null,
  videoPath,
  imagePaths: [],
  submitCount: 0,
  updatedAt: new Date().toISOString(),
});

const job = (storyboardId: number, status: WorkflowJob["status"]): WorkflowJob => ({
  id: `job-${storyboardId}`,
  type: "video.generate",
  status,
  progress: 0,
  input: { storyboardId },
  output: null,
  error: null,
  attempts: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

describe("project batch state", () => {
  it("opens batch prompt editing with the original editable scope and clean fields", () => {
    expect(DEFAULT_PROJECT_BATCH_EDIT_SCOPE).toBe("editable");
    expect(freshProjectBatchEditState()).toEqual({ scope: "editable", findText: "", replaceText: "", duration: "" });
  });

  it("recovers persisted running items as waiting", () => {
    const items = parseProjectBatchItems(JSON.stringify([{ id: "a", projectId: 2, projectName: "demo", status: "running" }]));
    expect(items).toEqual([{ id: "a", projectId: 2, projectName: "demo", status: "waiting" }]);
  });

  it("ignores invalid persisted queue entries", () => {
    expect(parseProjectBatchItems('[{"id":"x","projectId":0,"projectName":"bad","status":"waiting"}]')).toEqual([]);
    expect(parseProjectBatchItems("not-json")).toEqual([]);
  });

  it("selects only missing videos without blocking jobs", () => {
    const values = [storyboard(1), storyboard(2, "video.mp4"), storyboard(3)];
    expect(missingVideoStoryboards(values, [job(3, "running")]).map((item) => item.id)).toEqual([1]);
    expect(workflowStoryboardId(job(3, "done"))).toBe(3);
  });

  it("partitions selected storyboards so existing videos require an explicit paid regeneration path", () => {
    const values = [storyboard(1), storyboard(2, "video.mp4"), storyboard(3, "  ")];
    const selection = partitionVideoGenerationSelection(values);
    expect(selection.fresh.map(({ id }) => id)).toEqual([1, 3]);
    expect(selection.existing.map(({ id }) => id)).toEqual([2]);
  });

  it("keeps the current list order when selecting fresh and existing video targets", () => {
    const values = [storyboard(7), storyboard(2, "video.mp4"), storyboard(11)];

    expect(videoGenerationTargets(values, true).map(({ id }) => id)).toEqual([7, 2, 11]);
    expect(videoGenerationTargets(values, false).map(({ id }) => id)).toEqual([7, 11]);
  });

  it("shows only the latest active PREP progress and hides it after PREP_END", () => {
    const active = job(1, "running");
    const event = (id: number, phase: "start" | "progress" | "end", current: number): WorkflowJobEvent => ({
      id,
      jobId: active.id,
      level: "info",
      message: "角色注册",
      detail: { kind: "subject-prep", phase, storyboardId: 1, current, total: 2, name: "小李" },
      createdAt: new Date().toISOString(),
    });
    expect(activeSubjectPreparation([active], { [active.id]: [event(1, "start", 0), event(2, "progress", 1)] }))
      .toMatchObject({ storyboardId: 1, current: 1, total: 2, name: "小李", percent: 50 });
    expect(activeSubjectPreparation([active], { [active.id]: [event(1, "progress", 1), event(2, "end", 2)] })).toBeNull();
    expect(activeSubjectPreparation([{ ...active, status: "done" }], { [active.id]: [event(1, "progress", 1)] })).toBeNull();
  });

  it("previews batch edit scope, text hits, and active-generation skips", () => {
    const values = [storyboard(1), storyboard(2), { ...storyboard(3), status: "error" as const }];
    values[0].prompt = "red city";
    values[1].prompt = "blue city";
    values[2].prompt = "red forest";
    const preview = previewProjectBatchEdit(values, [job(3, "running")], new Set([1, 3]), "selected", "red", false);

    expect(preview.candidates.map(({ id }) => id)).toEqual([1, 3]);
    expect(preview.targets.map(({ id }) => id)).toEqual([1]);
    expect(preview.skippedActive.map(({ id }) => id)).toEqual([3]);
    expect(previewProjectBatchEdit(values, [], new Set(), "pending", "", true).targets).toHaveLength(3);
  });
});
