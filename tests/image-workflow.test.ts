import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppDatabase } from "../src/main/database";
import { createImageGenerationHandler } from "../src/main/image-workflow";
import { JobStore, PersistentJobQueue } from "../src/main/jobs";
import {
  CharacterProfileRepository,
  ProjectRepository,
  SettingsRepository,
  StoryboardRepository,
} from "../src/main/repositories";
import { registerWorkflowHandlers } from "../src/main/workflow-handlers";

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const electronMock = vi.hoisted(() => ({
  createFromBuffer: vi.fn(),
}));

vi.mock("electron", () => ({
  nativeImage: { createFromBuffer: electronMock.createFromBuffer },
}));

function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function mockDecodedImage(input: {
  width: number;
  height: number;
  sourcePng: Buffer;
  resizedPng?: Buffer;
}) {
  const sourceToPNG = vi.fn(() => input.sourcePng);
  const resizedToPNG = vi.fn(() => input.resizedPng ?? input.sourcePng);
  const resizedImage = {
    isEmpty: () => false,
    getSize: () => ({ width: Math.min(input.width, 1024), height: Math.min(input.height, 1024) }),
    resize: vi.fn(),
    toPNG: resizedToPNG,
  };
  const resize = vi.fn(() => resizedImage);
  electronMock.createFromBuffer.mockReturnValue({
    isEmpty: () => false,
    getSize: () => ({ width: input.width, height: input.height }),
    resize,
    toPNG: sourceToPNG,
  });
  return { resize, sourceToPNG, resizedToPNG };
}

