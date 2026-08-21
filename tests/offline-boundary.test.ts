import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}

describe("offline deployment boundary", () => {
  const source = sourceFiles(join(process.cwd(), "src"))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");

  it("does not contain original authentication or reporting endpoints", () => {
    expect(source).not.toContain("101.42.2.100");
    expect(source).not.toContain("/api/v2/auth/login");
    expect(source).not.toContain("/api/auth/verify");
    expect(source).not.toContain("/api/project-log");
  });

  it("uses only the bundled validation Python runtime without shell scripts", () => {
    const runtime = readFileSync(join(process.cwd(), "src", "main", "inference-runtime.ts"), "utf8");
    expect(runtime).toContain('join(root, "python", "python.exe")');
    expect(runtime).toContain("windowsHide: true");
    expect(runtime).not.toContain("pythonw.exe");
    expect(runtime).not.toMatch(/shell\s*:\s*true/u);
  });

  it("loads renderer mock data only through a development-only dynamic import", () => {
    const rendererEntry = readFileSync(join(process.cwd(), "src", "renderer", "src", "main.tsx"), "utf8");
    expect(rendererEntry).toContain("if (import.meta.env.DEV)");
    expect(rendererEntry).toContain('await import("./dev-mock")');
    expect(rendererEntry).not.toMatch(/import\s+\{[^}]*installDevelopmentMock[^}]*\}\s+from\s+["']\.\/dev-mock["']/);
  });

  it("keeps interaction-audit workflow fast paths out of packaged runtime", () => {
    const mainEntry = readFileSync(join(process.cwd(), "src", "main", "index.ts"), "utf8");

    expect(mainEntry).toMatch(
      /allowLegacyInferenceFastPath:\s*!app\.isPackaged\s*&&\s*process\.env\.AI_TOOL_TEST_INTERACTION_AUDIT\s*===\s*"1"\s*&&\s*process\.env\.AI_TOOL_TEST_OPENING_FIXTURE_FAST_PATH\s*===\s*"1"/u,
    );
  });

  it("builds the sandboxed preload as CommonJS", () => {
    const viteConfig = readFileSync(join(process.cwd(), "electron.vite.config.ts"), "utf8");
    const mainEntry = readFileSync(join(process.cwd(), "src", "main", "index.ts"), "utf8");

    expect(viteConfig).toContain('format: "cjs"');
    expect(viteConfig).toContain('entryFileNames: "[name].cjs"');
    expect(mainEntry).toContain('preload: join(__dirname, "../preload/index.cjs")');
    expect(mainEntry).toContain("sandbox: true");
  });
});
