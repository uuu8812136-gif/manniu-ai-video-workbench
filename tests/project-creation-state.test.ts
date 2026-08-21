import { describe, expect, it } from "vitest";
import {
  createProjectInput,
  emptyProjectCreationDraft,
  projectCreationValidationError,
  type ProjectCreationDraft,
} from "../src/renderer/src/pages/project-creation-state";

const complete: ProjectCreationDraft = {
  mode: "original",
  name: " 原版项目 ",
  projectBaseFolder: "D:\\项目",
  folderPath: "D:\\不应提交",
  subtitlePath: "D:\\素材\\voice.srt",
  audioPath: "D:\\素材\\voice.mp3",
};

describe("project creation page state", () => {
  it("clears the original creation form while retaining the configured root", () => {
    expect(emptyProjectCreationDraft("D:\\项目")).toEqual({
      mode: "original",
      name: "",
      projectBaseFolder: "D:\\项目",
      folderPath: "",
      subtitlePath: "",
      audioPath: "",
    });
  });

  it("requires name, SRT, audio and configured root in original mode", () => {
    expect(projectCreationValidationError({ ...complete, name: "" })).toBe("请输入项目名称");
    expect(projectCreationValidationError({ ...complete, subtitlePath: "" })).toBe("请选择字幕文件");
    expect(projectCreationValidationError({ ...complete, audioPath: "" })).toBe("请选择音频文件");
    expect(projectCreationValidationError({ ...complete, projectBaseFolder: "" })).toBe("请先在设置中配置项目根目录");
    expect(createProjectInput(complete)).toEqual({
      mode: "original",
      name: "原版项目",
      subtitlePath: complete.subtitlePath,
      audioPath: complete.audioPath,
    });
  });

  it("keeps custom folders and optional paired materials in advanced mode", () => {
    const advanced = { ...complete, mode: "advanced" as const, projectBaseFolder: "" };
    expect(createProjectInput(advanced)).toEqual({
      mode: "advanced",
      name: "原版项目",
      folderPath: complete.folderPath,
      subtitlePath: complete.subtitlePath,
      audioPath: complete.audioPath,
    });
    expect(createProjectInput({ ...advanced, subtitlePath: "", audioPath: "" })).toEqual({
      mode: "advanced",
      name: "原版项目",
      folderPath: complete.folderPath,
    });
    expect(projectCreationValidationError({ ...advanced, audioPath: "" })).toBe("字幕文件和旁白音频需要同时选择");
  });
});
