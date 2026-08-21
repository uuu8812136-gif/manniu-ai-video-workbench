import { createHash } from "node:crypto";

const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const JWT_LIKE_PATTERN = /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

export type ViduJwtDescriptor = {
  fingerprint: string;
  expiresAt: string;
  maskedToken: "[JWT_REDACTED]";
};

export type PreparedViduJwtLine =
  | ({ status: "ready"; lineNumber: number; jwt: string } & ViduJwtDescriptor)
  | { status: "failed"; lineNumber: number; maskedToken: "[JWT_REDACTED]"; message: string };

function decodePayload(segment: string): Record<string, unknown> {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) throw new Error("not an object");
    return decoded as Record<string, unknown>;
  } catch {
    throw new Error("JWT payload 无法解析");
  }
}

export function fingerprintViduJwt(jwt: string): string {
  return createHash("sha256").update(jwt).digest("hex");
}

export function inspectViduJwt(jwt: string, now = Date.now()): ViduJwtDescriptor {
  const value = jwt.trim();
  if (value.length < 40 || !JWT_PATTERN.test(value)) throw new Error("JWT 格式无效");
  const payload = decodePayload(value.split(".")[1]);
  const exp = payload.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= 0) throw new Error("JWT 缺少有效的 exp 过期时间");
  if (exp * 1_000 <= now) throw new Error("JWT 已过期");
  return {
    fingerprint: fingerprintViduJwt(value),
    expiresAt: new Date(exp * 1_000).toISOString(),
    maskedToken: "[JWT_REDACTED]",
  };
}

export function prepareViduJwtLines(
  text: string,
  existingFingerprints: ReadonlySet<string> = new Set(),
  now = Date.now(),
): PreparedViduJwtLine[] {
  const seen = new Set<string>();
  const results: PreparedViduJwtLine[] = [];
  text.split(/\r?\n/u).forEach((raw, index) => {
    const jwt = raw.trim();
    if (!jwt) return;
    const lineNumber = index + 1;
    try {
      const descriptor = inspectViduJwt(jwt, now);
      if (seen.has(descriptor.fingerprint)) {
        results.push({ status: "failed", lineNumber, maskedToken: "[JWT_REDACTED]", message: "与本次导入中的其他 JWT 重复" });
        return;
      }
      seen.add(descriptor.fingerprint);
      if (existingFingerprints.has(descriptor.fingerprint)) {
        results.push({ status: "failed", lineNumber, maskedToken: "[JWT_REDACTED]", message: "该 JWT 已经导入" });
        return;
      }
      results.push({ status: "ready", lineNumber, jwt, ...descriptor });
    } catch (error) {
      results.push({
        status: "failed",
        lineNumber,
        maskedToken: "[JWT_REDACTED]",
        message: redactViduJwt(error instanceof Error ? error.message : String(error)),
      });
    }
  });
  return results;
}

export function redactViduJwt(value: string): string {
  return value.replace(JWT_LIKE_PATTERN, "[JWT_REDACTED]");
}
