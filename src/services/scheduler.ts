export interface SchedulerConfig {
  readonly intervalMs: number;
  readonly runOnStart: boolean;
  readonly run: () => Promise<void>;
  readonly onRunFailure?: (error: unknown) => Promise<void> | void;
  readonly onNextRunScheduled?: (nextRunAt: Date) => void;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly log?: (message: string) => void;
}

export interface Scheduler {
  readonly done: Promise<void>;
  isRunning(): boolean;
  stop(): void;
}

let activeScheduler: Scheduler | null = null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateConfig(config: SchedulerConfig): void {
  if (!Number.isFinite(config.intervalMs) || config.intervalMs <= 0) {
    throw new Error("Scheduler interval must be greater than zero");
  }
}

export function start(config: SchedulerConfig): Scheduler {
  validateConfig(config);

  let stopping = false;
  let running = false;
  let wakeWait: (() => void) | null = null;
  const wait =
    config.wait ??
    ((milliseconds: number): Promise<void> =>
      new Promise((resolve) => {
        const timeout = setTimeout(() => {
          wakeWait = null;
          resolve();
        }, milliseconds);
        wakeWait = () => {
          clearTimeout(timeout);
          wakeWait = null;
          resolve();
        };
      }));
  const log =
    config.log ??
    ((message: string): void => {
      console.log("[scheduler] " + message);
    });
  const isStopping = (): boolean => stopping;

  const execute = async (): Promise<void> => {
    running = true;
    try {
      await config.run();
    } catch (error) {
      log("run failed: " + errorMessage(error));
      try {
        await config.onRunFailure?.(error);
      } catch (alertError) {
        log("failure handler failed: " + errorMessage(alertError));
      }
    } finally {
      running = false;
    }
  };

  const done = (async (): Promise<void> => {
    if (config.runOnStart && !isStopping()) {
      await execute();
    }

    while (!isStopping()) {
      const nextRunAt = new Date(Date.now() + config.intervalMs);
      log("Next run scheduled at " + nextRunAt.toISOString());
      config.onNextRunScheduled?.(nextRunAt);
      await wait(config.intervalMs);
      if (!isStopping()) await execute();
    }
  })();

  const scheduler: Scheduler = {
    done,
    isRunning: () => running,
    stop: () => {
      stopping = true;
      wakeWait?.();
    },
  };
  activeScheduler = scheduler;
  void done.finally(() => {
    if (activeScheduler === scheduler) activeScheduler = null;
  });
  return scheduler;
}

export function stop(): void {
  activeScheduler?.stop();
}

export async function runOnce(config: Pick<SchedulerConfig, "run">): Promise<void> {
  await config.run();
}