describe("image generation workflow", () => {
  let root: string;
  let database: AppDatabase;
  let queue: PersistentJobQueue;
  let projects: ProjectRepository;
  let characterProfiles: CharacterProfileRepository;
  let storyboards: StoryboardRepository;
  let settings: SettingsRepository;

  beforeEach(async () => {
    electronMock.createFromBuffer.mockReset();
    root = await mkdtemp(join(tmpdir(), "ai-tool-image-中文-"));
    database = new AppDatabase(":memory:");
    projects = new ProjectRepository(database.connection);
    characterProfiles = new CharacterProfileRepository(database.connection);
    storyboards = new StoryboardRepository(database.connection);
    settings = new SettingsRepository(database.connection);
    settings.set("imagegen_provider", "openai");
    settings.set("imagegen_api_base_url", "http://127.0.0.1:8080/v1");
    settings.set("imagegen_model", "image-model");
    settings.set("imagegen_api_key", "local-key");
    queue = new PersistentJobQueue(new JobStore(database.connection), 2);
    registerWorkflowHandlers(queue, settings, storyboards, { projects, projectsRoot: root });
    queue.start();
  });

  afterEach(async () => {
    await queue.shutdown();
    database.close();
    await rm(root, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("generates, atomically persists, and attaches an image without Python", async () => {
    const project = projects.create({ name: "本地 生图项目" });
    const [storyboard] = storyboards.replace(project.id, [
      { index: 0, originalText: "列车进站", prompt: "夜色中的列车驶入站台", duration: 4 },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const job = queue.enqueue("image.generate", { storyboardId: storyboard.id });
    await queue.waitForIdle();

    const completed = queue.store.require(job.id);
    expect(completed.status).toBe("done");
    const updated = storyboards.get(storyboard.id);
    expect(updated).toMatchObject({ status: "done", taskId: job.id, submitCount: 1 });
    expect(updated.imagePaths).toHaveLength(1);
    expect(existsSync(updated.imagePaths[0])).toBe(true);
    expect(updated.imagePaths[0]).toContain(join(`project-${project.id}`, "images"));
  });

  it("rejects gpt-image models configured with the Gemini protocol before calling the API", async () => {
    settings.set("imagegen_provider", "gemini");
    settings.set("imagegen_model", "gpt-image-2");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const project = projects.create({ name: "协议检查" });
    const [storyboard] = storyboards.replace(project.id, [
      { index: 0, originalText: "角色", prompt: "角色设定图", duration: 4 },
    ]);

    const job = queue.enqueue("image.generate", { storyboardId: storyboard.id });
    await queue.waitForIdle();

    expect(queue.store.require(job.id)).toMatchObject({
      status: "error",
      error: "模型 gpt-image-2 需选择 OpenAI Images 协议",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requests and atomically attaches multiple images for one prompt", async () => {
    const project = projects.create({ name: "多图项目" });
    const [storyboard] = storyboards.replace(project.id, [
      { index: 0, originalText: "角色", prompt: "同一角色的多张设定图", duration: 4 },
    ]);
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { n?: number };
      return new Response(JSON.stringify({ data: Array.from({ length: body.n ?? 1 }, () => ({ b64_json: ONE_PIXEL_PNG })) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetcher);

    const job = queue.enqueue("image.generate", { storyboardId: storyboard.id, count: 3, model: "gpt-image-2", size: "1024x1024" });
    await queue.waitForIdle();

    expect(queue.store.require(job.id).status).toBe("done");
    expect(storyboards.get(storyboard.id).imagePaths).toHaveLength(3);
    const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(request).toMatchObject({
      n: 3,
      model: "gpt-image-2",
      size: "1024x1024",
      quality: "high",
      response_format: "url",
    });
  });

  it("passes reference images to the original OpenAI-compatible image contract", async () => {
    const normalized = Buffer.from(ONE_PIXEL_PNG, "base64");
    const image = mockDecodedImage({ width: 1, height: 1, sourcePng: normalized });
    const referencePath = join(root, "reference.png");
    await writeFile(referencePath, normalized);
    const project = projects.create({ name: "参考图项目" });
    const [storyboard] = storyboards.replace(project.id, [
      { index: 0, originalText: "角色", prompt: "保持角色一致", duration: 4 },
    ]);
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(
      JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetcher);

    const job = queue.enqueue("image.generate", {
      storyboardId: storyboard.id,
      model: "gpt-image-2",
      referenceImagePaths: [referencePath],
    });
    await queue.waitForIdle();

    expect(queue.store.require(job.id).status).toBe("done");
    const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(request.reference_images).toEqual([ONE_PIXEL_PNG]);
    expect(electronMock.createFromBuffer).toHaveBeenCalledWith(normalized);
    expect(image.resize).not.toHaveBeenCalled();
    expect(image.sourceToPNG).toHaveBeenCalledOnce();
  });

  it("downscales a reference image to a 1024px longest edge and sends PNG base64", async () => {
    const jpeg = Buffer.from("ffd8ffe000104a4649460001ffd9", "hex");
    const normalized = pngHeader(1024, 512);
    const image = mockDecodedImage({
      width: 2048,
      height: 1024,
      sourcePng: pngHeader(2048, 1024),
      resizedPng: normalized,
    });
    const referencePath = join(root, "wide-reference.jpg");
    await writeFile(referencePath, jpeg);
    const project = projects.create({ name: "参考图缩放" });
    const [storyboard] = storyboards.replace(project.id, [
      { index: 0, originalText: "宽镜头", prompt: "保持画面一致", duration: 4 },
    ]);
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
      JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetcher);

    const job = queue.enqueue("image.generate", {
      storyboardId: storyboard.id,
      referenceImagePaths: [referencePath],
    });
    await queue.waitForIdle();

    expect(queue.store.require(job.id).status).toBe("done");
    expect(electronMock.createFromBuffer).toHaveBeenCalledWith(jpeg);
    expect(image.resize).toHaveBeenCalledWith({ width: 1024, height: 512, quality: "best" });
    expect(image.sourceToPNG).not.toHaveBeenCalled();
    expect(image.resizedToPNG).toHaveBeenCalledOnce();
    const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as {
      reference_images: string[];
      quality: string;
    };
    const sent = Buffer.from(request.reference_images[0], "base64");
    expect(sent.subarray(0, 8)).toEqual(Buffer.from("89504e470d0a1a0a", "hex"));
    expect(sent.readUInt32BE(16)).toBe(1024);
    expect(sent.readUInt32BE(20)).toBe(512);
    expect(request.quality).toBe("high");
  });

  it("keeps an explicitly selected OpenAI image quality", async () => {
    const project = projects.create({ name: "生图质量" });
    const [storyboard] = storyboards.replace(project.id, [
      { index: 0, originalText: "画面", prompt: "标准质量", duration: 4 },
    ]);
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
      JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetcher);

    const job = queue.enqueue("image.generate", { storyboardId: storyboard.id, quality: "standard" });
    await queue.waitForIdle();

    expect(queue.store.require(job.id).status).toBe("done");
    const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as { quality: string };
    expect(request.quality).toBe("standard");
  });

  it("uses the configured image output directory while keeping storyboard media linked", async () => {
    const outputRoot = join(root, "统一生图输出");
    settings.set("imagegen_output_dir", outputRoot);
    const project = projects.create({ name: "自定义 输出项目" });
    const [storyboard] = storyboards.replace(project.id, [
      { index: 0, originalText: "画面", prompt: "自定义目录测试", duration: 4 },
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));

    queue.enqueue("image.generate", { storyboardId: storyboard.id });
    await queue.waitForIdle();

    const [imagePath] = storyboards.get(storyboard.id).imagePaths;
    expect(imagePath).toContain(join(outputRoot, `自定义 输出项目-${project.id}`));
    expect(existsSync(imagePath)).toBe(true);
  });

  it("uses persisted profile prompts and writes a reusable standard-name asset", async () => {
    await queue.shutdown();
    queue = new PersistentJobQueue(new JobStore(database.connection), 1);
    queue.register("image.generate", createImageGenerationHandler({
      settings,
      storyboards,
      projects,
      characterProfiles,
      projectsRoot: root,
    }));
    queue.start();

    const projectDirectory = join(root, "角色资产项目");
    const project = projects.create({ name: "角色资产项目", folderPath: projectDirectory });
    const [character] = characterProfiles.replace(project.id, [{
      name: "李明",
      aliases: ["小李"],
      visualPrompt: "黑发青年，深色风衣，正面全身设定",
      prompt: "李明人物设定，纯色背景，稳定五官",
      assetType: "character",
    }]);
    const [storyboard] = storyboards.replace(project.id, [{
      index: 0,
      originalText: "小李走入夜色",
      subjects: ["小李"],
      prompt: "雨夜街道中的背影",
      duration: 4,
    }]);
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(
      JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetcher);

    const job = queue.enqueue("image.generate", {
      storyboardId: storyboard.id,
      characterProfileId: character.id,
    });
    await queue.waitForIdle();

    expect(queue.store.require(job.id).status).toBe("done");
    const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as { prompt: string };
    expect(request.prompt).toContain("李明（人物）：李明人物设定，纯色背景，稳定五官");
    expect(request.prompt).toContain("分镜画面：\n李明人物设定，纯色背景，稳定五官");
    const [assetPath] = (queue.store.require(job.id).output as { characterAssetPaths: string[] }).characterAssetPaths;
    expect(assetPath).toBe(join(projectDirectory, "资产图", "李明.png"));
    expect(existsSync(assetPath)).toBe(true);
  });

  it("generates standalone images without creating or modifying project storyboards", async () => {
    const outputRoot = join(root, "独立生图输出");
    const project = projects.create({ name: "不应被修改的项目" });
    storyboards.replace(project.id, [
      { index: 0, originalText: "原分镜", prompt: "原提示词", duration: 4 },
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));

    const job = queue.enqueue("image.standalone", {
      prompt: "独立生成的画面",
      name: "第一张",
      batchName: "独立批次",
      outputDirectory: outputRoot,
    });
    await queue.waitForIdle();

    const completed = queue.store.require(job.id);
    expect(completed.status).toBe("done");
    expect(completed.output).toMatchObject({ outputDirectory: join(outputRoot, "独立批次") });
    const [imagePath] = (completed.output as { imagePaths: string[] }).imagePaths;
    expect(imagePath).toBe(join(outputRoot, "独立批次", "第一张.png"));
    expect(existsSync(imagePath)).toBe(true);
    expect(storyboards.list(project.id)).toMatchObject([
      { originalText: "原分镜", prompt: "原提示词", imagePaths: [], status: "pending" },
    ]);
  });

  it("uses stable asset names and replaces an older image extension", async () => {
    const outputRoot = join(root, "角色出图");
    const batchDirectory = join(outputRoot, "角色批次");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG }, { b64_json: ONE_PIXEL_PNG }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));

    const first = queue.enqueue("image.standalone", {
      prompt: "白发宿老角色设定",
      name: "白发宿老",
      batchName: "角色批次",
      outputDirectory: outputRoot,
      count: 2,
    });
    await queue.waitForIdle();

    expect(queue.store.require(first.id).status).toBe("done");
    expect((queue.store.require(first.id).output as { imagePaths: string[] }).imagePaths).toEqual([
      join(batchDirectory, "白发宿老.png"),
      join(batchDirectory, "白发宿老-2.png"),
    ]);

    await writeFile(join(batchDirectory, "白发宿老.jpg"), "old-image");
    const replacement = queue.enqueue("image.standalone", {
      prompt: "更新后的白发宿老角色设定",
      name: "白发宿老",
      batchName: "角色批次",
      outputDirectory: outputRoot,
    });
    await queue.waitForIdle();

    expect(queue.store.require(replacement.id).status).toBe("done");
    expect(existsSync(join(batchDirectory, "白发宿老.png"))).toBe(true);
    expect(existsSync(join(batchDirectory, "白发宿老.jpg"))).toBe(false);
  });

  it("marks the storyboard as error and leaves image paths untouched on API failure", async () => {
    const project = projects.create({ name: "失败保护" });
    const [storyboard] = storyboards.replace(project.id, [
      { index: 0, originalText: "画面", prompt: "测试提示词", duration: 4 },
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "denied" } }), { status: 403 })));

    const job = queue.enqueue("image.generate", { storyboardId: storyboard.id });
    await queue.waitForIdle();

    expect(queue.store.require(job.id).status).toBe("error");
    expect(storyboards.get(storyboard.id)).toMatchObject({ status: "error", imagePaths: [] });
  });

  it("removes the generated file when attaching it to the storyboard fails", async () => {
    const project = projects.create({ name: "回写失败保护" });
    const [storyboard] = storyboards.replace(project.id, [
      { index: 0, originalText: "画面", prompt: "回写失败测试", duration: 4 },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    vi.spyOn(storyboards, "attachGeneratedImage").mockImplementation(() => {
      throw new Error("database write failed");
    });

    const job = queue.enqueue("image.generate", { storyboardId: storyboard.id });
    await queue.waitForIdle();

    expect(queue.store.require(job.id).status).toBe("error");
    expect(storyboards.get(storyboard.id)).toMatchObject({ status: "error", imagePaths: [] });
    const imageDirectory = join(root, `project-${project.id}`, "images");
    expect(await readdir(imageDirectory)).toEqual([]);
  });
});
