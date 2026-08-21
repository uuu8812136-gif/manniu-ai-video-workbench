import type {
  ImportedCsvFile,
  JianyingExportInput,
  Project,
  SrtCue,
  Storyboard,
  StoryboardDraft,
  WorkflowJob,
} from "../../../shared/contracts";
import { extractAssetNames, mergeAssetNames } from "../../../shared/asset-names";
import { originalStoryboardDuration } from "../../../shared/storyboard-duration";

export type ParsedStoryboardCsvRow = {
  draft: StoryboardDraft;
  mediaPath: string | null;
  mediaKind: "video" | "photo" | null;
};

const VIDEO_EXTENSIONS = /\.(?:mp4|mov|mkv|avi|webm|m4v)$/i;
const ACTIVE_MEDIA_JOB_STATUSES = new Set(["queued", "running", "paused"]);
const ALIGNMENT_FULL_MATRIX_CELLS = 50_000_000;
const ALIGNMENT_RECURSION_MATRIX_CELLS = 2_000_000;
const ALIGNMENT_GAP_SCORE = -2;
const ALIGNMENT_MATCH_SCORE = 2;
const ALIGNMENT_MISMATCH_SCORE = -1;

type StoryboardCharacter = { value: string; storyboardPosition: number };
type TimedSubtitleCharacter = { value: string; startUs: number; endUs: number };

export type StoryboardSrtTiming = {
  storyboardIndex: number;
  startUs: number;
  endUs: number;
  durationUs: number;
  inferred: boolean;
};

export type StoryboardSrtMatchReport = {
  matchRate: number;
  matchedCharacters: number;
  totalCharacters: number;
  timings: StoryboardSrtTiming[];
  unmatchedStoryboardIndexes: number[];
  inferredStoryboardIndexes: number[];
};

export type SrtDrivenJianyingExportPlan = {
  input: JianyingExportInput;
  match: StoryboardSrtMatchReport;
};

function isCjkUnifiedIdeograph(codePoint: number): boolean {
  return (codePoint >= 0x4e00 && codePoint <= 0x9fff) || (codePoint >= 0x3400 && codePoint <= 0x4dbf);
}

function comparableCharacters(value: string): string[] {
  return [...value.toLocaleLowerCase()].filter((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return isCjkUnifiedIdeograph(codePoint) || /[\p{L}\p{N}]/u.test(character);
  });
}

function timedSubtitleCharacters(cues: SrtCue[]): TimedSubtitleCharacter[] {
  const characters: TimedSubtitleCharacter[] = [];
  for (const cue of cues) {
    const values = comparableCharacters(cue.text);
    if (values.length === 0 || cue.endUs <= cue.startUs) continue;
    const cueDurationUs = cue.endUs - cue.startUs;
    values.forEach((value, index) => {
      characters.push({
        value,
        startUs: cue.startUs + (index / values.length) * cueDurationUs,
        endUs: cue.startUs + ((index + 1) / values.length) * cueDurationUs,
      });
    });
  }
  return characters;
}

function characterScore(left: string, right: string): number {
  return left === right ? ALIGNMENT_MATCH_SCORE : ALIGNMENT_MISMATCH_SCORE;
}

function alignSmallMatrix(
  source: StoryboardCharacter[],
  target: TimedSubtitleCharacter[],
  result: Int32Array,
  sourceStart: number,
  sourceEnd: number,
  targetStart: number,
  targetEnd: number,
): void {
  const sourceLength = sourceEnd - sourceStart;
  const targetLength = targetEnd - targetStart;
  const trace = new Int8Array((sourceLength + 1) * (targetLength + 1));
  let previous = new Int32Array(targetLength + 1);
  let current = new Int32Array(targetLength + 1);
  for (let column = 0; column <= targetLength; column += 1) {
    previous[column] = column * ALIGNMENT_GAP_SCORE;
    trace[column] = 2;
  }
  trace[0] = 0;

  for (let row = 1; row <= sourceLength; row += 1) {
    current[0] = row * ALIGNMENT_GAP_SCORE;
    trace[row * (targetLength + 1)] = 1;
    const sourceCharacter = source[sourceStart + row - 1].value;
    for (let column = 1; column <= targetLength; column += 1) {
      const diagonal = previous[column - 1] + characterScore(sourceCharacter, target[targetStart + column - 1].value);
      const up = previous[column] + ALIGNMENT_GAP_SCORE;
      const left = current[column - 1] + ALIGNMENT_GAP_SCORE;
      let score = diagonal;
      let direction = 0;
      if (up > score) {
        score = up;
        direction = 1;
      }
      if (left > score) {
        score = left;
        direction = 2;
      }
      current[column] = score;
      trace[row * (targetLength + 1) + column] = direction;
    }
    [previous, current] = [current, previous];
  }

  let row = sourceLength;
  let column = targetLength;
  while (row > 0 || column > 0) {
    const direction = trace[row * (targetLength + 1) + column];
    if (row > 0 && column > 0 && direction === 0) {
      result[sourceStart + row - 1] = targetStart + column - 1;
      row -= 1;
      column -= 1;
    } else if (row > 0 && direction === 1) {
      result[sourceStart + row - 1] = -1;
      row -= 1;
    } else {
      column -= 1;
    }
  }
}

