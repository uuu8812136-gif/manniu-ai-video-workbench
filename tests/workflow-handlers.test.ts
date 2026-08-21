import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/database";
import { JobStore, PersistentJobQueue } from "../src/main/jobs";
import {
  CharacterProfileRepository,
  ProjectRepository,
  SettingsRepository,
  StoryboardRepository,
} from "../src/main/repositories";
import { openingInput, polishInput, registerWorkflowHandlers } from "../src/main/workflow-handlers";

describe("registered workflow handlers", () => {
  let database: AppDatabase;
  let queue: PersistentJobQueue;
  let settings: SettingsRepository;
  let projects: ProjectRepository;
  let storyboards: StoryboardRepository;
  let characterProfiles: CharacterProfileRepository;
  let root: string;

  beforeEach(() => {
    database = new AppDatabase(":memory:");
    settings = new SettingsRepository(database.connection);
    projects = new ProjectRepository(database.connection);
    storyboards = new StoryboardRepository(database.connection);
    characterProfiles = new CharacterProfileRepository(database.connection);
    root = mkdtempSync(join(tmpdir(), "ai-tool-workflow-"));
    settings.set("text_polish_api_base_url", "http://127.0.0.1:9001/v1");
    settings.set("text_polish_model", "local-text");
    settings.set("infer_api_base_url", "http://127.0.0.1:9001/v1");
    settings.set("infer_model", "local-storyboard");
    queue = new PersistentJobQueue(new JobStore(database.connection), 2);
    registerWorkflowHandlers(queue, settings, storyboards, {
      projects,
      projectsRoot: root,
      characterProfiles,
      allowLegacyInferenceFastPath: true,
    });
    queue.start();
  });

  afterEach(async () => {
    await queue.shutdown();
    database.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    vi.unstubAllGlobals();
  });

  it("accepts current opening modes and preserves legacy job inputs", () => {
    expect(openingInput.parse({ text: "正文", title: "书名", mode: "general", outDir: "D:\\输出" }))
      .toMatchObject({ mode: "general", title: "书名", outDir: "D:\\输出" });
    expect(openingInput.parse({ text: "正文", mode: "enhanced" }).mode).toBe("enhanced");
    expect(openingInput.parse({ text: "正文", mode: "rewrite" }).mode).toBe("rewrite");
    expect(openingInput.parse({ text: "正文", mode: "variants" }).mode).toBe("variants");
    expect(() => openingInput.parse({ text: "正文", mode: "unknown" })).toThrow();
    expect(polishInput.parse({ text: "正文", title: "文案" }).title).toBe("文案");
    expect(polishInput.parse({ text: "\n正文\n", title: "文案" }).text).toBe("\n正文\n");
    expect(() => polishInput.parse({ text: " \n " })).toThrow("文案内容为空");
  });

  it("runs opening optimization through the configured local Responses API", async () => {
    settings.set("text_polish_api_base_url", "http://127.0.0.1:9002/v1");
    settings.set("text_polish_model", "must-not-be-used");
    const fetcher = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      expect(String(input)).toBe("http://127.0.0.1:9001/v1/responses");
      return new Response(JSON.stringify({ output_text: "改写后的开头", model: "local-storyboard" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetcher);

    const job = queue.enqueue("opening.optimize", { text: "原始开头", mode: "rewrite" });
    await queue.waitForIdle();

    expect(queue.store.require(job.id)).toMatchObject({
      status: "done",
      progress: 100,
      output: { text: "改写后的开头", model: "local-storyboard" },
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({ model: "local-storyboard" });
  });

  it("atomically persists the finalized opening as output_kaitou.txt before completing", async () => {
    const outputDirectory = join(root, "开头输出");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      output_text: "改写后的开头",
      model: "local-storyboard",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    const job = queue.enqueue("opening.optimize", {
      text: "原始开头",
      mode: "rewrite",
      outDir: outputDirectory,
    });
    await queue.waitForIdle();

    const outputPath = join(outputDirectory, "output_kaitou.txt");
    expect(queue.store.require(job.id)).toMatchObject({
      status: "done",
      output: {
        text: "改写后的开头",
        content: "改写后的开头",
        outputPath,
        outDir: outputDirectory,
        model: "local-storyboard",
      },
    });
    expect(readFileSync(outputPath, "utf8")).toBe("改写后的开头");
    expect(readdirSync(outputDirectory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("does not mark opening optimization done when output_kaitou.txt cannot be committed", async () => {
    const blockedDirectory = join(root, "开头目录被文件占用");
    writeFileSync(blockedDirectory, "blocked", "utf8");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ output_text: "不能丢失的开头" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    const job = queue.enqueue("opening.optimize", {
      text: "原始开头",
      mode: "rewrite",
      outDir: blockedDirectory,
    });
    await queue.waitForIdle();

    expect(queue.store.require(job.id)).toMatchObject({ status: "error", output: null });
  });

  it("atomically persists text polish output before completing the job", async () => {
    const outputDirectory = join(root, "捋文输出");
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input?: string; instructions?: string; model?: string; stream?: boolean };
      expect(body).toMatchObject({ input: "原始正文", model: "local-text", stream: true });
      expect(body.instructions).toContain("剧情与代入感绝对红线");
      expect(body.instructions).not.toContain('故事<>:"/\\|?*');
      return new Response(JSON.stringify({
        output_text: "整理后的正文",
        model: "local-text",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    const job = queue.enqueue("text.polish", {
      text: "原始正文",
      title: '故事<>:"/\\|?*',
      outDir: outputDirectory,
    });
    await queue.waitForIdle();

    const outputPath = join(outputDirectory, "故事__________捋文.txt");
    expect(queue.store.require(job.id)).toMatchObject({
      status: "done",
      output: {
        text: "整理后的正文",
        content: "整理后的正文",
        outputPath,
        model: "local-text",
      },
    });
    expect(readFileSync(outputPath, "utf8")).toBe("整理后的正文");
    expect(readdirSync(outputDirectory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("does not mark text polish done when its output file cannot be committed", async () => {
    const blockedDirectory = join(root, "不是目录");
    writeFileSync(blockedDirectory, "blocked", "utf8");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ output_text: "不能丢失的结果" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    const job = queue.enqueue("text.polish", {
      text: "原始正文",
      title: "失败样例",
      outDir: blockedDirectory,
    });
    await queue.waitForIdle();

    expect(queue.store.require(job.id)).toMatchObject({ status: "error", output: null });
  });

  it("runs advanced polish with a distinct persisted workflow mode", async () => {
    const outputDirectory = join(root, "高级捋文输出");
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input?: string; instructions?: string };
      expect(body.input).toBe("允许重组的正文");
      expect(body.instructions).toContain("可以重组句序");
      expect(body.instructions).not.toContain("剧情与代入感绝对红线");
      return new Response(JSON.stringify({ output_text: "高级整理结果", model: "local-text" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetcher);

    const job = queue.enqueue("text.polish", {
      text: "允许重组的正文",
      title: "高级样例",
      outDir: outputDirectory,
      mode: "advanced",
      sourceFormat: "docx",
    });
    await queue.waitForIdle();

    expect(queue.store.require(job.id)).toMatchObject({
      status: "done",
      input: { mode: "advanced", sourceFormat: "docx" },
      output: { text: "高级整理结果", mode: "advanced" },
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("runs the original general opening skill and passes the deterministic file gate", async () => {
    const draft = [
      "【题材】 都市",
      "备选开头",
      ...Array.from({ length: 5 }, (_, index) => `—— 开头 ${index + 1}（方向：方向${index + 1}，结构：结构${index + 1}，得分：${90 - index}） ——\n第${index + 1}个开头`),
    ].join("\n");
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { instructions?: string; stream?: boolean };
      expect(request.stream).toBe(true);
      expect(request.instructions).toContain("通用版小说推文开头");
      expect(request.instructions).toContain("原版参考库");
      return new Response(JSON.stringify({ output_text: draft, model: "local-text" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetcher);

    const job = queue.enqueue("opening.optimize", { text: "第一章\n原文正文", mode: "general" });
    await queue.waitForIdle();

    expect(queue.store.require(job.id)).toMatchObject({ status: "done", output: { model: "local-text" } });
    expect(String((queue.store.require(job.id).output as { text: string }).text)).toContain("抓取正文（原文，未优化）\n========\n\n第一章\n原文正文");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("validates storyboard JSON and writes it to the selected project", async () => {
    const projectFolder = join(root, "自动分镜项目");
    const project = projects.create({ name: "自动分镜项目", folderPath: projectFolder });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({ max_output_tokens: 24_000 });
        return new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              characters: [{
                name: "主角",
                aliases: ["主人公"],
                identity: "返乡旅客",
                gender: "男性",
                age: "青年",
                appearance: "清瘦面容，身形挺拔",
                hair: "黑色短发",
                clothing: "深灰长风衣",
                personality: "沉静警觉",
                visual_prompt: "青年男性，清瘦面容，身形挺拔，黑色短发，深灰长风衣，沉静警觉",
              }],
              storyboards: [
                { original_text: "第一幕", subjects: ["主角"], prompt: "主角走进车站", duration: 4 },
                { original_text: "第二幕", subjects: ["主角"], prompt: "列车驶离站台", duration: 5 },
              ],
            }),
            model: "local-storyboard",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const job = queue.enqueue("storyboard.infer", { text: "两幕故事", projectId: project.id, genre: "剧情" });
    await queue.waitForIdle();

    expect(queue.store.require(job.id).status).toBe("done");
    expect(queue.store.list().filter((candidate) =>
      candidate.type === "storyboard.infer" && ["queued", "running"].includes(candidate.status)
    )).toEqual([]);
    expect(storyboards.list(project.id)).toMatchObject([
      { index: 0, originalText: "第一幕", prompt: "主角走进车站", duration: 2, status: "pending" },
      { index: 1, originalText: "第二幕", prompt: "列车驶离站台", duration: 2, status: "pending" },
    ]);
    const roster = readFileSync(join(projectFolder, "角色表.txt"), "utf8");
    expect(roster.startsWith("\ufeff")).toBe(false);
    expect(roster.split(/\r?\n/)).toEqual([
      "主角",
      "返乡旅客 | 男性 | 青年",
      "青年男性，清瘦面容，身形挺拔，黑色短发，深灰长风衣，沉静警觉",
      "",
      "# 角色别名 | 主角 | 主人公",
    ]);
    const sentences = readFileSync(join(projectFolder, "自动分镜项目_sentences.txt"), "utf8");
    expect(sentences.startsWith("\ufeff")).toBe(false);
    expect(sentences.endsWith("\r\n")).toBe(true);
    expect(readFileSync(join(projectFolder, "自动分镜项目.csv"), "utf8")).toContain("编号,原声,秒数,画面提示词");
    expect(projects.get(project.id).csvPath).toBe(join(projectFolder, "自动分镜项目.csv"));
    expect(projects.get(project.id).rosterPath).toBe(join(projectFolder, "角色表.txt"));
    expect(characterProfiles.list(project.id)).toMatchObject([{
      name: "主角",
      aliases: ["主人公"],
      visualPrompt: "青年男性，清瘦面容，身形挺拔，黑色短发，深灰长风衣，沉静警觉",
    }]);
  });

  it("streams DeepSeek reasoning and content into visible monotonic workflow progress", async () => {
    const project = projects.create({ name: "流式分镜项目" });
    settings.set("infer_protocol", "chat");
    settings.set("infer_thinking", "auto");
    settings.set("infer_max_output_tokens", "8192");
    const storyboardJson = JSON.stringify({
      characters: [{
        name: "lead",
        gender_age: "young adult",
        appearance: "lean face",
        hair: "short black hair",
        clothing: "dark coat",
        personality: "alert",
        visual_prompt: "young adult, lean face, short black hair, dark coat, alert",
      }],
      storyboards: [
        { original_text: "scene one", subjects: ["lead"], prompt: "lead enters station", duration: 4 },
      ],
    });
    const sse = [
      `data: ${JSON.stringify({ id: "deepseek-stream", model: "deepseek-v4-pro", choices: [{ delta: { reasoning_content: "analyzing story structure" } }] })}\n\n`,
      `data: ${JSON.stringify({ id: "deepseek-stream", model: "deepseek-v4-pro", choices: [{ delta: { content: storyboardJson.slice(0, 35) } }] })}\n\n`,
      `data: ${JSON.stringify({ id: "deepseek-stream", model: "deepseek-v4-pro", choices: [{ delta: { content: storyboardJson.slice(35) } }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    const encoder = new TextEncoder();
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "local-storyboard",
        max_tokens: 8192,
        stream: true,
        thinking: { type: "disabled" },
      });
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(sse.slice(0, 80)));
          controller.enqueue(encoder.encode(sse.slice(80)));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetcher);

    const job = queue.enqueue("storyboard.infer", { text: "long novel", projectId: project.id });
    await queue.waitForIdle();

    expect(queue.store.require(job.id)).toMatchObject({ status: "done", progress: 100 });
    const progressEvents = queue.store.events(job.id).filter((event) =>
      event.detail && typeof event.detail === "object" && typeof (event.detail as { progress?: unknown }).progress === "number"
    );
    const progressValues = progressEvents.map((event) => (event.detail as { progress: number }).progress);
    expect(progressValues).toEqual([...progressValues].sort((left, right) => left - right));
    expect(progressValues.some((value) => value >= 9 && value <= 13)).toBe(true);
    expect(progressValues.some((value) => value >= 14 && value <= 18)).toBe(true);
    expect(progressEvents.map((event) => event.message)).toEqual(expect.arrayContaining([
      "模型正在分析内容",
      "正在生成结果正文",
    ]));
    expect(storyboards.list(project.id)).toHaveLength(1);
  });

  it("pauses a legacy names-only response without writing a false-complete roster", async () => {
    const projectFolder = join(root, "缺角色档案");
    const project = projects.create({ name: "缺角色档案", folderPath: projectFolder });
    storyboards.replace(project.id, [{ index: 0, originalText: "原有分镜", prompt: "原有画面" }]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({
        output_text: JSON.stringify([
          { original_text: "新分镜", subjects: ["主角"], prompt: "新画面", duration: 4 },
        ]),
      }), { status: 200, headers: { "content-type": "application/json" } })),
    );

    const job = queue.enqueue("storyboard.infer", { text: "新故事", projectId: project.id });
    await queue.waitForIdle();

    expect(queue.store.require(job.id).status).toBe("paused");
    expect(queue.store.require(job.id).error).toContain("角色表");
    expect(queue.store.events(job.id).at(-1)).toMatchObject({
      level: "warning",
      message: "Job paused for attention",
      detail: expect.objectContaining({ stage: "assets", errorCategory: "ROSTER.GENERATION_FAILED" }),
    });
    expect(storyboards.list(project.id)).toMatchObject([{ originalText: "原有分镜", prompt: "原有画面" }]);
    expect(() => readFileSync(join(projectFolder, "角色表.txt"), "utf8")).toThrow();
  });

  it("pauses and leaves the existing project untouched when model output is invalid", async () => {
    const project = projects.create({ name: "保护项目" });
    storyboards.replace(project.id, [{ index: 0, originalText: "原有分镜", prompt: "原有画面" }]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ output_text: "模型输出坏格式" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const job = queue.enqueue("storyboard.infer", { text: "新故事", projectId: project.id });
    await queue.waitForIdle();

    expect(queue.store.require(job.id).status).toBe("paused");
    expect(storyboards.list(project.id)).toMatchObject([{ originalText: "原有分镜", prompt: "原有画面" }]);
  });

  it("keeps existing storyboards when artifact files cannot be written", async () => {
    const blockedPath = join(root, "不是目录");
    writeFileSync(blockedPath, "file");
    const project = projects.create({ name: "产物失败保护", folderPath: blockedPath });
    storyboards.replace(project.id, [{ index: 0, originalText: "原有分镜", prompt: "原有画面" }]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({
        output_text: JSON.stringify({
          characters: [{ name: "主角", visual_prompt: "青年主角，黑色短发，深色外套" }],
          storyboards: [
            { original_text: "新分镜", subjects: ["主角"], prompt: "新画面", duration: 4 },
          ],
        }),
      }), { status: 200, headers: { "content-type": "application/json" } })),
    );

    const job = queue.enqueue("storyboard.infer", { text: "新故事", projectId: project.id });
    await queue.waitForIdle();

    expect(queue.store.require(job.id)).toMatchObject({ status: "error", output: null });
    expect(queue.store.list().filter((candidate) =>
      candidate.type === "storyboard.infer" && ["queued", "running"].includes(candidate.status)
    )).toEqual([]);
    expect(queue.store.events(job.id).at(-1)).toMatchObject({ level: "error", message: "Job failed" });
    expect(storyboards.list(project.id)).toMatchObject([{ originalText: "原有分镜", prompt: "原有画面" }]);
    expect(projects.get(project.id).csvPath).toBe("");
  });
});
