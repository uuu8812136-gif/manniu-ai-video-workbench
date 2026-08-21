import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export type InferenceRuntimePaths = {
  root: string;
  python: string;
  skill: string;
  scripts: string;
  references: string;
};

export type InferenceScriptResult = {
  code: number;
  stdout: string;
  stderr: string;
};

const REQUIRED_RUNTIME_FILES = [
  ["python", "python.exe"],
  ["inference-skill", "CLAUDE.md"],
  ["inference-skill", "SKILL.md"],
  ["inference-skill", "verify_split_extreme.py"],
  ["inference-skill", "scripts", "segment.py"],
  ["inference-skill", "scripts", "build_storyboard_skeleton.py"],
  ["inference-skill", "scripts", "check_bcol.py"],
  ["inference-skill", "scripts", "check_dcol.py"],
] as const;

export function inferenceRuntimePaths(resourcesRoot = resolve(process.cwd(), "vendor")): InferenceRuntimePaths {
  const root = resolve(resourcesRoot);
  const skill = join(root, "inference-skill");
  return {
    root,
    python: join(root, "python", "python.exe"),
    skill,
    scripts: join(skill, "scripts"),
    references: join(skill, "references"),
  };
}

export async function assertInferenceRuntime(paths: InferenceRuntimePaths): Promise<void> {
  await Promise.all(REQUIRED_RUNTIME_FILES.map((parts) => access(join(paths.root, ...parts))));
}

export async function readInferenceRule(paths: InferenceRuntimePaths, relativePath: string): Promise<string> {
  return readFile(join(paths.skill, relativePath), "utf8");
}

export async function runInferenceScript(
  paths: InferenceRuntimePaths,
  scriptName: string,
  args: string[],
  options: { cwd: string; signal?: AbortSignal } = { cwd: process.cwd() },
): Promise<InferenceScriptResult> {
  await assertInferenceRuntime(paths);
  return new Promise<InferenceScriptResult>((resolveResult, reject) => {
    const child = spawn(paths.python, [join(paths.scripts, scriptName), ...args], {
      cwd: resolve(options.cwd),
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const abort = (): void => {
      child.kill();
    };
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      options.signal?.removeEventListener("abort", abort);
      if (options.signal?.aborted) {
        reject(options.signal.reason ?? new Error("推理任务已停止"));
        return;
      }
      resolveResult({ code: code ?? -1, stdout, stderr });
    });
  });
}

export function scriptFailure(label: string, result: InferenceScriptResult): Error {
  const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
  return new Error(`${label}失败（退出码 ${result.code}）${detail ? `:\n${detail}` : ""}`);
}
