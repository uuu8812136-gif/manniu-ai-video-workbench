import { describe, expect, it } from "vitest";
import {
  anchorViduRoleNames,
  bindViduSubjects,
  buildViduCharacterPayload,
  extractViduRoleNames,
  extractViduTaskId,
  extractViduVideoUrl,
  normalizeViduTask,
  type ViduMaterial,
} from "../src/main/vidu-protocol";

const materials: ViduMaterial[] = [
  { id: "material-1", name: "小李", version: "7", url: "https://files.example/xiaoli.png", raw: {} },
  { id: "material-2", name: "店员", version: "3", url: "https://files.example/clerk.png", raw: {} },
];

describe("Vidu browser protocol", () => {
  it("anchors referenced roles in order and builds the original Q3 character payload", () => {
    const prompt = "@小李 走进商店，@店员 抬头，@小李 微笑";
    expect(extractViduRoleNames(prompt)).toEqual(["小李", "店员"]);
    expect(anchorViduRoleNames(prompt)).toBe("[@小李] 走进商店，[@店员] 抬头，[@小李] 微笑");

    const payload = buildViduCharacterPayload({
      prompt,
      materials,
      durationSeconds: 6,
      model: "Q3",
      useCredits: true,
      aspectRatio: "9:16",
    });
    expect(payload).toMatchObject({
      type: "character2video",
      input: {
        editor_mode: "normal",
        enhance: true,
        prompts: [
          { type: "text", content: "[@小李] 走进商店，[@店员] 抬头，[@小李] 微笑，4K，3D国漫风格，电影级画质" },
          { type: "material", content: materials[0].url, name: "小李", material: { id: "material-1", version: "7" } },
          { type: "material", content: materials[1].url, name: "店员", material: { id: "material-2", version: "3" } },
        ],
      },
      settings: {
        duration: 6,
        model: "vidu",
        model_version: "3.2",
        resolution: "1080p",
        aspect_ratio: "9:16",
        schedule_mode: "normal",
        transition: "pro",
        codec: "h264",
        sample_count: 1,
      },
    });
  });

  it("maps Q2 to model 3.1 and non-peak mode", () => {
    const payload = buildViduCharacterPayload({
      prompt: "空镜",
      materials: [],
      durationSeconds: 4,
      model: "Q2",
      useCredits: false,
    }) as { settings: Record<string, unknown> };
    expect(payload.settings).toMatchObject({ model_version: "3.1", schedule_mode: "nopeak", transition: "unspecified" });
  });

  it("falls back to the original 16:9 ratio for unsupported values", () => {
    const payload = buildViduCharacterPayload({
      prompt: "空镜",
      materials: [],
      durationSeconds: 4,
      model: "Q3",
      useCredits: true,
      aspectRatio: "21:9",
    }) as { settings: Record<string, unknown> };
    expect(payload.settings.aspect_ratio).toBe("16:9");
  });

  it("binds storyboard subjects even when the prompt omitted @ markers", () => {
    const bound = bindViduSubjects("小李进入商店", ["小李", "店员"]);
    expect(bound).toBe("@小李 进入商店，@店员");
    expect(anchorViduRoleNames(bound)).toBe("[@小李] 进入商店，[@店员]");
    expect(bindViduSubjects("@小李进入商店", ["小李"])).toBe("@小李进入商店");
  });

  it("accepts verified task id fields without mistaking nested resource ids for task ids", () => {
    expect(extractViduTaskId({ data: { result: [{ taskId: "task-42" }] } })).toBe("task-42");
    expect(extractViduTaskId({ payload: { task_id: 73 } })).toBe("73");
    expect(extractViduTaskId({ id: "history-task", creations: [{ id: "creation-1" }] })).toBe("history-task");
    expect(extractViduTaskId({ data: { result: [{ id: "creation-1", uri: "https://files.example/video.mp4" }] } })).toBeNull();
    expect(extractViduTaskId({ material: { id: "material-1" }, user: { id: "user-1" } })).toBeNull();
  });

  it("prefers the downloadable video over covers", () => {
    const response = {
      creations: [{ cover_uri: "https://files.example/poster.jpg", download_uri: "https://files.example/final-video.mp4" }],
    };
    expect(extractViduVideoUrl(response)).toBe("https://files.example/final-video.mp4");
  });

  it("keeps success-without-url waiting and only fails explicit failed creations", () => {
    expect(normalizeViduTask("waiting", { state: "success", creations: [{ type: "video" }] })).toMatchObject({
      phase: "succeeded",
      resultUrl: null,
    });
    expect(normalizeViduTask("failed", {
      state: "success",
      creations: [{ type: "video", err_info: { err_code: "failed" } }],
    })).toMatchObject({ phase: "failed", providerStatus: "failed" });
  });
});
