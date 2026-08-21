import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";
import type BetterSqlite3 from "better-sqlite3";

export type DiagnosticStatus = "ok" | "error";

export type RuntimeInformation = {
  node: string;
  electron: string | null;
  chrome: string | null;
  platform: NodeJS.Platform;
  architecture: string;
  osRelease: string;
};

export type DirectoryDiagnostic = {
  name: string;
  path: string;
  writable: boolean;
  error: string | null;
};

export type SqliteDiagnostic = {
  healthy: boolean;
  result: string[];
  error: string | null;
};

export type RuntimeDiagnostics = {
  status: DiagnosticStatus;
  generatedAt: string;
  runtime: RuntimeInformation;
  directories: DirectoryDiagnostic[];
  sqlite: SqliteDiagnostic;
};

export type DiagnosticsOptions = {
  directories: Record<string, string>;
  database: Pick<BetterSqlite3.Database, "pragma">;
  now?: () => Date;
};

export function collectRuntimeInformation(): RuntimeInformation {
  return {
    node: process.versions.node,
    electron: process.versions.electron ?? null,
    chrome: process.versions.chrome ?? null,
    platform: process.platform,
    architecture: process.arch,
    osRelease: release(),
  };
}

export function checkDirectoryWritable(name: string, directory: string): DirectoryDiagnostic {
  const probe = join(directory, `.ai-tool-write-probe-${process.pid}-${randomUUID()}`);
  let descriptor: number | null = null;
  try {
    mkdirSync(directory, { recursive: true });
    descriptor = openSync(probe, "wx", 0o600);
    closeSync(descriptor);
    descriptor = null;
    unlinkSync(probe);
    return { name, path: directory, writable: true, error: null };
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // The original filesystem error is more useful.
      }
    }
    try {
      unlinkSync(probe);
    } catch {
      // The probe may not have been created.
    }
    return { name, path: directory, writable: false, error: safeErrorMessage(error) };
  }
}

export function checkSqlite(database: Pick<BetterSqlite3.Database, "pragma">): SqliteDiagnostic {
  try {
    const raw = database.pragma("quick_check", { simple: true });
    const result = normalizeQuickCheck(raw);
    return {
      healthy: result.length > 0 && result.every((entry) => entry.toLowerCase() === "ok"),
      result,
      error: null,
    };
  } catch (error) {
    return { healthy: false, result: [], error: safeErrorMessage(error) };
  }
}

export function runDiagnostics(options: DiagnosticsOptions): RuntimeDiagnostics {
  const directories = Object.entries(options.directories).map(([name, path]) => checkDirectoryWritable(name, path));
  const sqlite = checkSqlite(options.database);
  return {
    status: sqlite.healthy && directories.every((item) => item.writable) ? "ok" : "error",
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    runtime: collectRuntimeInformation(),
    directories,
    sqlite,
  };
}

function normalizeQuickCheck(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.flatMap((entry) => {
      if (typeof entry === "string") return [entry];
      if (entry && typeof entry === "object") return Object.values(entry).filter((value): value is string => typeof value === "string");
      return [];
    });
  }
  return typeof raw === "string" ? [raw] : [];
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return "Unknown diagnostic error";
}
