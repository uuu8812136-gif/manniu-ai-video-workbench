import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { writeJsonFileAtomic } from "./file-workflows";
import { probeMedia, type MediaBinaryOptions, type ProbeResult } from "./media";

export type JianyingVisualClip = {
  filePath: string;
  durationUs: number;
  sourceDurationUs?: number;
  startUs?: number;
  width?: number;
  height?: number;
  kind?: "video" | "photo";
};

export type JianyingAudioClip = {
  filePath: string;
  durationUs: number;
  sourceDurationUs?: number;
  startUs?: number;
  volume?: number;
};

export type JianyingSubtitle = {
  text: string;
  startUs: number;
  endUs: number;
};

export type JianyingBlackClip = {
  durationUs: number;
  startUs?: number;
};

export type JianyingExportInput = {
  draftRoot: string;
  projectName: string;
  timelineDurationUs?: number;
  preserveVisualSpeed?: boolean;
  visualClips?: JianyingVisualClip[];
  blackClips?: JianyingBlackClip[];
  audioClips?: JianyingAudioClip[];
  subtitles?: JianyingSubtitle[];
  width?: number;
  height?: number;
  fps?: number;
  copyMaterials?: boolean;
  overwrite?: boolean;
};

export type JianyingExportResult = {
  draftPath: string;
  contentPath: string;
  metaPath: string;
  materialPaths: string[];
  durationUs: number;
  validation: JianyingValidationResult;
};

type MediaProbe = (filePath: string, options?: MediaBinaryOptions) => Promise<ProbeResult>;

export type JianyingValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
  summary: {
    tracks: number;
    segments: number;
    materials: number;
    durationUs: number;
  };
};

type JsonRecord = Record<string, unknown>;

const MATERIAL_GROUPS = [
  "ai_translates", "audio_balances", "audio_effects", "audio_fades", "audio_track_indexes",
  "audios", "beats", "canvases", "chromas", "color_curves", "digital_humans", "drafts",
  "effects", "flowers", "green_screens", "handwrites", "hsl", "images", "log_color_wheels",
  "loudnesses", "manual_deformations", "masks", "material_animations", "material_colors",
  "multi_language_refs", "placeholders", "plugin_effects", "primary_color_wheels",
  "realtime_denoises", "shapes", "smart_crops", "smart_relights", "sound_channel_mappings",
  "speeds", "stickers", "tail_leaders", "text_templates", "texts", "time_marks", "transitions",
  "video_effects", "video_trackings", "videos", "vocal_beautifys", "vocal_separations",
] as const;
const BLACK_PLACEHOLDER_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function id(): string {
  return randomUUID().toUpperCase();
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} 必须是正整数`);
  return value;
}

function nonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} 必须是非负整数`);
  return value;
}

function safeDraftName(name: string): string {
  let value = name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "");
  if (!value || value === "." || value === "..") throw new Error("项目名称不能生成有效的剪映草稿目录名");
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) value = `_${value}`;
  return value.slice(0, 120);
}

function safeMaterialName(name: string, fallbackExtension: string): string {
  let value = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "");
  if (!value) value = `material${fallbackExtension}`;
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) value = `_${value}`;
  return value;
}

function emptyMaterials(): Record<(typeof MATERIAL_GROUPS)[number], unknown[]> {
  const materials = {} as Record<(typeof MATERIAL_GROUPS)[number], unknown[]>;
  for (const key of MATERIAL_GROUPS) materials[key] = [];
  return materials;
}

function timerange(start: number, duration: number): JsonRecord {
  return { start, duration };
}

function baseSegment(materialId: string, startUs: number, durationUs: number): JsonRecord {
  return {
    enable_adjust: true,
    enable_color_correct_adjust: false,
    enable_color_curves: true,
    enable_color_match_adjust: false,
    enable_color_wheels: true,
    enable_lut: true,
    enable_smart_color_adjust: false,
    last_nonzero_volume: 1,
    reverse: false,
    track_attribute: 0,
    track_render_index: 0,
    visible: true,
    id: id(),
    material_id: materialId,
    target_timerange: timerange(startUs, durationUs),
    common_keyframes: [],
    keyframe_refs: [],
  };
}

