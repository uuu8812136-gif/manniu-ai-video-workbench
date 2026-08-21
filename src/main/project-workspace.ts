import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Project } from "../shared/contracts";
import { readCsvFile, type CsvParseResult } from "./file-workflows";
import { parseOriginalRoster } from "./original-inference";
import { initializeProjectWorkspace } from "./project-creation";
import type { CharacterProfileRepository, ProjectRepository, StoryboardRepository } from "./repositories";

export type ProjectWorkspaceRecoveryReport = {
  initialized: number;
  profilesRecovered: number;
  warnings: string[];
};

export type ProjectDurationRecoveryReport = {
  projectsChecked: number;
  projectsRecovered: number;
  storyboardsRecovered: number;
  warnings: string[];
};

function normalizedHeader(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s_-]+/gu, "");
}

function findColumn(columns: string[], aliases: string[]): string | undefined {
  const accepted = new Set(aliases.map(normalizedHeader));
  return columns.find((column) => accepted.has(normalizedHeader(column)));
}

function csvDurations(
  csv: CsvParseResult,
  current: ReturnType<StoryboardRepository["list"]>,
): Map<number, number> | null {
  const indexColumn = findColumn(csv.columns, ["序号", "编号", "镜号", "index", "idx"]);
  const originalColumn = findColumn(csv.columns, ["原文", "原声", "文案", "文本", "originalText", "text"]);
  const durationColumn = findColumn(csv.columns, ["时长", "时长秒", "秒数", "duration", "durationSeconds"]);
  if (!durationColumn || csv.errors.length > 0 || csv.rows.length !== current.length) return null;

  const rows = new Map<number, Record<string, string>>();
  for (const [position, row] of csv.rows.entries()) {
    const externalIndex = indexColumn ? Number(row[indexColumn]) : position + 1;
    if (!Number.isInteger(externalIndex) || externalIndex < 1 || rows.has(externalIndex - 1)) return null;
    rows.set(externalIndex - 1, row);
  }

  const durations = new Map<number, number>();
  for (const storyboard of current) {
    const row = rows.get(storyboard.index);
    if (!row) return null;
    if (originalColumn && (row[originalColumn] ?? "").trim() !== storyboard.originalText.trim()) return null;
    const duration = Number(row[durationColumn]);
    if (!Number.isFinite(duration) || duration < 1 || duration > 600) return null;
    durations.set(storyboard.index, Math.floor(duration));
  }
  return durations;
}

function rosterCandidates(project: Project): string[] {
  return Array.from(new Set([
    project.rosterPath.trim(),
    project.folderPath.trim() ? join(resolve(project.folderPath), "角色表.txt") : "",
  ].filter(Boolean).map((path) => resolve(path))));
}

export function recoverProjectWorkspaces(
  projects: ProjectRepository,
  characterProfiles: CharacterProfileRepository,
): ProjectWorkspaceRecoveryReport {
  const report: ProjectWorkspaceRecoveryReport = { initialized: 0, profilesRecovered: 0, warnings: [] };
  for (const project of projects.list()) {
    if (project.folderPath.trim()) {
      try {
        initializeProjectWorkspace(project.folderPath);
        report.initialized += 1;
      } catch (error) {
        report.warnings.push(`${project.name}：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (characterProfiles.list(project.id).length > 0) continue;
    for (const rosterPath of rosterCandidates(project)) {
      if (!existsSync(rosterPath)) continue;
      try {
        const recovered = parseOriginalRoster(readFileSync(rosterPath, "utf8"));
        characterProfiles.replace(project.id, recovered.map((profile) => ({
          ...profile,
          prompt: profile.visualPrompt,
        })));
        if (project.rosterPath !== rosterPath) projects.update(project.id, { rosterPath });
        report.profilesRecovered += recovered.length;
        break;
      } catch (error) {
        report.warnings.push(`${project.name} 角色表：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return report;
}

export async function recoverProjectStoryboardDurations(
  projects: ProjectRepository,
  storyboards: StoryboardRepository,
): Promise<ProjectDurationRecoveryReport> {
  const report: ProjectDurationRecoveryReport = {
    projectsChecked: 0,
    projectsRecovered: 0,
    storyboardsRecovered: 0,
    warnings: [],
  };
  for (const project of projects.list()) {
    const current = storyboards.list(project.id);
    if (current.length === 0 || current.some((storyboard) => storyboard.duration !== 4)) continue;
    const csvPath = project.csvPath.trim();
    if (!csvPath || !existsSync(csvPath)) continue;
    report.projectsChecked += 1;
    try {
      const durations = csvDurations(await readCsvFile(csvPath), current);
      if (!durations || ![...durations.values()].some((duration) => duration !== 4)) continue;
      let recovered = 0;
      for (const storyboard of current) {
        const duration = durations.get(storyboard.index);
        if (duration === undefined || duration === storyboard.duration) continue;
        storyboards.update(storyboard.id, { duration });
        recovered += 1;
      }
      if (recovered > 0) {
        report.projectsRecovered += 1;
        report.storyboardsRecovered += recovered;
      }
    } catch (error) {
      report.warnings.push(`${project.name} 时长恢复：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return report;
}