function forwardAlignmentScores(
  source: StoryboardCharacter[],
  target: TimedSubtitleCharacter[],
  sourceStart: number,
  sourceEnd: number,
  targetStart: number,
  targetEnd: number,
): Int32Array {
  const targetLength = targetEnd - targetStart;
  let previous = new Int32Array(targetLength + 1);
  let current = new Int32Array(targetLength + 1);
  for (let column = 0; column <= targetLength; column += 1) previous[column] = column * ALIGNMENT_GAP_SCORE;
  for (let sourceIndex = sourceStart; sourceIndex < sourceEnd; sourceIndex += 1) {
    current[0] = (sourceIndex - sourceStart + 1) * ALIGNMENT_GAP_SCORE;
    for (let column = 1; column <= targetLength; column += 1) {
      current[column] = Math.max(
        previous[column - 1] + characterScore(source[sourceIndex].value, target[targetStart + column - 1].value),
        previous[column] + ALIGNMENT_GAP_SCORE,
        current[column - 1] + ALIGNMENT_GAP_SCORE,
      );
    }
    [previous, current] = [current, previous];
  }
  return previous;
}

function reverseAlignmentScores(
  source: StoryboardCharacter[],
  target: TimedSubtitleCharacter[],
  sourceStart: number,
  sourceEnd: number,
  targetStart: number,
  targetEnd: number,
): Int32Array {
  const targetLength = targetEnd - targetStart;
  let previous = new Int32Array(targetLength + 1);
  let current = new Int32Array(targetLength + 1);
  for (let column = 0; column <= targetLength; column += 1) previous[column] = column * ALIGNMENT_GAP_SCORE;
  for (let sourceIndex = sourceEnd - 1; sourceIndex >= sourceStart; sourceIndex -= 1) {
    current[0] = (sourceEnd - sourceIndex) * ALIGNMENT_GAP_SCORE;
    for (let column = 1; column <= targetLength; column += 1) {
      current[column] = Math.max(
        previous[column - 1] + characterScore(source[sourceIndex].value, target[targetEnd - column].value),
        previous[column] + ALIGNMENT_GAP_SCORE,
        current[column - 1] + ALIGNMENT_GAP_SCORE,
      );
    }
    [previous, current] = [current, previous];
  }
  return previous;
}

function alignDivideAndConquer(
  source: StoryboardCharacter[],
  target: TimedSubtitleCharacter[],
  result: Int32Array,
  sourceStart: number,
  sourceEnd: number,
  targetStart: number,
  targetEnd: number,
): void {
  const sourceLength = sourceEnd - sourceStart;
  const targetLength = targetEnd - targetStart;
  if (sourceLength === 0) return;
  if (targetLength === 0) {
    result.fill(-1, sourceStart, sourceEnd);
    return;
  }
  if (sourceLength === 1 || targetLength === 1
    || (sourceLength + 1) * (targetLength + 1) <= ALIGNMENT_RECURSION_MATRIX_CELLS) {
    alignSmallMatrix(source, target, result, sourceStart, sourceEnd, targetStart, targetEnd);
    return;
  }

  const sourceMiddle = sourceStart + Math.floor(sourceLength / 2);
  const forward = forwardAlignmentScores(source, target, sourceStart, sourceMiddle, targetStart, targetEnd);
  const reverse = reverseAlignmentScores(source, target, sourceMiddle, sourceEnd, targetStart, targetEnd);
  const expectedSplit = Math.round(((sourceMiddle - sourceStart) / sourceLength) * targetLength);
  let split = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let offset = 0; offset <= targetLength; offset += 1) {
    const score = forward[offset] + reverse[targetLength - offset];
    if (score > bestScore || (score === bestScore && Math.abs(offset - expectedSplit) < Math.abs(split - expectedSplit))) {
      bestScore = score;
      split = offset;
    }
  }
  const targetMiddle = targetStart + split;
  alignDivideAndConquer(source, target, result, sourceStart, sourceMiddle, targetStart, targetMiddle);
  alignDivideAndConquer(source, target, result, sourceMiddle, sourceEnd, targetMiddle, targetEnd);
}

