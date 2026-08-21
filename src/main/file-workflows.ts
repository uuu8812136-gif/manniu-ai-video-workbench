import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import mammoth from "mammoth";
import Papa from "papaparse";
import type { ImportedSrtFile, SrtCue } from "../shared/contracts";

export type SupportedTextEncoding = "utf-8" | "utf-16le" | "utf-16be" | "gb18030";

export type DecodedText = {
  text: string;
  encoding: SupportedTextEncoding;
  hadBom: boolean;
};

export type ImportedDocument = DecodedText & {
  path: string;
  format: "txt" | "docx";
  warnings: string[];
};

export type CsvRecord = Record<string, string>;

export type CsvIssue = {
  type: string;
  code: string;
  message: string;
  row?: number;
};

export type CsvParseResult = {
  columns: string[];
  rows: CsvRecord[];
  errors: CsvIssue[];
  encoding?: SupportedTextEncoding;
};

export type SrtParseResult = {
  cues: SrtCue[];
  warnings: string[];
};

const MAX_SRT_BYTES = 32 * 1024 * 1024;

export class UnsupportedTextEncodingError extends Error {
  constructor(message = "文件不是受支持的 UTF-8、UTF-16 或 GB18030 文本") {
    super(message);
    this.name = "UnsupportedTextEncodingError";
  }
}

function hasPrefix(buffer: Uint8Array, bytes: number[]): boolean {
  return bytes.every((byte, index) => buffer[index] === byte);
}

