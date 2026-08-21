import { describe, expect, it } from "vitest";
import {
  fingerprintViduJwt,
  inspectViduJwt,
  prepareViduJwtLines,
  redactViduJwt,
} from "../src/main/vidu-jwt";

function jwt(exp: number, subject = "user-1"): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ exp, sub: subject })}.abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG`;
}

describe("Vidu JWT import preflight", () => {
  it("validates expiration and creates a stable SHA-256 fingerprint", () => {
    const token = jwt(2_000_000_000);
    expect(inspectViduJwt(token, 1_900_000_000_000)).toEqual({
      fingerprint: fingerprintViduJwt(token),
      expiresAt: "2033-05-18T03:33:20.000Z",
      maskedToken: "[JWT_REDACTED]",
    });
    expect(fingerprintViduJwt(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects malformed, missing-exp and expired tokens without echoing their raw values", () => {
    expect(() => inspectViduJwt("not-a-jwt", 0)).toThrow("JWT 格式无效");
    const missingExp = `${Buffer.from("{}").toString("base64url")}.${Buffer.from('{"sub":"u"}').toString("base64url")}.abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG`;
    expect(() => inspectViduJwt(missingExp, 0)).toThrow("缺少有效的 exp");
    const expired = jwt(100, "expired-user");
    expect(() => inspectViduJwt(expired, 101_000)).toThrow("JWT 已过期");
    expect(JSON.stringify(prepareViduJwtLines(expired, new Set(), 101_000))).not.toContain(expired);
  });

  it("reports line-level format, batch duplicate, and database duplicate failures", () => {
    const first = jwt(2_000_000_000, "first");
    const existing = jwt(2_000_000_000, "existing");
    const prepared = prepareViduJwtLines(
      `${first}\ninvalid\n${first}\n\n${existing}`,
      new Set([fingerprintViduJwt(existing)]),
      1_900_000_000_000,
    );

    expect(prepared.map(({ status, lineNumber }) => ({ status, lineNumber }))).toEqual([
      { status: "ready", lineNumber: 1 },
      { status: "failed", lineNumber: 2 },
      { status: "failed", lineNumber: 3 },
      { status: "failed", lineNumber: 5 },
    ]);
    expect(prepared[2]).toMatchObject({ message: expect.stringContaining("本次导入") });
    expect(prepared[3]).toMatchObject({ message: expect.stringContaining("已经导入") });
  });

  it("redacts JWT-like values from provider errors", () => {
    const token = jwt(2_000_000_000);
    expect(redactViduJwt(`provider rejected ${token}`)).toBe("provider rejected [JWT_REDACTED]");
  });
});