function alignCharacterSequences(source: StoryboardCharacter[], target: TimedSubtitleCharacter[]): Int32Array {
  const result = new Int32Array(source.length).fill(-1);
  const lookahead = 96;
  let sourceIndex = 0;
  let targetIndex = 0;

  while (sourceIndex < source.length && targetIndex < target.length) {
    if (source[sourceIndex].value === target[targetIndex].value) {
      result[sourceIndex] = targetIndex;
      sourceIndex += 1;
      targetIndex += 1;
      continue;
    }

    const targetLimit = Math.min(target.length, targetIndex + lookahead + 1);
    const sourceLimit = Math.min(source.length, sourceIndex + lookahead + 1);
    let matchingTarget = -1;
    let matchingSource = -1;
    for (let index = targetIndex + 1; index < targetLimit; index += 1) {
      if (target[index].value === source[sourceIndex].value) {
        matchingTarget = index;
        break;
      }
    }
    for (let index = sourceIndex + 1; index < sourceLimit; index += 1) {
      if (source[index].value === target[targetIndex].value) {
        matchingSource = index;
        break;
      }
    }

    const targetDistance = matchingTarget < 0 ? Number.POSITIVE_INFINITY : matchingTarget - targetIndex;
    const sourceDistance = matchingSource < 0 ? Number.POSITIVE_INFINITY : matchingSource - sourceIndex;
    if (targetDistance < sourceDistance) {
      targetIndex = matchingTarget;
    } else if (sourceDistance < Number.POSITIVE_INFINITY) {
      sourceIndex = matchingSource;
    } else {
      result[sourceIndex] = targetIndex;
      sourceIndex += 1;
      targetIndex += 1;
    }
  }
  return result;
}