function decodeWith(buffer: Uint8Array, encoding: SupportedTextEncoding, offset = 0): string {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(buffer.subarray(offset));
  } catch (error) {
    throw new UnsupportedTextEncodingError(
      `无法按 ${encoding} 解码文本: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function likelyUtf16(buffer: Uint8Array): "utf-16le" | "utf-16be" | null {
  if (buffer.length < 4 || buffer.length % 2 !== 0) return null;

  const sampleLength = Math.min(buffer.length, 4_096);
  let evenZeros = 0;
  let oddZeros = 0;
  let pairs = 0;
  for (let index = 0; index + 1 < sampleLength; index += 2) {
    if (buffer[index] === 0) evenZeros += 1;
    if (buffer[index + 1] === 0) oddZeros += 1;
    pairs += 1;
  }
  if (pairs === 0) return null;

  if (oddZeros / pairs > 0.3 && evenZeros / pairs < 0.1) return "utf-16le";
  if (evenZeros / pairs > 0.3 && oddZeros / pairs < 0.1) return "utf-16be";
  return null;
}

export function decodeText(buffer: Uint8Array): DecodedText {
  if (hasPrefix(buffer, [0xef, 0xbb, 0xbf])) {
    return { text: decodeWith(buffer, "utf-8", 3), encoding: "utf-8", hadBom: true };
  }
  if (hasPrefix(buffer, [0xff, 0xfe])) {
    return { text: decodeWith(buffer, "utf-16le", 2), encoding: "utf-16le", hadBom: true };
  }
  if (hasPrefix(buffer, [0xfe, 0xff])) {
    return { text: decodeWith(buffer, "utf-16be", 2), encoding: "utf-16be", hadBom: true };
  }

  const utf16 = likelyUtf16(buffer);
  if (utf16) return { text: decodeWith(buffer, utf16), encoding: utf16, hadBom: false };

  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(buffer),
      encoding: "utf-8",
      hadBom: false,
    };
  } catch {
    return { text: decodeWith(buffer, "gb18030"), encoding: "gb18030", hadBom: false };
  }
}

export async function readTextFile(filePath: string): Promise<DecodedText> {
  return decodeText(await readFile(resolve(filePath)));
}

function parseSrtTimestamp(value: string): number | null {
  const match = value.match(/^(\d+):([0-5]\d):([0-5]\d)[,.](\d{1,3})$/u);
  if (!match) return null;
  const milliseconds = Number(match[4].padEnd(3, "0"));
  return ((Number(match[1]) * 3_600 + Number(match[2]) * 60 + Number(match[3])) * 1_000 + milliseconds) * 1_000;
}

export function parseSrt(content: string): SrtParseResult {
  const normalized = content.replace(/^\ufeff/u, "").replace(/\r\n?/gu, "\n");
  const blocks = normalized.split(/\n[\t ]*\n+/u);
  const cues: SrtCue[] = [];
  const warnings: string[] = [];

  for (const [blockIndex, block] of blocks.entries()) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) {
      warnings.push(`第 ${blockIndex + 1} 段缺少时间轴，已跳过`);
      continue;
    }
    const timing = lines[timingIndex].match(
      /^(\d+:[0-5]\d:[0-5]\d[,.]\d{1,3})\s*-->\s*(\d+:[0-5]\d:[0-5]\d[,.]\d{1,3})(?:\s+.*)?$/u,
    );
    const startUs = timing ? parseSrtTimestamp(timing[1]) : null;
    const endUs = timing ? parseSrtTimestamp(timing[2]) : null;
    const text = lines.slice(timingIndex + 1).join("");
    if (startUs == null || endUs == null || endUs <= startUs || !text) {
      warnings.push(`第 ${blockIndex + 1} 段格式无效，已跳过`);
      continue;
    }
    cues.push({ text, startUs, endUs });
  }

  return { cues, warnings };
}

export async function readSrtFile(filePath: string): Promise<ImportedSrtFile> {
  if (!filePath.trim()) throw new Error("项目未绑定字幕文件");
  const absolutePath = resolve(filePath);
  if (extname(absolutePath).toLowerCase() !== ".srt") throw new Error("自动剪辑只支持 SRT 字幕文件");
  const metadata = await stat(absolutePath);
  if (!metadata.isFile()) throw new Error("字幕路径不是普通文件");
  if (metadata.size > MAX_SRT_BYTES) throw new Error("字幕文件超过 32 MB，已拒绝读取");
  const decoded = await readTextFile(absolutePath);
  return {
    path: absolutePath,
    ...parseSrt(decoded.text),
    encoding: decoded.encoding,
    hadBom: decoded.hadBom,
  };
}

export async function readDocument(filePath: string): Promise<ImportedDocument> {
  const absolutePath = resolve(filePath);
  const extension = extname(absolutePath).toLowerCase();
  if (extension === ".txt") {
    return {
      ...(await readTextFile(absolutePath)),
      path: absolutePath,
      format: "txt",
      warnings: [],
    };
  }
  if (extension === ".docx") {
    const result = await mammoth.extractRawText({ path: absolutePath });
    return {
      text: result.value,
      encoding: "utf-8",
      hadBom: false,
      path: absolutePath,
      format: "docx",
      warnings: result.messages.map((message) => message.message),
    };
  }
  throw new Error(`不支持的文档格式: ${extension || basename(absolutePath)}`);
}

export function parseCsvRecords(content: string): CsvParseResult {
  const normalized = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const matrix = Papa.parse<string[]>(normalized, {
    header: false,
    skipEmptyLines: "greedy",
  });
  const firstCell = matrix.data[0]?.[0] ?? "";
  if (matrix.data.length > 0 && !Number.isNaN(Number(firstCell))) {
    const originalColumns = ["序号", "原文", "时长", "画面提示词"];
    const width = Math.max(...matrix.data.map((row) => row.length));
    const columns = Array.from({ length: width }, (_, index) => originalColumns[index] ?? `列${index + 1}`);
    return {
      columns,
      rows: matrix.data.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index] ?? ""]))),
      errors: matrix.errors.map((error) => ({
        type: error.type,
        code: error.code,
        message: error.message,
        ...(typeof error.row === "number" ? { row: error.row } : {}),
      })),
    };
  }
  const parsed = Papa.parse<Record<string, unknown>>(normalized, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.trim(),
  });
  const columns = (parsed.meta.fields ?? []).map((field) => field.trim());
  const rows = parsed.data.map((row) => {
    const normalizedRow: CsvRecord = {};
    for (const column of columns) {
      const value = row[column];
      normalizedRow[column] = value == null ? "" : String(value);
    }
    return normalizedRow;
  });
  return {
    columns,
    rows,
    errors: parsed.errors.map((error) => ({
      type: error.type,
      code: error.code,
      message: error.message,
      ...(typeof error.row === "number" ? { row: error.row } : {}),
    })),
  };
}

export async function readCsvFile(filePath: string): Promise<CsvParseResult> {
  const decoded = await readTextFile(filePath);
  return { ...parseCsvRecords(decoded.text), encoding: decoded.encoding };
}

export function formatCsvRecords(rows: CsvRecord[], columns?: string[]): string {
  const fields = columns ?? Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  return Papa.unparse({ fields, data: rows.map((row) => fields.map((field) => row[field] ?? "")) }, {
    newline: "\r\n",
  });
}

export async function atomicWriteFile(
  targetPath: string,
  data: string | Uint8Array,
): Promise<string> {
  const absolutePath = resolve(targetPath);
  const parent = dirname(absolutePath);
  await mkdir(parent, { recursive: true });
  const temporaryPath = `${absolutePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;

  try {
    handle = await open(temporaryPath, "wx");
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, absolutePath);
    return absolutePath;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function copyFileIntoDirectory(
  sourcePath: string,
  directoryPath: string,
  fileName = basename(sourcePath),
): Promise<string> {
  const source = resolve(sourcePath);
  const directory = resolve(directoryPath);
  if (basename(fileName) !== fileName || !fileName.trim()) throw new Error("复制文件名不能包含目录");
  const [sourceInfo, directoryInfo] = await Promise.all([stat(source), stat(directory)]);
  if (!sourceInfo.isFile()) throw new Error(`复制源不是文件：${source}`);
  if (!directoryInfo.isDirectory()) throw new Error(`复制目标不是目录：${directory}`);
  const destination = resolve(directory, fileName);
  if (dirname(destination) !== directory) throw new Error("复制目标超出指定目录");
  if (source.toLocaleLowerCase() === destination.toLocaleLowerCase()) return destination;
  const staging = `${destination}.${process.pid}.${randomUUID()}.copying`;
  const backup = `${destination}.${process.pid}.${randomUUID()}.backup`;
  let movedExisting = false;
  try {
    await atomicWriteFile(staging, await readFile(source));
    try {
      const destinationInfo = await stat(destination);
      if (!destinationInfo.isFile()) throw new Error(`复制目标已存在且不是文件：${destination}`);
      await rename(destination, backup);
      movedExisting = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(staging, destination);
    if (movedExisting) await unlink(backup).catch(() => undefined);
    return destination;
  } catch (error) {
    await unlink(staging).catch(() => undefined);
    if (movedExisting) await rename(backup, destination).catch(() => undefined);
    throw error;
  }
}

export async function writeTextFileAtomic(
  targetPath: string,
  text: string,
  options: { bom?: boolean } = {},
): Promise<string> {
  return atomicWriteFile(targetPath, `${options.bom ? "\ufeff" : ""}${text}`);
}

export async function writeCsvFileAtomic(
  targetPath: string,
  rows: CsvRecord[],
  options: { columns?: string[]; bom?: boolean } = {},
): Promise<string> {
  return writeTextFileAtomic(targetPath, formatCsvRecords(rows, options.columns), {
    bom: options.bom ?? true,
  });
}

export async function writeJsonFileAtomic(targetPath: string, value: unknown): Promise<string> {
  return atomicWriteFile(targetPath, `${JSON.stringify(value, null, 2)}\n`);
}
