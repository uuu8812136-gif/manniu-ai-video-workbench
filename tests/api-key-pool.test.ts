import { describe, expect, it } from "vitest";
import { ApiKeyPool, parseApiKeys } from "../src/main/api-key-pool";
import { ModelApiError } from "../src/main/model-clients";

describe("API key pool", () => {
  it("normalizes key lists and fails over without exposing key values", async () => {
    expect(parseApiKeys("key-a", "key-b\nkey-a; key-c")).toEqual(["key-a", "key-b", "key-c"]);
    const pool = new ApiKeyPool();
    const used: string[] = [];
    const retries: unknown[] = [];

    const result = await pool.run({
      keys: ["bad-secret", "good-secret"],
      concurrencyPerKey: 1,
      operation: async (key) => {
        used.push(key!);
        if (key === "bad-secret") throw new ModelApiError("authentication", "rejected", 401);
        return "ok";
      },
      onRetry: (error) => retries.push(error),
    });

    expect(result).toBe("ok");
    expect(used).toEqual(["bad-secret", "good-secret"]);
    expect(retries).toHaveLength(1);
  });

  it("enforces the configured concurrency for each key", async () => {
    const pool = new ApiKeyPool();
    let active = 0;
    let maximum = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = pool.run({
      keys: ["same-key"],
      concurrencyPerKey: 1,
      operation: async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await firstGate;
        active -= 1;
        return 1;
      },
    });
    const second = pool.run({
      keys: ["same-key"],
      concurrencyPerKey: 1,
      operation: async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        active -= 1;
        return 2;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(maximum).toBe(1);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(maximum).toBe(1);
  });

  it.each(["rate_limit", "server", "network", "timeout"] as const)(
    "retries one key at most three times for %s failures",
    async (kind) => {
      const pool = new ApiKeyPool();
      const attempts: number[] = [];
      const retryStates: Array<{ keyAttempt: number; switchingKey: boolean }> = [];

      await expect(pool.run({
        keys: ["one-key"],
        concurrencyPerKey: 1,
        maxAttemptsPerKey: 3,
        operation: async (_key, attempt) => {
          attempts.push(attempt);
          throw new ModelApiError(kind, "temporary failure", kind === "rate_limit" ? 429 : undefined);
        },
        onRetry: (_error, _attempt, state) => retryStates.push({
          keyAttempt: state.keyAttempt,
          switchingKey: state.switchingKey,
        }),
      })).rejects.toMatchObject({ kind });

      expect(attempts).toEqual([1, 2, 3]);
      expect(retryStates).toEqual([
        { keyAttempt: 1, switchingKey: false },
        { keyAttempt: 2, switchingKey: false },
      ]);
    },
  );

  it("exhausts transient retries before switching keys but switches immediately on authentication failure", async () => {
    const transientPool = new ApiKeyPool();
    const transientKeys: string[] = [];
    await expect(transientPool.run({
      keys: ["first", "second"],
      concurrencyPerKey: 1,
      maxAttemptsPerKey: 3,
      operation: async (key) => {
        transientKeys.push(key!);
        if (key === "first") throw new ModelApiError("server", "temporary", 503);
        return "ok";
      },
    })).resolves.toBe("ok");
    expect(transientKeys).toEqual(["first", "first", "first", "second"]);

    const authPool = new ApiKeyPool();
    const authKeys: string[] = [];
    await expect(authPool.run({
      keys: ["bad", "good"],
      concurrencyPerKey: 1,
      maxAttemptsPerKey: 3,
      operation: async (key) => {
        authKeys.push(key!);
        if (key === "bad") throw new ModelApiError("authentication", "rejected", 401);
        return "ok";
      },
    })).resolves.toBe("ok");
    expect(authKeys).toEqual(["bad", "good"]);
  });
});