function mediaSegment(
  materialId: string,
  speedId: string,
  startUs: number,
  durationUs: number,
  sourceDurationUs: number,
  volume: number,
  visual: boolean,
): JsonRecord {
  const segment: JsonRecord = {
    ...baseSegment(materialId, startUs, durationUs),
    source_timerange: timerange(0, sourceDurationUs),
    speed: sourceDurationUs / durationUs,
    volume,
    extra_material_refs: [speedId],
    is_tone_modify: false,
    hdr_settings: visual ? { intensity: 1, mode: 1, nits: 1_000 } : null,
  };
  if (visual) {
    segment.clip = {
      alpha: 1,
      flip: { horizontal: false, vertical: false },
      rotation: 0,
      scale: { x: 1, y: 1 },
      transform: { x: 0, y: 0 },
    };
    segment.uniform_scale = { on: true, value: 1 };
  } else {
    segment.clip = null;
  }
  return segment;
}

function track(type: "video" | "audio" | "text", segments: JsonRecord[]): JsonRecord {
  return {
    attribute: 0,
    flag: 0,
    id: id(),
    is_default_name: true,
    name: "",
    segments,
    type,
  };
}

function crop(): JsonRecord {
  return {
    lower_left_x: 0,
    lower_left_y: 1,
    lower_right_x: 1,
    lower_right_y: 1,
    upper_left_x: 0,
    upper_left_y: 0,
    upper_right_x: 1,
    upper_right_y: 0,
  };
}

