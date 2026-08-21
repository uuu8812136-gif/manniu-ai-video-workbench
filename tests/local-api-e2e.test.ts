import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../src/main/database";
import { JobStore, PersistentJobQueue } from "../src/main/jobs";
import { ProjectRepository, SettingsRepository, StoryboardRepository } from "../src/main/repositories";
import { registerVideoWorkflowHandler } from "../src/main/video-workflow";
import { registerWorkflowHandlers } from "../src/main/workflow-handlers";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom", "ascii"), Buffer.alloc(2_036, 3)]);

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

describe("local model API end-to-end", () => {
  let root: string;
  let database: AppDatabase;
  let queue: PersistentJobQueue;
  let closeServer: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ai-tool-e2e-中文-"));
    database = new AppDatabase(join(root, "工作区", "ai-tool.db"));
  });

  afterEach(async () => {
    await queue?.shutdown();
    database.close();
    await closeServer?.();
    await rm(root, { recursive: true, force: true });
  });

  it("runs storyboard, image, and async video workflows through real localhost HTTP", async () => {
    const requests: string[] = [];
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.url === "/v1/chat/completions") {
        json(response, {
          id: "chat-local",
          model: "local-storyboard",
          choices: [{ message: { role: "assistant", content: JSON.stringify({
            characters: [{
              name: "女孩",
              gender_age: "年轻女性",
              appearance: "清秀面容，身形纤细",
              hair: "黑色齐肩发",
              clothing: "浅色风衣",
              personality: "安静谨慎",
              visual_prompt: "年轻女性，清秀面容，身形纤细，黑色齐肩发，浅色风衣，安静谨慎",
            }],
            storyboards: [
              { original_text: "雨夜列车进站", subjects: ["女孩"], prompt: "雨夜车站，列车进站", duration: 4 },
            ],
          }) } }],
        });
      } else if (request.url === "/v1/images/generations") {
        json(response, { data: [{ b64_json: PNG }] });
      } else if (request.url === "/v1/videos/generations") {
        json(response, { task_id: "local-video-task" });
      } else if (request.url === "/v1/videos/local-video-task") {
        json(response, { status: "completed", progress: 100, video_url: `${baseUrl}/files/result.mp4` });
      } else if (request.url === "/files/result.mp4") {
        response.writeHead(200, { "content-type": "video/mp4", "content-length": String(MP4.length) });
        response.end(MP4);
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Local test server did not bind TCP");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    closeServer = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

    const projects = new ProjectRepository(database.connection);
    const storyboards = new StoryboardRepository(database.connection);
    const settings = new SettingsRepository(database.connection);
    settings.set("infer_api_base_url", `${baseUrl}/v1`);
    settings.set("infer_model", "local-storyboard");
    settings.set("infer_protocol", "chat");
    settings.set("imagegen_api_base_url", `${baseUrl}/v1`);
    settings.set("imagegen_model", "local-image");
    settings.set("video_api_base_url", `${baseUrl}/v1`);
    settings.set("video_model", "local-video");
    settings.set("video_poll_interval_ms", "250");
    settings.set("video_timeout_ms", "5000");

    queue = new PersistentJobQueue(new JobStore(database.connection), 4);
    registerWorkflowHandlers(queue, settings, storyboards, {
      projects,
      projectsRoot: join(root, "项目 根目录"),
      allowLegacyInferenceFastPath: true,
    });
    registerVideoWorkflowHandler(queue, { settings, storyboards, projects, projectsRoot: join(root, "项目 根目录") });
    queue.start();

    const project = projects.create({ name: "真实本地接口", folderPath: join(root, "中文 项目") });
    const inference = queue.enqueue("storyboard.infer", { text: "一段雨夜故事", projectId: project.id });
    await queue.waitForIdle();
    expect(queue.store.require(inference.id).status).toBe("done");
    const [storyboard] = storyboards.list(project.id);

    const image = queue.enqueue("image.generate", { storyboardId: storyboard.id });
    await queue.waitForIdle();
    expect(queue.store.require(image.id).status).toBe("done");
    expect(existsSync(storyboards.get(storyboard.id).imagePaths[0])).toBe(true);

    const video = queue.enqueue("video.generate", { storyboardId: storyboard.id });
    await queue.waitForIdle(5_000);
    expect(queue.store.require(video.id).status).toBe("done");
    expect(existsSync(storyboards.get(storyboard.id).videoPath!)).toBe(true);
    expect(requests).toEqual(expect.arrayContaining([
      "POST /v1/chat/completions",
      "POST /v1/images/generations",
      "POST /v1/videos/generations",
      "GET /v1/videos/local-video-task",
      "GET /files/result.mp4",
    ]));
  });
});