export function matchStoryboardsToSrt(storyboards: Storyboard[], cues: SrtCue[]): StoryboardSrtMatchReport {
  const ordered = [...storyboards].sort((left, right) => left.index - right.index);
  const subtitleCharacters = timedSubtitleCharacters(cues);
  const sourceCharacters: StoryboardCharacter[] = [];
  const storyboardCharacterCounts = new Array<number>(ordered.length).fill(0);
  ordered.forEach((storyboard, storyboardPosition) => {
    const characters = comparableCharacters(storyboard.originalText);
    storyboardCharacterCounts[storyboardPosition] = characters.length;
    characters.forEach((value) => sourceCharacters.push({ value, storyboardPosition }));
  });

  const emptyReport = (): StoryboardSrtMatchReport => ({
    matchRate: 0,
    matchedCharacters: 0,
    totalCharacters: sourceCharacters.length,
    timings: [],
    unmatchedStoryboardIndexes: ordered.map((storyboard) => storyboard.index),
    inferredStoryboardIndexes: [],
  });
  if (sourceCharacters.length === 0 || subtitleCharacters.length === 0) return emptyReport();

  const alignedTargetIndexes = alignCharacterSequences(sourceCharacters, subtitleCharacters);
  const firstTargetByStoryboard = new Array<number>(ordered.length).fill(-1);
  const lastTargetByStoryboard = new Array<number>(ordered.length).fill(-1);
  let matchedCharacters = 0;
  sourceCharacters.forEach((character, sourceIndex) => {
    const targetIndex = alignedTargetIndexes[sourceIndex];
    if (targetIndex < 0) return;
    if (firstTargetByStoryboard[character.storyboardPosition] < 0) {
      firstTargetByStoryboard[character.storyboardPosition] = targetIndex;
    }
    lastTargetByStoryboard[character.storyboardPosition] = targetIndex;
    if (character.value === subtitleCharacters[targetIndex].value) matchedCharacters += 1;
  });

  const timings = new Map<number, StoryboardSrtTiming>();
  const unmatchedStoryboardIndexes: number[] = [];
  const inferredStoryboardIndexes: number[] = [];
  const inferredPositions = new Set<number>();
  const weight = (position: number): number => {
    const duration = ordered[position].duration;
    return Number.isFinite(duration) && duration > 0 ? duration : storyboardCharacterCounts[position] || 1;
  };

  for (let position = 0; position < ordered.length; position += 1) {
    const firstTarget = firstTargetByStoryboard[position];
    if (firstTarget < 0) {
      if (!inferredPositions.has(position) && storyboardCharacterCounts[position] > 0) {
        unmatchedStoryboardIndexes.push(ordered[position].index);
      }
      continue;
    }
    let nextMatchedTarget = -1;
    const interveningPositions: number[] = [];
    for (let next = position + 1; next < ordered.length; next += 1) {
      if (firstTargetByStoryboard[next] >= 0) {
        nextMatchedTarget = firstTargetByStoryboard[next];
        break;
      }
      if (storyboardCharacterCounts[next] > 0) interveningPositions.push(next);
    }

    const startUs = subtitleCharacters[firstTarget].startUs;
    const directlyMatchedEndUs = subtitleCharacters[lastTargetByStoryboard[position]].endUs;
    const endUs = nextMatchedTarget >= 0 && interveningPositions.length === 0
      ? subtitleCharacters[nextMatchedTarget].startUs
      : directlyMatchedEndUs;
    timings.set(ordered[position].index, {
      storyboardIndex: ordered[position].index,
      startUs: Math.round(startUs),
      endUs: Math.round(endUs),
      durationUs: Math.round(Math.max(0, endUs - startUs)),
      inferred: false,
    });

    if (nextMatchedTarget >= 0 && interveningPositions.length > 0) {
      const gapStartUs = directlyMatchedEndUs;
      const gapEndUs = subtitleCharacters[nextMatchedTarget].startUs;
      const gapDurationUs = Math.max(0, gapEndUs - gapStartUs);
      if (gapDurationUs > 0) {
        const totalWeight = interveningPositions.reduce((sum, item) => sum + weight(item), 0);
        let allocatedWeight = 0;
        let inferredStartUs = gapStartUs;
        interveningPositions.forEach((item, index) => {
          allocatedWeight += weight(item);
          const inferredEndUs = index === interveningPositions.length - 1
            ? gapEndUs
            : gapStartUs + (gapDurationUs * allocatedWeight) / totalWeight;
          timings.set(ordered[item].index, {
            storyboardIndex: ordered[item].index,
            startUs: Math.round(inferredStartUs),
            endUs: Math.round(inferredEndUs),
            durationUs: Math.round(inferredEndUs - inferredStartUs),
            inferred: true,
          });
          inferredStoryboardIndexes.push(ordered[item].index);
          inferredPositions.add(item);
          inferredStartUs = inferredEndUs;
        });
      }
    }
  }

  return {
    matchRate: matchedCharacters / sourceCharacters.length,
    matchedCharacters,
    totalCharacters: sourceCharacters.length,
    timings: [...timings.values()].sort((left, right) => left.startUs - right.startUs),
    unmatchedStoryboardIndexes,
    inferredStoryboardIndexes,
  };
}

export function latestImagePath(storyboard: Pick<Storyboard, "imagePaths">): string | undefined {
  return storyboard.imagePaths.at(-1);
}

export function activeMediaJobsForStoryboards(jobs: WorkflowJob[], storyboardIds: Iterable<number>): WorkflowJob[] {
  const acceptedIds = new Set(storyboardIds);
  return jobs.filter((job) => {
    if ((job.type !== "image.generate" && job.type !== "video.generate") || !ACTIVE_MEDIA_JOB_STATUSES.has(job.status)) {
      return false;
    }
    if (!job.input || typeof job.input !== "object") return false;
    const storyboardId = (job.input as { storyboardId?: unknown }).storyboardId;
    return typeof storyboardId === "number" && acceptedIds.has(storyboardId);
  });
}

export function storyboardReplacementConfirmation(
  existingCount: number,
  replacementCount: number,
  source: "文本" | "CSV",
): string | null {
  return existingCount > 0 ? `用${source}生成的 ${replacementCount} 个分镜替换当前 ${existingCount} 个分镜？` : null;
}

function normalizedHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function findColumn(columns: string[], aliases: string[]): string | undefined {
  const accepted = new Set(aliases.map(normalizedHeader));
  return columns.find((column) => accepted.has(normalizedHeader(column)));
}

function splitSubjects(value: string): string[] {
  return value
    .split(/[,，、;；|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function storyboardRowsFromCsv(file: Pick<ImportedCsvFile, "columns" | "rows">): ParsedStoryboardCsvRow[] {
  const indexColumn = findColumn(file.columns, ["序号", "编号", "镜号", "index", "idx"]);
  const originalColumn = findColumn(file.columns, ["原文", "原声", "文案", "文本", "originalText", "text"])
    ?? file.columns.find((column) => column !== indexColumn)
    ?? file.columns[0];
  const promptColumn = findColumn(file.columns, ["画面提示词", "提示词", "prompt", "imagePrompt"]);
  const subjectsColumn = findColumn(file.columns, ["主体", "人物", "角色", "subjects"]);
  const durationColumn = findColumn(file.columns, ["时长", "时长秒", "秒数", "duration", "durationSeconds"]);
  const mediaPathColumn = findColumn(file.columns, ["素材路径", "媒体路径", "mediaPath", "videoPath", "imagePath"]);
  const mediaKindColumn = findColumn(file.columns, ["素材类型", "媒体类型", "mediaKind", "mediaType"]);
  const usedExternalIndexes = new Set<number>();
  let nextExternalIndex = 1;

  const allocateIndex = (value: string | undefined): number => {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0 && !usedExternalIndexes.has(parsed)) {
      usedExternalIndexes.add(parsed);
      if (parsed >= nextExternalIndex) nextExternalIndex = parsed + 1;
      return parsed - 1;
    }
    while (usedExternalIndexes.has(nextExternalIndex)) nextExternalIndex += 1;
    const allocated = nextExternalIndex;
    usedExternalIndexes.add(allocated);
    nextExternalIndex += 1;
    return allocated - 1;
  };

  return file.rows.map((row) => {
    const originalText = originalColumn ? row[originalColumn]?.trim() ?? "" : "";
    const prompt = promptColumn ? row[promptColumn]?.trim() ?? "" : "";
    const fallbackDuration = originalStoryboardDuration(originalText);
    const rawDuration = durationColumn ? Number(row[durationColumn]) : fallbackDuration;
    const duration = !Number.isFinite(rawDuration) || rawDuration < 1
      ? fallbackDuration
      : Math.min(60, Math.floor(rawDuration));
    const mediaPath = mediaPathColumn ? row[mediaPathColumn]?.trim() || null : null;
    const rawKind = mediaKindColumn ? normalizedHeader(row[mediaKindColumn] ?? "") : "";
    const mediaKind: ParsedStoryboardCsvRow["mediaKind"] = !mediaPath
      ? null
      : rawKind === "video" || rawKind === "视频"
        ? "video"
        : rawKind === "photo" || rawKind === "image" || rawKind === "图片"
          ? "photo"
          : VIDEO_EXTENSIONS.test(mediaPath)
            ? "video"
            : "photo";
    return {
      draft: {
        index: allocateIndex(indexColumn ? row[indexColumn]?.trim() : undefined),
        originalText,
        prompt,
        subjects: mergeAssetNames(
          subjectsColumn ? splitSubjects(row[subjectsColumn] ?? "") : [],
          extractAssetNames(prompt),
        ),
        duration,
      },
      mediaPath,
      mediaKind,
    };
  });
}

export const STORYBOARD_CSV_COLUMNS = [
  "序号",
  "原文",
  "主体",
  "画面提示词",
  "时长",
  "状态",
  "素材类型",
  "素材路径",
] as const;

export function storyboardCsvRecords(storyboards: Storyboard[]): Array<Record<string, string>> {
  return [...storyboards]
    .sort((left, right) => left.index - right.index)
    .map((item) => {
      const mediaPath = item.videoPath ?? latestImagePath(item) ?? "";
      return {
        序号: String(item.index + 1),
        原文: item.originalText,
        主体: item.subjects.join("，"),
        画面提示词: item.prompt,
        时长: String(item.duration),
        状态: item.status,
        素材类型: mediaPath ? (item.videoPath ? "video" : "photo") : "",
        素材路径: mediaPath,
      };
    });
}

export function storyboardPlainText(storyboards: Storyboard[]): string {
  return [...storyboards]
    .sort((left, right) => left.index - right.index)
    .map((item) => item.originalText.trim())
    .filter(Boolean)
    .join("\r\n\r\n");
}

export function buildJianyingExportInput(
  project: Project,
  storyboards: Storyboard[],
  draftRoot: string,
  overwrite = true,
): JianyingExportInput {
  const visualClips: NonNullable<JianyingExportInput["visualClips"]> = [];
  const blackClips: NonNullable<JianyingExportInput["blackClips"]> = [];
  let cursorUs = 0;

  for (const item of [...storyboards].sort((left, right) => left.index - right.index)) {
    const durationUs = Math.max(1_000, Math.round(item.duration * 1_000_000));
    const videoPath = item.videoPath?.trim() || null;
    const mediaPath = videoPath || latestImagePath(item);
    if (mediaPath) {
      visualClips.push({
        filePath: mediaPath,
        durationUs,
        startUs: cursorUs,
        kind: videoPath ? "video" : "photo",
      });
    } else {
      blackClips.push({ durationUs, startUs: cursorUs });
    }
    cursorUs += durationUs;
  }

  return {
    draftRoot,
    projectName: project.name,
    timelineDurationUs: cursorUs,
    preserveVisualSpeed: true,
    visualClips,
    blackClips,
    audioClips: project.audioPath && cursorUs > 0
      ? [{ filePath: project.audioPath, durationUs: cursorUs, startUs: 0 }]
      : [],
    copyMaterials: true,
    overwrite,
  };
}

export function buildSrtDrivenJianyingExportPlan(
  project: Project,
  storyboards: Storyboard[],
  draftRoot: string,
  cues: SrtCue[],
  overwrite = true,
  minimumMatchRate = 0.6,
): SrtDrivenJianyingExportPlan {
  if (cues.length === 0) throw new Error("字幕文件解析为空，请检查 SRT 格式");
  const match = matchStoryboardsToSrt(storyboards, cues);
  if (match.matchRate < minimumMatchRate) {
    throw new Error(`字幕与项目原文匹配度仅 ${(match.matchRate * 100).toFixed(0)}%，可能字幕选错，已取消导出`);
  }

  const timingByStoryboardIndex = new Map(match.timings.map((timing) => [timing.storyboardIndex, timing]));
  const visualClips: NonNullable<JianyingExportInput["visualClips"]> = [];
  const blackClips: NonNullable<JianyingExportInput["blackClips"]> = [];
  let sequentialStartUs = 0;
  for (const item of [...storyboards].sort((left, right) => left.index - right.index)) {
    const sourceDurationUs = Math.max(1_000, Math.round(item.duration * 1_000_000));
    const timing = timingByStoryboardIndex.get(item.index);
    const requestedStartUs = timing ? timing.startUs : sequentialStartUs;
    const startUs = Math.max(sequentialStartUs, requestedStartUs);
    const durationUs = timing
      ? Math.max(1_000, timing.endUs - startUs)
      : sourceDurationUs;
    const videoPath = item.videoPath?.trim() || null;
    const mediaPath = videoPath || latestImagePath(item);
    if (mediaPath) {
      visualClips.push({
        filePath: mediaPath,
        durationUs,
        sourceDurationUs,
        startUs,
        kind: videoPath ? "video" : "photo",
      });
    } else {
      blackClips.push({ durationUs, startUs });
    }
    sequentialStartUs = startUs + durationUs;
  }

  const subtitleEndUs = cues.reduce((maximum, cue) => Math.max(maximum, cue.endUs), 0);
  const timelineEndUs = Math.max(sequentialStartUs, subtitleEndUs);
  return {
    input: {
      draftRoot,
      projectName: project.name,
      timelineDurationUs: timelineEndUs,
      visualClips,
      blackClips,
      audioClips: project.audioPath && timelineEndUs > 0
        ? [{ filePath: project.audioPath, durationUs: timelineEndUs, startUs: 0 }]
        : [],
      subtitles: cues.map((cue) => ({ ...cue })),
      copyMaterials: true,
      overwrite,
    },
    match,
  };
}

export function safeExportName(projectName: string, extension: "txt" | "csv"): string {
  let base = projectName.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "");
  if (!base) base = "project";
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) base = `_${base}`;
  return `${base.slice(0, 120)}.${extension}`;
}
