import type { ViduAccount, ViduAccountStatus, ViduJwtImportLineResult, WorkflowJob } from "../../../shared/contracts";

const MUTATION_BLOCKING_STATUSES = new Set(["queued", "running"]);
const DESTRUCTIVE_BLOCKING_STATUSES = new Set(["queued", "running", "paused"]);

export type ViduAccountPoolLocks = {
  mutation: WorkflowJob[];
  destructive: WorkflowJob[];
};

export function viduAccountPoolLocks(jobs: WorkflowJob[]): ViduAccountPoolLocks {
  const videoJobs = jobs.filter((job) => job.type === "video.generate");
  return {
    mutation: videoJobs.filter((job) => MUTATION_BLOCKING_STATUSES.has(job.status)),
    destructive: videoJobs.filter((job) => DESTRUCTIVE_BLOCKING_STATUSES.has(job.status)),
  };
}

export function pointsAccountIds(accounts: ViduAccount[]): string[] {
  return accounts.filter((account) => account.accountType === "points").map((account) => account.id);
}

export async function checkAccountsConcurrently(
  accountIds: readonly string[],
  check: (accountId: string) => Promise<ViduAccountStatus>,
  concurrency = 10,
  onSettled?: (result: PromiseSettledResult<ViduAccountStatus>, index: number) => void,
): Promise<Array<PromiseSettledResult<ViduAccountStatus>>> {
  const limit = Math.max(1, Math.min(accountIds.length || 1, Math.floor(concurrency)));
  const settled: Array<PromiseSettledResult<ViduAccountStatus>> = new Array(accountIds.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < accountIds.length) {
      const index = cursor;
      cursor += 1;
      try {
        settled[index] = { status: "fulfilled", value: await check(accountIds[index]) };
      } catch (reason) {
        settled[index] = { status: "rejected", reason };
      }
      onSettled?.(settled[index], index);
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return settled;
}

export type ViduAccountIssueTag = {
  kind: "auth" | "nopeak" | "credits" | "subject_limit" | "manual";
  label: string;
  message: string;
};

export function viduAccountIssueTags(account: ViduAccount, status?: ViduAccountStatus): ViduAccountIssueTag[] {
  const tags = new Map<ViduAccountIssueTag["kind"], ViduAccountIssueTag>();
  const add = (tag: ViduAccountIssueTag): void => { if (!tags.has(tag.kind)) tags.set(tag.kind, tag); };
  if (status?.status === "logged-out" || account.disabledReason === "login_expired") {
    add({ kind: "auth", label: "登录过期", message: status?.message || account.disabledMessage || "Vidu 登录状态已失效" });
  }
  if (status?.httpStatus === 429) {
    add({ kind: "nopeak", label: "错峰不可用", message: status.message || "Vidu 当前处于错峰限制" });
  }
  if (account.disabledReason === "credits_exhausted") {
    add({ kind: "credits", label: "积分不可用", message: account.disabledMessage || "Vidu 积分不足" });
  }
  if (account.disabledReason === "subject_limit") {
    add({ kind: "subject_limit", label: "主体限频", message: account.disabledMessage || "Vidu 主体库操作频率超限" });
  }
  if (account.disabledReason === "manual") {
    add({ kind: "manual", label: "手动停用", message: account.disabledMessage || "账号已手动停用" });
  }
  return [...tags.values()];
}

export async function deleteAccountsContinuing(
  accountIds: readonly string[],
  remove: (accountId: string) => Promise<void>,
): Promise<{ deletedIds: string[]; failures: Array<{ accountId: string; error: string }> }> {
  const deletedIds: string[] = [];
  const failures: Array<{ accountId: string; error: string }> = [];
  for (const accountId of accountIds) {
    try {
      await remove(accountId);
      deletedIds.push(accountId);
    } catch (reason) {
      failures.push({ accountId, error: reason instanceof Error ? reason.message : String(reason) });
    }
  }
  return { deletedIds, failures };
}

export function shouldClearViduJwtInput(results: ViduJwtImportLineResult[]): boolean {
  return results.length > 0 && results.every((result) => result.status === "success");
}

export type PreparedViduJwtLine = {
  token: string;
  lineNumber: number;
  status: "ready" | "failed";
  message: string;
};

const VIDU_JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;

function inspectViduJwtPayload(token: string, now: number): string | null {
  try {
    const segment = token.split(".")[1];
    const base64 = segment.replace(/-/gu, "+").replace(/_/gu, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    const decoded: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      return "JWT payload 无法解析";
    }
    const exp = (decoded as Record<string, unknown>).exp;
    if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= 0) {
      return "JWT 缺少有效的 exp 过期时间";
    }
    if (exp * 1_000 <= now) return "JWT 已过期";
    return null;
  } catch {
    return "JWT payload 无法解析";
  }
}

export function prepareViduJwtImportLines(value: string, now = Date.now()): PreparedViduJwtLine[] {
  const seen = new Map<string, number>();
  return value.split(/\r?\n/u)
    .map((token, index) => ({ token: token.trim(), lineNumber: index + 1 }))
    .filter(({ token }) => Boolean(token))
    .map((line) => {
      if (line.token.length < 40 || !VIDU_JWT_PATTERN.test(line.token)) {
        return { ...line, status: "failed" as const, message: "JWT 格式无效" };
      }
      const payloadError = inspectViduJwtPayload(line.token, now);
      if (payloadError) return { ...line, status: "failed" as const, message: payloadError };
      const firstLine = seen.get(line.token);
      if (firstLine !== undefined) {
        return {
          ...line,
          status: "failed" as const,
          message: `与本次导入中的第 ${firstLine} 行 JWT 重复`,
        };
      }
      seen.set(line.token, line.lineNumber);
      return { ...line, status: "ready" as const, message: "等待验证" };
    });
}
