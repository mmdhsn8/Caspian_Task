import { sleep as defaultSleep } from "../utils/helpers.js";

export interface RateLimiterConfig {
  readonly requestsPerMinute: number;
  readonly burst: number;
  readonly enabled?: boolean;
}

export interface RateLimitAcquireResult {
  readonly waitedMs: number;
}

interface QueueItem {
  readonly enqueuedAt: number;
  readonly resolve: (result: RateLimitAcquireResult) => void;
  readonly reject: (error: unknown) => void;
}

export class AsyncRateLimiter {
  private readonly enabled: boolean;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private tokens: number;
  private lastRefillAt: number;
  private queue: QueueItem[] = [];
  private servicing = false;

  constructor(
    config: RateLimiterConfig,
    dependencies: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.enabled = config.enabled !== false;
    this.capacity = Math.max(1, config.burst);
    this.refillPerMs = Math.max(0, config.requestsPerMinute / 60_000);
    this.now = dependencies.now ?? Date.now;
    this.sleep = dependencies.sleep ?? defaultSleep;
    this.tokens = this.capacity;
    this.lastRefillAt = this.now();
  }

  acquire(): Promise<RateLimitAcquireResult> {
    if (!this.enabled) return Promise.resolve({ waitedMs: 0 });
    return new Promise<RateLimitAcquireResult>((resolve, reject) => {
      this.queue.push({ enqueuedAt: this.now(), resolve, reject });
      void this.service();
    });
  }

  private refill(): void {
    const current = this.now();
    const elapsed = Math.max(0, current - this.lastRefillAt);
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefillAt = current;
  }

  private async service(): Promise<void> {
    if (this.servicing) return;
    this.servicing = true;
    try {
      while (this.queue.length > 0) {
        this.refill();
        const item = this.queue[0];
        if (this.tokens < 1) {
          const waitMs = Math.max(1, Math.ceil((1 - this.tokens) / this.refillPerMs));
          await this.sleep(waitMs);
          continue;
        }
        this.tokens -= 1;
        this.queue.shift();
        item.resolve({ waitedMs: Math.max(0, this.now() - item.enqueuedAt) });
      }
    } catch (error) {
      const pending = this.queue.splice(0);
      for (const item of pending) item.reject(error);
    } finally {
      this.servicing = false;
    }
  }
}
