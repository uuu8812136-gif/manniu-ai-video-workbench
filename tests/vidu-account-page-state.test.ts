import { describe, expect, it } from "vitest";
import type { ViduAccount, ViduAccountStatus, WorkflowJob } from "../src/shared/contracts";
import {
  checkAccountsConcurrently,
  deleteAccountsContinuing,
  pointsAccountIds,
  prepareViduJwtImportLines,
  shouldClearViduJwtInput,
  viduAccountIssueTags,
  viduAccountPoolLocks,
} from "../src/renderer/src/pages/vidu-account-page-state";

function job(type: WorkflowJob["type"], status: WorkflowJob["status"]): WorkflowJob {
  return { id: `${type}-${status}`, type, status } as WorkflowJob;
}

function account(id: string, accountType: ViduAccount["accountType"]): ViduAccount {
  return { id, accountType } as ViduAccount;
}

function jwt(subject: string, exp = 2_000_000_000): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ exp, sub: subject })}.abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG`;
}

describe("Vidu account page state", () => {
  it("allows account edits while video generation is paused and ignores image jobs", () => {
    const locks = viduAccountPoolLocks([
      job("image.generate", "queued"),
      job("image.standalone", "running"),
      job("video.generate", "queued"),
      job("video.generate", "running"),
      job("video.generate", "paused"),
      job("image.generate", "done"),
      job("storyboard.infer", "running"),
    ]);
    expect(locks.mutation.map(({ id }) => id)).toEqual([
      "video.generate-queued",
      "video.generate-running",
    ]);
    expect(locks.destructive.map(({ id }) => id)).toEqual([
      "video.generate-queued",
      "video.generate-running",
      "video.generate-paused",
    ]);
  });

  it("clears JWT input only when every imported line succeeded", () => {
    const success = { status: "success" as const } as never;
    const failed = { status: "failed" as const } as never;
    expect(shouldClearViduJwtInput([success, success])).toBe(true);
    expect(shouldClearViduJwtInput([success, failed])).toBe(false);
    expect(shouldClearViduJwtInput([])).toBe(false);
  });

  it("selects only points accounts for bulk deletion", () => {
    expect(pointsAccountIds([
      account("member-1", "member"),
      account("points-1", "points"),
      account("points-2", "points"),
    ])).toEqual(["points-1", "points-2"]);
  });

  it("checks account login and credits with at most ten concurrent requests while retaining order and failures", async () => {
    let active = 0;
    let maximumActive = 0;
    const ids = Array.from({ length: 25 }, (_, index) => `account-${index}`);
    const results = await checkAccountsConcurrently(ids, async (id) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      if (id === "account-7") throw new Error("login expired");
      return { accountId: id, status: "logged-in", httpStatus: 200, message: "ok", availableCredits: 12 };
    });
    expect(maximumActive).toBeLessThanOrEqual(10);
    expect(results[0]).toMatchObject({ status: "fulfilled", value: { accountId: "account-0", availableCredits: 12 } });
    expect(results[7]).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: "login expired" }) });
    expect(results[24]).toMatchObject({ status: "fulfilled", value: { accountId: "account-24" } });
  });

  it("reports account checks as each request settles", async () => {
    const updates: Array<{ index: number; status: string }> = [];
    await checkAccountsConcurrently(
      ["slow", "fast", "failed"],
      async (id) => {
        await new Promise((resolve) => setTimeout(resolve, id === "slow" ? 8 : 1));
        if (id === "failed") throw new Error("temporary failure");
        return { accountId: id, status: "logged-in", httpStatus: 200, message: "ok" };
      },
      3,
      (result, index) => updates.push({ index, status: result.status }),
    );
    expect(updates).toEqual([
      { index: 1, status: "fulfilled" },
      { index: 2, status: "rejected" },
      { index: 0, status: "fulfilled" },
    ]);
  });

  it("shows simultaneous login, throttle and persistent disable issues", () => {
    const value = {
      ...account("points-1", "points"),
      disabledReason: "credits_exhausted",
      disabledMessage: "积分不足",
    } as ViduAccount;
    const status = { status: "logged-out", httpStatus: 429, message: "当前不可用" } as ViduAccountStatus;
    expect(viduAccountIssueTags(value, status).map(({ kind }) => kind)).toEqual(["auth", "nopeak", "credits"]);
    expect(viduAccountIssueTags({ ...value, disabledReason: "subject_limit" }, status).map(({ kind }) => kind)).toEqual(["auth", "nopeak", "subject_limit"]);
  });

  it("continues bulk deletion after an account fails and retains the failure", async () => {
    const attempted: string[] = [];
    const result = await deleteAccountsContinuing(["points-1", "points-2", "points-3"], async (accountId) => {
      attempted.push(accountId);
      if (accountId === "points-2") throw new Error("session cleanup failed");
    });
    expect(attempted).toEqual(["points-1", "points-2", "points-3"]);
    expect(result).toEqual({
      deletedIds: ["points-1", "points-3"],
      failures: [{ accountId: "points-2", error: "session cleanup failed" }],
    });
  });

  it("preflights JWT format and deduplicates valid tokens before any login attempt", () => {
    const first = jwt("first");
    const second = jwt("second");
    expect(prepareViduJwtImportLines([
      "",
      first,
      "not-a-jwt",
      `  ${first}  `,
      second,
    ].join("\n"), 1_900_000_000_000)).toEqual([
      { token: first, lineNumber: 2, status: "ready", message: "等待验证" },
      { token: "not-a-jwt", lineNumber: 3, status: "failed", message: "JWT 格式无效" },
      { token: first, lineNumber: 4, status: "failed", message: "与本次导入中的第 2 行 JWT 重复" },
      { token: second, lineNumber: 5, status: "ready", message: "等待验证" },
    ]);
  });

  it("reports an invalid payload on every repeated line instead of deduplicating it", () => {
    const invalidPayload = "header_header_header.payload_payload_payload.signature_signature";
    expect(prepareViduJwtImportLines(`${invalidPayload}\n${invalidPayload}`, 0)).toEqual([
      { token: invalidPayload, lineNumber: 1, status: "failed", message: "JWT payload 无法解析" },
      { token: invalidPayload, lineNumber: 2, status: "failed", message: "JWT payload 无法解析" },
    ]);
  });

  it("rejects missing and expired exp values before deduplication", () => {
    const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
    const signature = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    const missingExp = `${encode({ alg: "HS256" })}.${encode({ sub: "missing" })}.${signature}`;
    const expired = jwt("expired", 100);
    expect(prepareViduJwtImportLines(`${missingExp}\n${missingExp}\n${expired}\n${expired}`, 101_000)).toEqual([
      { token: missingExp, lineNumber: 1, status: "failed", message: "JWT 缺少有效的 exp 过期时间" },
      { token: missingExp, lineNumber: 2, status: "failed", message: "JWT 缺少有效的 exp 过期时间" },
      { token: expired, lineNumber: 3, status: "failed", message: "JWT 已过期" },
      { token: expired, lineNumber: 4, status: "failed", message: "JWT 已过期" },
    ]);
  });
});
