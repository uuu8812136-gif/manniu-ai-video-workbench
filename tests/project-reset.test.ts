import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../src/main/database";
import { JobStore } from "../src/main/jobs";
import { resetProjectGeneration } from "../src/main/project-reset";
import { ProjectRepository, StoryboardRepository } from "../src/main/repositories";

describe("project generation reset", () => {
  let root: string;
  let database: AppDatabase;
  let projects: ProjectRepository;
  let storyboards: StoryboardRepository;
  let jobs: JobStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ai-tool-reset-"));
    database = new AppDatabase(":memory:");
    projects = new ProjectRepository(database.connection);
    storyboards = new StoryboardRepository(database.connection);
    jobs = new JobStore(database.connection);
  });

  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  it("clears storyboard state and history without deleting any bound media files", async () => {
    const projectDirectory = join(root, "project");
    const outsideDirectory = join(root, "outside");
    await Promise.all([mkdir(projectDirectory), mkdir(outsideDirectory)]);
    const insideVideo = join(projectDirectory, "video.mp4");
    const insideImage = join(projectDirectory, "image.png");
    const outsideImage = join(outsideDirectory, "keep.png");
    await Promise.all([
      writeFile(insideVideo, "video"),
      writeFile(insideImage, "image"),
      writeFile(outsideImage, "outside"),
    ]);

    const project = projects.create({ name: "重置项目", folderPath: projectDirectory });
    const [storyboard] = storyboards.replace(project.id, [{ index: 0, originalText: "第一镜", prompt: "画面" }]);
    storyboards.update(storyboard.id, {
      status: "done",
      videoPath: insideVideo,
      imagePaths: [insideImage, outsideImage],
    });
    database.connection.prepare("UPDATE storyboards SET task_id = ?, submit_count = 4 WHERE id = ?").run("old-task", storyboard.id);

    const done = jobs.enqueue("video.generate", { storyboardId: storyboard.id });
    jobs.claimNext();
    jobs.complete(done.id, { ok: true });
    const failed = jobs.enqueue("image.generate", { storyboardId: storyboard.id });
    jobs.claimNext();
    jobs.fail(failed.id, new Error("failed"));
    const cancelled = jobs.enqueue("video.generate", { storyboardId: storyboard.id });
    jobs.cancel(cancelled.id);
    const unrelated = jobs.enqueue("text.polish", { text: "保留" });

    const result = resetProjectGeneration({
      storyboards: storyboards.list(project.id),
      storyboardRepository: storyboards,
      jobStore: jobs,
    });

    expect(result).toEqual({
      storyboardsReset: 1,
      jobsRemoved: 3,
    });
    expect(existsSync(insideVideo)).toBe(true);
    expect(existsSync(insideImage)).toBe(true);
    expect(existsSync(outsideImage)).toBe(true);
    expect(storyboards.get(storyboard.id)).toMatchObject({
      status: "pending",
      taskId: null,
      videoTaskId: null,
      videoAccountId: null,
      videoSubmissionState: "idle",
      videoPath: null,
      imagePaths: [],
      submitCount: 0,
    });
    expect(jobs.get(done.id)).toBeNull();
    expect(jobs.get(failed.id)).toBeNull();
    expect(jobs.get(cancelled.id)).toBeNull();
    expect(jobs.get(unrelated.id)).not.toBeNull();
  });

  it("rejects active local jobs before changing files or storyboard state", async () => {
    const projectDirectory = join(root, "active-project");
    await mkdir(projectDirectory);
    const imagePath = join(projectDirectory, "keep.png");
    await writeFile(imagePath, "image");
    const project = projects.create({ name: "运行中项目", folderPath: projectDirectory });
    const [storyboard] = storyboards.replace(project.id, [{ index: 0, originalText: "第一镜", prompt: "画面" }]);
    storyboards.update(storyboard.id, { status: "done", imagePaths: [imagePath] });
    jobs.enqueue("image.generate", { storyboardId: storyboard.id });

    expect(() => resetProjectGeneration({
      storyboards: storyboards.list(project.id),
      storyboardRepository: storyboards,
      jobStore: jobs,
    })).toThrow(/Cannot reset project.*queued/);
    expect(existsSync(imagePath)).toBe(true);
    expect(storyboards.get(storyboard.id)).toMatchObject({ status: "done", imagePaths: [imagePath] });
  });

  it("clears uncertain abnormal submissions so the project can start over", () => {
    const project = projects.create({ name: "异常重置项目" });
    const storyboard = storyboards.replace(project.id, [
      { index: 0, originalText: "异常镜头", prompt: "重新生成" },
    ])[0];
    storyboards.markVideoSubmissionUncertain(storyboard.id, "vidu-browser", null);

    expect(resetProjectGeneration({
      storyboards: storyboards.list(project.id),
      storyboardRepository: storyboards,
      jobStore: jobs,
    })).toEqual({ storyboardsReset: 1, jobsRemoved: 0 });
    expect(storyboards.get(storyboard.id)).toMatchObject({
      status: "pending",
      videoSubmissionState: "idle",
      videoTaskId: null,
      videoAccountId: null,
    });
  });

  it("rejects persisted Vidu work before changing files or storyboard state", async () => {
    const projectDirectory = join(root, "remote-project");
    await mkdir(projectDirectory);
    const videoPath = join(projectDirectory, "keep.mp4");
    await writeFile(videoPath, "video");
    const project = projects.create({ name: "远端任务项目", folderPath: projectDirectory });
    const [storyboard] = storyboards.replace(project.id, [{ index: 0, originalText: "第一镜", prompt: "画面" }]);
    storyboards.update(storyboard.id, { status: "generating", videoPath });
    storyboards.saveVideoProviderTask(storyboard.id, "remote-task", "vidu-browser", null);

    expect(() => resetProjectGeneration({
      storyboards: storyboards.list(project.id),
      storyboardRepository: storyboards,
      jobStore: jobs,
    })).toThrow(/persisted video task remote-task/);
    expect(existsSync(videoPath)).toBe(true);
    expect(storyboards.get(storyboard.id)).toMatchObject({ videoTaskId: "remote-task", videoPath });
  });
});
