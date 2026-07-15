import { sleep as defaultSleep } from "../utils/helpers.js";

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
}

export interface RetryContext {
  readonly operation: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly error: unknown;
}

export interface RetryResult<T> {
  readonly value: T;
  readonly attempts: number;
  readonly retries: number;
  readonly totalDelayMs: number;
}

export interface RetryOptions {
  readonly operation?: string;
  readonly shouldRetry?: (error: unknown, context: RetryContext) => boolean;
  readonly onRetry?: (
    context: RetryContext & { readonly delayMs: number },
  ) => void | Promise<void>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

export function calculateRetryDelay(
  policy: RetryPolicy,
  retryIndex: number,
  random = Math.random,
): number {
  const exponential = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** Math.max(0, retryIndex),
  );
  const jitterRange = exponential * policy.jitterRatio;
  const jitter = (random() * 2 - 1) * jitterRange;
  return Math.max(0, Math.min(policy.maxDelayMs, Math.round(exponential + jitter)));
}

export function isRetryableNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|ERR_CONNECTION_RESET|ERR_NETWORK_CHANGED|network|fetch failed|HTTP (408|429|5\d\d)/i.test(
    message,
  );
}

export async function executeWithRetry<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy,
  options: RetryOptions = {},
): Promise<RetryResult<T>> {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new Error("Retry maxAttempts must be at least 1");
  }

  const wait = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  let totalDelayMs = 0;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      return {
        value: await operation(),
        attempts: attempt,
        retries: attempt - 1,
        totalDelayMs,
      };
    } catch (error) {
      const context: RetryContext = {
        operation: options.operation ?? "operation",
        attempt,
        maxAttempts: policy.maxAttempts,
        error,
      };
      const retryable = options.shouldRetry?.(error, context) ?? true;
      if (!retryable || attempt >= policy.maxAttempts) throw error;

      const delayMs = calculateRetryDelay(policy, attempt - 1, random);
      await options.onRetry?.({
        ...context,
        attempt: attempt + 1,
        delayMs,
      });
      totalDelayMs += delayMs;
      await wait(delayMs);
    }
  }

  throw new Error("Retry operation ended unexpectedly");
}