function textMaterial(materialId: string, text: string): JsonRecord {
  const content = {
    styles: [
      {
        fill: {
          alpha: 1,
          content: { render_type: "solid", solid: { alpha: 1, color: [1, 1, 1] } },
        },
        range: [0, text.length],
        size: 8,
        bold: false,
        italic: false,
        underline: false,
        strokes: [],
      },
    ],
    text,
  };
  return {
    id: materialId,
    content: JSON.stringify(content),
    typesetting: 0,
    alignment: 1,
    letter_spacing: 0,
    line_spacing: 0.02,
    line_feed: 1,
    line_max_width: 0.82,
    force_apply_line_max_width: false,
    check_flag: 7,
    type: "subtitle",
    global_alpha: 1,
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function mediaDurationUs(probe: ProbeResult): number | null {
  const formatDuration = isRecord(probe.format) ? positiveNumber(probe.format.duration) : null;
  const streamDurations = (probe.streams ?? [])
    .map((stream) => positiveNumber(stream.duration))
    .filter((duration): duration is number => duration !== null);
  const durationSeconds = formatDuration ?? (streamDurations.length > 0 ? Math.max(...streamDurations) : null);
  return durationSeconds === null ? null : Math.max(1, Math.round(durationSeconds * 1_000_000));
}

function videoDimensions(probe: ProbeResult): { width?: number; height?: number } {
  const video = (probe.streams ?? []).find((stream) => stream.codec_type === "video") ?? {};
  const width = positiveNumber(video.width);
  const height = positiveNumber(video.height);
  return {
    ...(width === null ? {} : { width: Math.round(width) }),
    ...(height === null ? {} : { height: Math.round(height) }),
  };
}

export async function hydrateJianyingMediaMetadata(
  input: JianyingExportInput,
  options: MediaBinaryOptions = {},
  probe: MediaProbe = probeMedia,
): Promise<JianyingExportInput> {
  let visualClips = await Promise.all((input.visualClips ?? []).map(async (clip, index) => {
    const kind = clip.kind ?? (/\.(?:jpe?g|png|webp|bmp)$/i.test(clip.filePath) ? "photo" : "video");
    if (kind === "photo") return { ...clip, kind };
    const metadata = await probe(clip.filePath, options);
    const sourceDurationUs = mediaDurationUs(metadata);
    if (sourceDurationUs === null) {
      throw new Error(`无法读取视频素材 ${index + 1} 的真实时长: ${clip.filePath}`);
    }
    return { ...clip, kind, sourceDurationUs, ...videoDimensions(metadata) };
  }));
  let blackClips = (input.blackClips ?? []).map((clip) => ({ ...clip }));
  let timelineDurationUs = input.timelineDurationUs;
  if (input.preserveVisualSpeed && visualClips.length + blackClips.length > 0) {
    let originalEndUs = 0;
    let adjustedEndUs = 0;
    const slots = [
      ...visualClips.map((clip, index) => ({ type: "visual" as const, index, startUs: clip.startUs ?? 0 })),
      ...blackClips.map((clip, index) => ({ type: "black" as const, index, startUs: clip.startUs ?? 0 })),
    ].sort((left, right) => left.startUs - right.startUs || (left.type === "black" ? 1 : -1));
    for (const slot of slots) {
      const originalClip = slot.type === "visual" ? visualClips[slot.index] : blackClips[slot.index];
      const originalStartUs = originalClip.startUs ?? originalEndUs;
      const gapUs = Math.max(0, originalStartUs - originalEndUs);
      const startUs = adjustedEndUs + gapUs;
      const durationUs = slot.type === "visual"
        ? (visualClips[slot.index].kind === "video"
            ? (visualClips[slot.index].sourceDurationUs ?? visualClips[slot.index].durationUs)
            : visualClips[slot.index].durationUs)
        : blackClips[slot.index].durationUs;
      originalEndUs = originalStartUs + originalClip.durationUs;
      adjustedEndUs = startUs + durationUs;
      if (slot.type === "visual") visualClips[slot.index] = { ...visualClips[slot.index], startUs, durationUs };
      else blackClips[slot.index] = { ...blackClips[slot.index], startUs, durationUs };
    }
    const trailingGapUs = Math.max(0, (input.timelineDurationUs ?? originalEndUs) - originalEndUs);
    timelineDurationUs = adjustedEndUs + trailingGapUs;
  }
  const audioClips = await Promise.all((input.audioClips ?? []).map(async (clip, index) => {
    const metadata = await probe(clip.filePath, options);
    const sourceDurationUs = mediaDurationUs(metadata);
    if (sourceDurationUs === null) {
      throw new Error(`无法读取音频素材 ${index + 1} 的真实时长: ${clip.filePath}`);
    }
    return { ...clip, sourceDurationUs };
  }));
  return { ...input, timelineDurationUs, visualClips, blackClips, audioClips };
}

function asRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

async function readJsonRecord(filePath: string): Promise<JsonRecord> {
  const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
  if (!isRecord(parsed)) throw new Error(`${basename(filePath)} 顶层必须是 JSON 对象`);
  return parsed;
}

async function requireFile(filePath: string): Promise<void> {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error(`素材路径不是文件: ${filePath}`);
}

async function prepareMaterial(
  sourcePath: string,
  index: number,
  stagingMaterialsPath: string,
  finalMaterialsPath: string,
  copyMaterials: boolean,
): Promise<{ jsonPath: string; stagedPath: string | null }> {
  const absoluteSource = resolve(sourcePath);
  await requireFile(absoluteSource);
  if (!copyMaterials) return { jsonPath: absoluteSource, stagedPath: null };

  const sourceName = safeMaterialName(basename(absoluteSource), extname(absoluteSource));
  const fileName = `${String(index + 1).padStart(4, "0")}-${sourceName}`;
  const stagedPath = join(stagingMaterialsPath, fileName);
  await copyFile(absoluteSource, stagedPath);
  return { jsonPath: join(finalMaterialsPath, fileName), stagedPath };
}

function createContent(projectName: string, width: number, height: number, fps: number): JsonRecord {
  const timestamp = Math.floor(Date.now() / 1_000);
  return {
    canvas_config: { height, ratio: "original", width },
    color_space: 0,
    config: {
      adjust_max_index: 1,
      attachment_info: [],
      combination_max_index: 1,
      export_range: null,
      extract_audio_last_index: 1,
      lyrics_recognition_id: "",
      lyrics_sync: true,
      lyrics_taskinfo: [],
      maintrack_adsorb: true,
      material_save_mode: 0,
      multi_language_current: "none",
      multi_language_list: [],
      multi_language_main: "none",
      multi_language_mode: "none",
      original_sound_last_index: 1,
      record_audio_last_index: 1,
      sticker_max_index: 1,
      subtitle_keywords_config: null,
      subtitle_recognition_id: "",
      subtitle_sync: true,
      subtitle_taskinfo: [],
      system_font_list: [],
      video_mute: false,
      zoom_info_params: null,
    },
    cover: null,
    create_time: timestamp,
    duration: 0,
    extra_info: null,
    fps,
    free_render_index_mode_on: false,
    group_container: null,
    id: id(),
    keyframe_graph_list: [],
    keyframes: { adjusts: [], audios: [], effects: [], filters: [], handwrites: [], stickers: [], texts: [], videos: [] },
    last_modified_platform: { app_id: 3704, app_source: "lv", app_version: "5.9.0", os: "windows" },
    platform: { app_id: 3704, app_source: "lv", app_version: "5.9.0", os: "windows" },
    materials: emptyMaterials(),
    mutable_config: null,
    name: projectName,
    new_version: "110.0.0",
    relationships: [],
    render_index_track_mode_on: false,
    retouch_cover: null,
    source: "default",
    static_cover_image_path: "",
    time_marks: null,
    tracks: [],
    update_time: timestamp,
    version: 360000,
  };
}

function createMeta(projectName: string, draftId: string, draftPath: string, draftRoot: string, durationUs: number): JsonRecord {
  return {
    cloud_package_completed_time: "",
    draft_cloud_capcut_purchase_info: "",
    draft_cloud_last_action_download: false,
    draft_cloud_materials: [],
    draft_cloud_purchase_info: "",
    draft_cloud_template_id: "",
    draft_cloud_tutorial_info: "",
    draft_cloud_videocut_purchase_info: "",
    draft_cover: "",
    draft_deeplink_url: "",
    draft_enterprise_info: { draft_enterprise_extra: "", draft_enterprise_id: "", draft_enterprise_name: "", enterprise_material: [] },
    draft_fold_path: draftPath,
    draft_id: draftId,
    draft_is_ai_packaging_used: false,
    draft_is_ai_shorts: false,
    draft_is_ai_translate: false,
    draft_is_article_video_draft: false,
    draft_is_from_deeplink: "false",
    draft_is_invisible: false,
    draft_materials: [0, 1, 2, 3, 6, 7, 8].map((type) => ({ type, value: [] })),
    draft_materials_copied_info: [],
    draft_name: projectName,
    draft_new_version: "110.0.0",
    draft_removable_storage_device: "",
    draft_root_path: draftRoot,
    draft_segment_extra_info: [],
    draft_type: "",
    tm_draft_cloud_completed: "",
    tm_draft_cloud_modified: 0,
    tm_draft_removed: 0,
    tm_duration: durationUs,
  };
}

export async function exportJianyingDraft(input: JianyingExportInput): Promise<JianyingExportResult> {
  const projectName = input.projectName.trim();
  if (!projectName) throw new Error("项目名称不能为空");
  const width = positiveInteger(input.width ?? 1_920, "width");
  const height = positiveInteger(input.height ?? 1_080, "height");
  const fps = positiveInteger(input.fps ?? 30, "fps");
  const draftRoot = resolve(input.draftRoot);
  const draftPath = join(draftRoot, safeDraftName(projectName));
  const stagingPath = join(draftRoot, `.${safeDraftName(projectName)}.${randomUUID()}.staging`);
  const backupPath = `${draftPath}.${randomUUID()}.backup`;
  const stagingMaterialsPath = join(stagingPath, "materials");
  const finalMaterialsPath = join(draftPath, "materials");
  const copyMaterials = input.copyMaterials ?? true;
  const content = createContent(projectName, width, height, fps);
  const materials = content.materials as Record<string, unknown[]>;
  const tracks = content.tracks as JsonRecord[];
  const materialPaths: string[] = [];
  let nextMaterialIndex = 0;

  await mkdir(stagingMaterialsPath, { recursive: true });
  try {
    const videoSegments: JsonRecord[] = [];
    const blackClips = (input.blackClips?.length ?? 0) > 0
      ? input.blackClips!
      : (input.visualClips?.length ?? 0) === 0 && input.timelineDurationUs !== undefined
        ? [{ startUs: 0, durationUs: positiveInteger(input.timelineDurationUs, "timelineDurationUs") }]
        : [];
    let sequentialStart = 0;
    for (const [index, clip] of (input.visualClips ?? []).entries()) {
      const durationUs = positiveInteger(clip.durationUs, `visualClips[${index}].durationUs`);
      const sourceDurationUs = positiveInteger(clip.sourceDurationUs ?? durationUs, `visualClips[${index}].sourceDurationUs`);
      const startUs = clip.startUs == null
        ? sequentialStart
        : nonnegativeInteger(clip.startUs, `visualClips[${index}].startUs`);
      sequentialStart = startUs + durationUs;
      const prepared = await prepareMaterial(
        clip.filePath,
        nextMaterialIndex++,
        stagingMaterialsPath,
        finalMaterialsPath,
        copyMaterials,
      );
      materialPaths.push(prepared.jsonPath);
      const materialId = id();
      const speedId = id();
      const kind = clip.kind ?? (/\.(?:jpe?g|png|webp|bmp)$/i.test(clip.filePath) ? "photo" : "video");
      materials.videos.push({
        audio_fade: null,
        category_id: "",
        category_name: "local",
        check_flag: 63_487,
        crop: crop(),
        crop_ratio: "free",
        crop_scale: 1,
        duration: sourceDurationUs,
        height: positiveInteger(clip.height ?? height, `visualClips[${index}].height`),
        id: materialId,
        local_material_id: materialId,
        material_id: materialId,
        material_name: basename(clip.filePath),
        media_path: "",
        path: prepared.jsonPath,
        type: kind,
        width: positiveInteger(clip.width ?? width, `visualClips[${index}].width`),
      });
      materials.speeds.push({ curve_speed: null, id: speedId, mode: 0, speed: sourceDurationUs / durationUs, type: "speed" });
      videoSegments.push(mediaSegment(materialId, speedId, startUs, durationUs, sourceDurationUs, 1, true));
    }
    let blackPlaceholderPath: string | null = null;
    for (const [index, clip] of blackClips.entries()) {
      const durationUs = positiveInteger(clip.durationUs, `blackClips[${index}].durationUs`);
      const startUs = clip.startUs == null
        ? sequentialStart
        : nonnegativeInteger(clip.startUs, `blackClips[${index}].startUs`);
      sequentialStart = startUs + durationUs;
      if (blackPlaceholderPath === null) {
        const materialName = `${String(nextMaterialIndex++).padStart(4, "0")}_black-placeholder.png`;
        await writeFile(join(stagingMaterialsPath, materialName), Buffer.from(BLACK_PLACEHOLDER_PNG, "base64"));
        blackPlaceholderPath = join(finalMaterialsPath, materialName);
        materialPaths.push(blackPlaceholderPath);
      }
      const materialId = id();
      const speedId = id();
      materials.videos.push({
        audio_fade: null,
        category_id: "",
        category_name: "local",
        check_flag: 63_487,
        crop: crop(),
        crop_ratio: "free",
        crop_scale: 1,
        duration: durationUs,
        height,
        id: materialId,
        local_material_id: materialId,
        material_id: materialId,
        material_name: "black-placeholder.png",
        media_path: "",
        path: blackPlaceholderPath,
        type: "photo",
        width,
      });
      materials.speeds.push({ curve_speed: null, id: speedId, mode: 0, speed: 1, type: "speed" });
      videoSegments.push(mediaSegment(materialId, speedId, startUs, durationUs, durationUs, 1, true));
    }
    videoSegments.sort((left, right) => {
      const leftRange = left.target_timerange as JsonRecord;
      const rightRange = right.target_timerange as JsonRecord;
      return Number(leftRange.start) - Number(rightRange.start);
    });
    let previousVideoEndUs = 0;
    for (const segment of videoSegments) {
      const range = segment.target_timerange as JsonRecord;
      const startUs = Number(range.start);
      const durationUs = Number(range.duration);
      if (startUs < previousVideoEndUs) range.start = previousVideoEndUs;
      previousVideoEndUs = Number(range.start) + durationUs;
    }
    if (videoSegments.length > 0) tracks.push(track("video", videoSegments));

    const audioSegments: JsonRecord[] = [];
    sequentialStart = 0;
    for (const [index, clip] of (input.audioClips ?? []).entries()) {
      const durationUs = positiveInteger(clip.durationUs, `audioClips[${index}].durationUs`);
      const sourceDurationUs = positiveInteger(clip.sourceDurationUs ?? durationUs, `audioClips[${index}].sourceDurationUs`);
      const startUs = clip.startUs == null
        ? sequentialStart
        : nonnegativeInteger(clip.startUs, `audioClips[${index}].startUs`);
      sequentialStart = startUs + durationUs;
      const volume = clip.volume ?? 1;
      if (!Number.isFinite(volume) || volume < 0 || volume > 10) throw new TypeError(`audioClips[${index}].volume 必须在 0 到 10 之间`);
      const prepared = await prepareMaterial(
        clip.filePath,
        nextMaterialIndex++,
        stagingMaterialsPath,
        finalMaterialsPath,
        copyMaterials,
      );
      materialPaths.push(prepared.jsonPath);
      const materialId = id();
      const speedId = id();
      materials.audios.push({
        app_id: 0,
        category_id: "",
        category_name: "local",
        check_flag: 3,
        copyright_limit_type: "none",
        duration: sourceDurationUs,
        effect_id: "",
        formula_id: "",
        id: materialId,
        local_material_id: materialId,
        music_id: materialId,
        name: basename(clip.filePath),
        path: prepared.jsonPath,
        source_platform: 0,
        type: "extract_music",
        wave_points: [],
      });
      materials.speeds.push({ curve_speed: null, id: speedId, mode: 0, speed: sourceDurationUs / durationUs, type: "speed" });
      audioSegments.push(mediaSegment(materialId, speedId, startUs, durationUs, sourceDurationUs, volume, false));
    }
    if (audioSegments.length > 0) tracks.push(track("audio", audioSegments));

    const textSegments: JsonRecord[] = [];
    for (const [index, subtitle] of (input.subtitles ?? []).entries()) {
      const startUs = nonnegativeInteger(subtitle.startUs, `subtitles[${index}].startUs`);
      const endUs = positiveInteger(subtitle.endUs, `subtitles[${index}].endUs`);
      if (endUs <= startUs) throw new TypeError(`subtitles[${index}] 的 endUs 必须大于 startUs`);
      if (!subtitle.text.trim()) throw new TypeError(`subtitles[${index}].text 不能为空`);
      const durationUs = endUs - startUs;
      const materialId = id();
      const speedId = id();
      materials.texts.push(textMaterial(materialId, subtitle.text));
      materials.speeds.push({ curve_speed: null, id: speedId, mode: 0, speed: 1, type: "speed" });
      const segment = mediaSegment(materialId, speedId, startUs, durationUs, durationUs, 1, true);
      segment.source_timerange = null;
      textSegments.push(segment);
    }
    if (textSegments.length > 0) tracks.push(track("text", textSegments));

    const trackDurationUs = tracks.reduce((maximum, item) => {
      const ends = asRecords(item.segments).map((segment) => {
        const range = isRecord(segment.target_timerange) ? segment.target_timerange : {};
        return Number(range.start ?? 0) + Number(range.duration ?? 0);
      });
      return Math.max(maximum, ...ends, 0);
    }, 0);
    const durationUs = input.timelineDurationUs === undefined
      ? trackDurationUs
      : Math.max(trackDurationUs, positiveInteger(input.timelineDurationUs, "timelineDurationUs"));
    content.duration = durationUs;
    const meta = createMeta(projectName, String(content.id), draftPath, draftRoot, durationUs);
    await writeJsonFileAtomic(join(stagingPath, "draft_content.json"), content);
    await writeJsonFileAtomic(join(stagingPath, "draft_meta_info.json"), meta);

    const stagingValidation = await validateJianyingDraft(stagingPath, {
      expectedMaterialBasePath: copyMaterials ? stagingMaterialsPath : undefined,
      pathAliases: copyMaterials ? new Map([[finalMaterialsPath, stagingMaterialsPath]]) : undefined,
    });
    if (!stagingValidation.valid) {
      throw new Error(`剪映草稿校验失败: ${stagingValidation.errors.join("; ")}`);
    }

    let movedOldDraft = false;
    try {
      try {
        await stat(draftPath);
        if (!input.overwrite) throw new Error(`剪映草稿已存在: ${draftPath}`);
        await rename(draftPath, backupPath);
        movedOldDraft = true;
      } catch (error) {
        const code = isRecord(error) ? error.code : undefined;
        if (code !== "ENOENT") throw error;
      }
      await rename(stagingPath, draftPath);
      if (movedOldDraft) await rm(backupPath, { recursive: true, force: true }).catch(() => undefined);
    } catch (error) {
      if (movedOldDraft) await rename(backupPath, draftPath).catch(() => undefined);
      throw error;
    }

    const validation = await validateJianyingDraft(draftPath);
    if (!validation.valid) throw new Error(`剪映草稿最终校验失败: ${validation.errors.join("; ")}`);
    return {
      draftPath,
      contentPath: join(draftPath, "draft_content.json"),
      metaPath: join(draftPath, "draft_meta_info.json"),
      materialPaths,
      durationUs,
      validation,
    };
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

type ValidationOptions = {
  expectedMaterialBasePath?: string;
  pathAliases?: Map<string, string>;
};

function resolveAlias(filePath: string, aliases?: Map<string, string>): string {
  if (!aliases) return filePath;
  for (const [from, to] of aliases) {
    const relation = relative(from, filePath);
    if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) return join(to, relation);
  }
  return filePath;
}

export async function validateJianyingDraft(
  draftPath: string,
  options: ValidationOptions = {},
): Promise<JianyingValidationResult> {
  const absoluteDraftPath = resolve(draftPath);
  const errors: string[] = [];
  const warnings: string[] = [];
  let content: JsonRecord;
  let meta: JsonRecord;
  try {
    [content, meta] = await Promise.all([
      readJsonRecord(join(absoluteDraftPath, "draft_content.json")),
      readJsonRecord(join(absoluteDraftPath, "draft_meta_info.json")),
    ]);
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : String(error)],
      warnings,
      summary: { tracks: 0, segments: 0, materials: 0, durationUs: 0 },
    };
  }

  if (typeof content.id !== "string" || content.id.length === 0) errors.push("draft_content.id 缺失");
  if (meta.draft_id !== content.id) errors.push("draft_meta_info.draft_id 与 draft_content.id 不一致");
  if (meta.draft_name !== content.name) errors.push("草稿名称在两个 JSON 文件中不一致");
  if (!isRecord(content.canvas_config)) errors.push("canvas_config 缺失");

  const materialGroups = isRecord(content.materials) ? content.materials : {};
  if (!isRecord(content.materials)) errors.push("materials 缺失");
  const allMaterialIds = new Set<string>();
  const materialIdsByGroup = new Map<string, Set<string>>();
  const mediaPaths: string[] = [];
  let materialCount = 0;
  for (const group of MATERIAL_GROUPS) {
    const values = materialGroups[group];
    if (!Array.isArray(values)) {
      errors.push(`materials.${group} 必须是数组`);
      continue;
    }
    materialCount += values.length;
    const groupIds = new Set<string>();
    materialIdsByGroup.set(group, groupIds);
    for (const [materialIndex, value] of values.entries()) {
      if (!isRecord(value)) {
        errors.push(`materials.${group}[${materialIndex}] 必须是对象`);
        continue;
      }
      const material = value;
      if (typeof material.id === "string" && material.id.length > 0) {
        if (allMaterialIds.has(material.id)) errors.push(`素材 ID 重复: ${material.id}`);
        allMaterialIds.add(material.id);
        groupIds.add(material.id);
      } else if (["videos", "audios", "texts", "speeds"].includes(group)) {
        errors.push(`materials.${group}[${materialIndex}].id 缺失`);
      }
      if ((group === "videos" || group === "audios") && typeof material.path === "string") {
        mediaPaths.push(material.path);
      }
    }
  }

  const tracks = asRecords(content.tracks);
  if (!Array.isArray(content.tracks)) errors.push("tracks 必须是数组");
  let segmentCount = 0;
  let maximumEnd = 0;
  for (const [trackIndex, currentTrack] of tracks.entries()) {
    const type = currentTrack.type;
    const segments = asRecords(currentTrack.segments);
    segmentCount += segments.length;
    let previousEnd = 0;
    for (const [segmentIndex, segment] of segments.entries()) {
      const prefix = `tracks[${trackIndex}].segments[${segmentIndex}]`;
      if (typeof segment.id !== "string") errors.push(`${prefix}.id 缺失`);
      if (typeof segment.material_id !== "string" || !allMaterialIds.has(segment.material_id)) {
        errors.push(`${prefix}.material_id 未引用有效素材`);
      } else {
        const expectedGroup = type === "video" ? "videos" : type === "audio" ? "audios" : type === "text" ? "texts" : null;
        if (expectedGroup && !materialIdsByGroup.get(expectedGroup)?.has(segment.material_id)) {
          errors.push(`${prefix}.material_id 与 ${String(type)} 轨道类型不匹配`);
        }
      }
      const range = isRecord(segment.target_timerange) ? segment.target_timerange : null;
      const start = range ? Number(range.start) : Number.NaN;
      const duration = range ? Number(range.duration) : Number.NaN;
      if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(duration) || duration <= 0) {
        errors.push(`${prefix}.target_timerange 无效`);
        continue;
      }
      if (start < previousEnd) errors.push(`${prefix} 与同轨道前一个片段重叠或顺序错误`);
      previousEnd = start + duration;
      maximumEnd = Math.max(maximumEnd, previousEnd);
      if (Array.isArray(segment.extra_material_refs)) {
        for (const reference of segment.extra_material_refs) {
          if (typeof reference !== "string" || !allMaterialIds.has(reference)) {
            errors.push(`${prefix}.extra_material_refs 含无效引用`);
          }
        }
      }
    }
    if (!["video", "audio", "text"].includes(String(type))) warnings.push(`未知轨道类型: ${String(type)}`);
  }

  const declaredDuration = Number(content.duration);
  if (!Number.isSafeInteger(declaredDuration) || declaredDuration < maximumEnd) {
    errors.push("draft_content.duration 小于时间轴结束位置或不是有效整数");
  }
  if (Number(meta.tm_duration) !== declaredDuration) errors.push("tm_duration 与 draft_content.duration 不一致");

  for (const mediaPath of mediaPaths) {
    const actualPath = resolveAlias(mediaPath, options.pathAliases);
    try {
      await requireFile(actualPath);
    } catch {
      errors.push(`素材文件不存在: ${mediaPath}`);
    }
    if (options.expectedMaterialBasePath) {
      const relation = relative(options.expectedMaterialBasePath, actualPath);
      if (relation.startsWith("..") || isAbsolute(relation)) warnings.push(`素材位于草稿目录之外: ${mediaPath}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    summary: { tracks: tracks.length, segments: segmentCount, materials: materialCount, durationUs: declaredDuration || 0 },
  };
}
