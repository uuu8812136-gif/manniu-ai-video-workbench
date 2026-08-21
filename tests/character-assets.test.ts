import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  characterAssetFileStem,
  characterAssetPrompt,
  findCharacterAsset,
  persistCharacterAsset,
  preflightCharacterAssets,
} from "../src/main/character-assets";
import type { CharacterProfile } from "../src/shared/contracts";

function profile(overrides: Partial<CharacterProfile> & Pick<CharacterProfile, "name">): CharacterProfile {
  return {
    id: 1,
    projectId: 1,
    aliases: [],
    identity: "",
    gender: "",
    age: "",
    appearance: "",
    hair: "",
    clothing: "",
    personality: "",
    visualPrompt: "基础视觉提示词",
    assetType: "character",
    prompt: "",
    sortOrder: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("project character assets", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ai-tool-character-assets-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("adds character, scene, and special-space consistency prompts", () => {
    const prompt = characterAssetPrompt("人物走进城门", [
      profile({ name: "李明", prompt: "黑发青年，深色风衣" }),
      profile({ id: 2, name: "北境旧城", assetType: "scene", prompt: "覆雪边城" }),
      profile({ id: 3, name: "镜中秘境", assetType: "special-space", visualPrompt: "无限镜面空间" }),
    ]);

    expect(prompt).toContain("资产一致性设定：");
    expect(prompt).toContain("李明（人物）：黑发青年，深色风衣");
    expect(prompt).toContain("北境旧城（场景）：覆雪边城");
    expect(prompt).toContain("镜中秘境（特殊空间）：无限镜面空间");
    expect(prompt).toContain("分镜画面：\n人物走进城门");
  });

  it("persists one stable asset per standard name and replaces old extensions", async () => {
    const first = join(root, "generated.PNG");
    const second = join(root, "replacement.jpg");
    await writeFile(first, Buffer.from("first"));
    await writeFile(second, Buffer.from("second"));

    const firstAsset = await persistCharacterAsset(first, root, "Hero");
    expect(firstAsset).toBe(join(root, "资产图", "Hero.png"));
    expect(existsSync(firstAsset)).toBe(true);
    expect(await findCharacterAsset(root, "hero")).toBe(firstAsset);

    const secondAsset = await persistCharacterAsset(second, root, "Hero");
    expect(secondAsset).toBe(join(root, "资产图", "Hero.jpg"));
    expect(await readFile(secondAsset, "utf8")).toBe("second");
    expect(await readdir(join(root, "资产图"))).toEqual(["Hero.jpg"]);
    expect(characterAssetFileStem("bad/name:* ")).toBe("bad-name--");
  });

  it("preflights scene and special-space assets across compatible directories", async () => {
    await mkdir(join(root, "资产图"), { recursive: true });
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "资产图", "北境旧城.webp"), Buffer.from("scene"));
    await writeFile(join(root, "assets", "镜中秘境.jpeg"), Buffer.from("space"));

    const assets = await preflightCharacterAssets(root, ["北境旧城", "镜中秘境", "北境旧城"]);
    expect([...assets.keys()]).toEqual(["北境旧城", "镜中秘境"]);
    await expect(preflightCharacterAssets(root, ["北境旧城", "不存在的秘境"]))
      .rejects.toThrow(/不存在的秘境/);
  });
});
