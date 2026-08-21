import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../src/main/database";
import { ProjectRepository, StoryboardRepository } from "../src/main/repositories";

describe("single storyboard mutations", () => {
  let database: AppDatabase;
  let projects: ProjectRepository;
  let storyboards: StoryboardRepository;

  beforeEach(() => {
    database = new AppDatabase(":memory:");
    projects = new ProjectRepository(database.connection);
    storyboards = new StoryboardRepository(database.connection);
  });

  afterEach(() => database.close());

  it("preserves sibling media and task state when appending and deleting", () => {
    const project = projects.create({ name: "保留素材" });
    const [first, second] = storyboards.replace(project.id, [
      { index: 0, originalText: "第一镜", prompt: "画面一" },
      { index: 1, originalText: "第二镜", prompt: "画面二" },
    ]);
    storyboards.update(second.id, {
      status: "done",
      imagePaths: ["D:\\项目\\图片一.png"],
      videoPath: "D:\\项目\\视频一.mp4",
    });

    const appended = storyboards.create(project.id, { index: 2, originalText: "第三镜", prompt: "画面三" });
    expect(appended.index).toBe(2);
    storyboards.delete(first.id);

    expect(storyboards.list(project.id)).toMatchObject([
      { id: second.id, index: 0, status: "done", imagePaths: ["D:\\项目\\图片一.png"], videoPath: "D:\\项目\\视频一.mp4" },
      { id: appended.id, index: 1, status: "pending" },
    ]);
  });

  it.each([
    { state: "submitting", taskId: null },
    { state: "submitted", taskId: null },
    { state: "idle", taskId: "remote-task-id" },
  ] as const)(
    "rejects project deletion, storyboard replacement and storyboard deletion for $state persisted video work",
    ({ state, taskId }) => {
      const project = projects.create({ name: `受保护-${state}` });
      const [storyboard] = storyboards.replace(project.id, [
        { index: 0, originalText: "远端视频任务", prompt: "保留任务" },
      ]);
      database.connection
        .prepare(
          `UPDATE storyboards
           SET video_task_id = ?, video_submission_state = ?
           WHERE id = ?`,
        )
        .run(taskId, state, storyboard.id);

      expect(() => projects.delete(project.id)).toThrow(/Cannot delete project.*persisted video/);
      expect(() => storyboards.replace(project.id, [])).toThrow(/Cannot replace storyboards.*persisted video/);
      expect(() => storyboards.delete(storyboard.id)).toThrow(/Cannot delete storyboard.*persisted video/);
      expect(projects.get(project.id).id).toBe(project.id);
      expect(storyboards.get(storyboard.id)).toMatchObject({
        videoTaskId: taskId,
        videoSubmissionState: state,
      });
    },
  );

  it("allows deleting a project whose only persisted video state is uncertain", () => {
    const project = projects.create({ name: "异常项目" });
    const [storyboard] = storyboards.replace(project.id, [
      { index: 0, originalText: "提交结果异常", prompt: "待人工核对" },
    ]);
    storyboards.markVideoSubmissionUncertain(storyboard.id, "vidu-browser", null);

    projects.delete(project.id);

    expect(projects.list()).toEqual([]);
    expect(storyboards.list(project.id)).toEqual([]);
  });

  it("allows deletion only after an uncertain submission is explicitly cleared", () => {
    const project = projects.create({ name: "待确认删除" });
    const [storyboard] = storyboards.replace(project.id, [
      { index: 0, originalText: "提交中断", prompt: "核对网站任务历史" },
    ]);
    storyboards.markVideoSubmissionUncertain(storyboard.id, "vidu-browser", null);

    expect(() => storyboards.delete(storyboard.id)).toThrow(/persisted video/);
    expect(storyboards.resolveUncertainVideoSubmission(storyboard.id, { clear: true })).toMatchObject({
      videoTaskId: null,
      videoSubmissionState: "idle",
    });

    storyboards.delete(storyboard.id);
    expect(storyboards.list(project.id)).toEqual([]);
  });
});
