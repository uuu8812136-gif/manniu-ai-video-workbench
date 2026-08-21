import { describe, expect, it } from "vitest";
import { pendingProjectAssetNames } from "../src/renderer/src/pages/project-assets-state";

describe("project asset sidebar state", () => {
  it("lists CSV asset references that do not yet have inferred profiles", () => {
    const pending = pendingProjectAssetNames([
      { subjects: ["万浩", "斜月"], prompt: "@万浩 与 @斜月 站在 @落叶林地" },
      { subjects: ["金焰"], prompt: "@金焰 望向 @胡列娜" },
    ], []);

    expect(pending).toEqual(["万浩", "斜月", "落叶林地", "金焰", "胡列娜"]);
  });

  it("excludes profile names and aliases while retaining unresolved references", () => {
    const pending = pendingProjectAssetNames(
      [{ subjects: ["小万", "落叶林地"], prompt: "@万浩 进入 @落叶林地" }],
      [{ name: "万浩", aliases: ["小万"] }],
    );

    expect(pending).toEqual(["落叶林地"]);
  });
});
