import type { CreateProjectInput, ProjectCreationMode } from "../../../shared/contracts";

export type ProjectCreationDraft = {
  mode: ProjectCreationMode;
  name: string;
  projectBaseFolder: string;
  folderPath: string;
  subtitlePath: string;
  audioPath: string;
};

export function emptyProjectCreationDraft(projectBaseFolder = ""): ProjectCreationDraft {
  return {
    mode: "original",
    name: "",
    projectBaseFolder,
    folderPath: "",
    subtitlePath: "",
    audioPath: "",
  };
}

export function projectCreationValidationError(draft: ProjectCreationDraft): string | null {
  if (!draft.name.trim()) return "请输入项目名称";
  if (draft.mode === "original") {
    if (!draft.subtitlePath.trim()) return "请选择字幕文件";
    if (!draft.audioPath.trim()) return "请选择音频文件";
    if (!draft.projectBaseFolder.trim()) return "请先在设置中配置项目根目录";
    return null;
  }
  if (Boolean(draft.subtitlePath.trim()) !== Boolean(draft.audioPath.trim())) {
    return "字幕文件和旁白音频需要同时选择";
  }
  return null;
}

export function createProjectInput(draft: ProjectCreationDraft): CreateProjectInput {
  const error = projectCreationValidationError(draft);
  if (error) throw new Error(error);
  const name = draft.name.trim();
  if (draft.mode === "original") {
    return {
      mode: "original",
      name,
      subtitlePath: draft.subtitlePath,
      audioPath: draft.audioPath,
    };
  }
  return {
    mode: "advanced",
    name,
    ...(draft.folderPath ? { folderPath: draft.folderPath } : {}),
    ...(draft.subtitlePath && draft.audioPath ? {
      subtitlePath: draft.subtitlePath,
      audioPath: draft.audioPath,
    } : {}),
  };
}
