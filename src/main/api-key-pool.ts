import { ModelApiError } from "./model-clients";

const ANONYMOUS_KEY = "\0anonymous";

export function parseApiKeys(primary?: string | null, multiple?: string | null): string[] {
  const values = [primary ?? "", ...(multiple ?? "").split(/[\r\n,;]+/)]
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(values)];
}

function canTryAnotherKey(error: unknown): boolean {
  return (
    error instanceof ModelApiError &&
    ["authentication", "rate_limit", "server", "network", "timeout"].includes(error.kind)
  );
}

function canRetrySameKey(error: unknown): boolean {
  return (
    error instanceof ModelApiError &&
    ["rate_limit", "server", "network", "timeout"].includes(error.kind)
  );
}

type Lease = {
  key: string | undefined;
  release(): void;
};

export class ApiKeyPool {
  private readonly active = new Map<string, number>();
  private readonly waiters = new Set<() => void>();
  private cursor = 0;

  async run<T>(options: {
    keys: string[];
    concurrencyPerKey: number;
    signal?: AbortSignal;
    operation(key: string | undefined, attempt: number): Promise<T>;
    canRetry?(error: unknown): boolean;
    canRetrySameKey?(error: unknown): boolean;
    maxAttemptsPerKey?: number;
    onRetry?(
      error: unknown,
      attempt: number,
      state: { keyAttempt: number; maxAttemptsPerKey: number; switchingKey: boolean },
    ): void;
  }): Promise<T> {
    const concurrency = Math.max(1, Math.min(32, Math.trunc(options.concurrencyPerKey) || 1));
    const candidates = options.keys.length > 0 ? [...new Set(options.keys)] : [ANONYMOUS_KEY];
    const attempted = new Set<string>();
    const maxAttemptsPerKey = Math.max(1, Math.min(10, Math.trunc(options.maxAttemptsPerKey ?? 1) || 1));
    let lastError: unknown;
    let totalAttempts = 0;

    while (attempted.size < candidates.length) {
      const remaining = candidates.filter((key) => !attempted.has(key));
      const lease = await this.acquire(remaining, concurrency, options.signal);
      const internalKey = lease.key ?? ANONYMOUS_KEY;
      attempted.add(internalKey);
      try {
        for (let keyAttempt = 1; keyAttempt <= maxAttemptsPerKey; keyAttempt += 1) {
          totalAttempts += 1;
          try {
            return await options.operation(lease.key, totalAttempts);
          } catch (error) {
            lastError = error;
            const retrySameKey = options.canRetrySameKey
              ? options.canRetrySameKey(error)
              : canRetrySameKey(error);
            if (retrySameKey && keyAttempt < maxAttemptsPerKey) {
              options.onRetry?.(error, totalAttempts, { keyAttempt, maxAttemptsPerKey, switchingKey: false });
              continue;
            }
            const retryable = options.canRetry ? options.canRetry(error) : canTryAnotherKey(error);
            if (!retryable || attempted.size >= candidates.length) throw error;
            options.onRetry?.(error, totalAttempts, { keyAttempt, maxAttemptsPerKey, switchingKey: true });
            break;
          }
        }
      } finally {
        lease.release();
      }
    }
    throw lastError ?? new Error("No model API key is available");
  }

  private acquire(keys: string[], limit: number, signal?: AbortSignal): Promise<Lease> {
    return new Promise<Lease>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        this.waiters.delete(tryAcquire);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(signal?.reason ?? new Error("Request cancelled"));
      };
      const tryAcquire = (): void => {
        if (settled) return;
        if (signal?.aborted) {
          onAbort();
          return;
        }
        for (let offset = 0; offset < keys.length; offset += 1) {
          const index = (this.cursor + offset) % keys.length;
          const internalKey = keys[index];
          const count = this.active.get(internalKey) ?? 0;
          if (count >= limit) continue;
          settled = true;
          this.cursor = (index + 1) % keys.length;
          this.active.set(internalKey, count + 1);
          cleanup();
          let released = false;
          resolve({
            key: internalKey === ANONYMOUS_KEY ? undefined : internalKey,
            release: () => {
              if (released) return;
              released = true;
              const next = (this.active.get(internalKey) ?? 1) - 1;
              if (next > 0) this.active.set(internalKey, next);
              else this.active.delete(internalKey);
              for (const waiter of [...this.waiters]) queueMicrotask(waiter);
            },
          });
          return;
        }
      };

      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.add(tryAcquire);
      tryAcquire();
    });
  }
}
