import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INSTALLED_DATA_DIRECTORY, PORTABLE_DATA_DIRECTORY } from "../src/main/runtime-paths";

describe("AI工具 brand contract", () => {
  const root = process.cwd();

  it("pins package identity and release version", () => {
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      name: string;
      version: string;
    };
    expect(packageJson).toMatchObject({ name: "ai-tool", version: "0.8.22" });
    const aboutPage = readFileSync(join(root, "src", "renderer", "src", "pages", "AboutPage.tsx"), "utf8");
    expect(aboutPage).toContain('import packageJson from "../../../../package.json"');
    expect(aboutPage).toContain("版本 {appVersion}");
  });

  it("pins executable and installer artifact names", () => {
    const builder = readFileSync(join(root, "electron-builder.yml"), "utf8");
    expect(builder).toContain("productName: AI工具");
    expect(builder).toContain("executableName: ai-tool");
    expect(builder).toContain("artifactName: ai-tool-setup-${version}-${arch}.${ext}");
    expect(builder).toContain("artifactName: ai-tool-portable-${version}-${arch}.${ext}");
  });

  it("pins installed, portable, and database storage names", () => {
    const mainEntry = readFileSync(join(root, "src", "main", "index.ts"), "utf8");
    expect(INSTALLED_DATA_DIRECTORY).toBe("ai-tool");
    expect(PORTABLE_DATA_DIRECTORY).toBe("ai-tool-data");
    expect(mainEntry).toContain('database: join(userData, "ai-tool.db")');
  });
});
