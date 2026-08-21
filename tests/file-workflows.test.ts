import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  atomicWriteFile,
  decodeText,
  formatCsvRecords,
  parseSrt,
  parseCsvRecords,
  readCsvFile,
  readDocument,
  readTextFile,
  writeCsvFileAtomic,
} from "../src/main/file-workflows";

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeStoredZip(files: Array<{ name: string; content: string }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const data = Buffer.from(file.content, "utf8");
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function minimalDocx(text: string): Buffer {
  return makeStoredZip([
    {
      name: "[Content_Types].xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    },
    {
      name: "_rels/.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    },
    {
      name: "word/document.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
    },
    {
      name: "word/_rels/document.xml.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
    },
  ]);
}

describe("file workflows", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "AI工具 文件测试 "));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("detects UTF-8 BOM and GB18030 text", async () => {
    const utf8 = decodeText(Buffer.from("\ufeff第一章\n你好", "utf8"));
    expect(utf8).toMatchObject({ text: "第一章\n你好", encoding: "utf-8", hadBom: true });

    const gb18030 = Buffer.from([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x0a, 0xc4, 0xe3, 0xba, 0xc3]);
    const gbPath = join(root, "中文 GB18030.txt");
    await writeFile(gbPath, gb18030);
    expect(await readTextFile(gbPath)).toMatchObject({ text: "第一章\n你好", encoding: "gb18030" });
  });

  it("extracts text from a real minimal DOCX package", async () => {
    const docxPath = join(root, "小说 文稿.docx");
    await writeFile(docxPath, minimalDocx("本地 DOCX 可读取"));
    const result = await readDocument(docxPath);
    expect(result.format).toBe("docx");
    expect(result.text.trim()).toBe("本地 DOCX 可读取");
  });

  it("parses SRT timestamps, multiline cues, and malformed-block warnings", () => {
    const result = parseSrt([
      "1",
      "00:00:00,250 --> 00:00:02,500",
      "第一行",
      "第二行",
      "",
      "无时间轴的段落",
      "",
      "3",
      "00:00:03.000 --> 00:00:05.125 align:start",
      "第三行",
    ].join("\r\n"));
    expect(result.cues).toEqual([
      { text: "第一行第二行", startUs: 250_000, endUs: 2_500_000 },
      { text: "第三行", startUs: 3_000_000, endUs: 5_125_000 },
    ]);
    expect(result.warnings).toEqual(["第 2 段缺少时间轴，已跳过"]);
  });

  it("parses and exports quoted CSV without losing Chinese or line breaks", async () => {
    const rows = [
      { 镜号: "1", 文案: "你好，世界", 提示词: "雨夜\n街道" },
      { 镜号: "2", 文案: "他说\"开始\"", 提示词: "室内" },
    ];
    const csv = formatCsvRecords(rows, ["镜号", "文案", "提示词"]);
    const parsed = parseCsvRecords(csv);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual(rows);

    const csvPath = join(root, "导出 结果.csv");
    await writeCsvFileAtomic(csvPath, rows, { columns: ["镜号", "文案", "提示词"] });
    const fromDisk = await readCsvFile(csvPath);
    expect(fromDisk.encoding).toBe("utf-8");
    expect(fromDisk.rows).toEqual(rows);
  });

  it("preserves the first storyboard row when the original four-column CSV has no header", () => {
    const parsed = parseCsvRecords([
      "1,第一镜,3.9,雨夜街道",
      "3,第三镜,61,室内对话",
    ].join("\r\n"));

    expect(parsed.errors).toEqual([]);
    expect(parsed.columns).toEqual(["序号", "原文", "时长", "画面提示词"]);
    expect(parsed.rows).toEqual([
      { 序号: "1", 原文: "第一镜", 时长: "3.9", 画面提示词: "雨夜街道" },
      { 序号: "3", 原文: "第三镜", 时长: "61", 画面提示词: "室内对话" },
    ]);
  });

  it("atomically replaces a file and leaves no temporary files", async () => {
    const target = join(root, "输出", "结果.txt");
    await atomicWriteFile(target, "旧内容");
    await atomicWriteFile(target, "新内容");
    expect(await readFile(target, "utf8")).toBe("新内容");
    expect((await readdir(join(root, "输出"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
