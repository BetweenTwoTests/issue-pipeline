import { spawn } from "node:child_process";

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface SpawnWithTimeoutInput {
  cwd: string;
  stdinData?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  /** Called periodically with the last non-empty output line while the
   * process runs. Wired to Temporal's Context.heartbeat() so a hung CLI is
   * detected well before startToCloseTimeout, and `temporal workflow show`
   * doubles as a progress viewer. */
  onProgress?: (lastLine: string) => void;
  heartbeatIntervalMs?: number;
}

export function spawnWithTimeout(bin: string, args: string[], opts: SpawnWithTimeoutInput): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let lastLine = "";
    const maxBytes = opts.maxOutputBytes ?? 20 * 1024 * 1024;

    const killHard = () => {
      child.kill("SIGTERM");
      const forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
      forceKillTimer.unref();
    };
    const killTimer = setTimeout(() => {
      timedOut = true;
      killHard();
    }, opts.timeoutMs);
    killTimer.unref();

    const onAbort = () => {
      timedOut = true;
      killHard();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    if (opts.onProgress) {
      heartbeatTimer = setInterval(() => opts.onProgress?.(lastLine), opts.heartbeatIntervalMs ?? 10_000);
      heartbeatTimer.unref();
    }

    const trackLastLine = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      const lines = text.split("\n").filter((l) => l.trim().length > 0);
      if (lines.length > 0) lastLine = lines[lines.length - 1];
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < maxBytes) stdout += chunk.toString("utf8");
      trackLastLine(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < maxBytes) stderr += chunk.toString("utf8");
      trackLastLine(chunk);
    });
    child.on("error", (err) => {
      clearTimeout(killTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (exitCode) => {
      clearTimeout(killTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, exitCode, timedOut });
    });

    if (opts.stdinData !== undefined) child.stdin.write(opts.stdinData);
    child.stdin.end();
  });
}

/**
 * Best-effort: returns undefined outside a real Temporal activity context
 * (e.g. unit tests) instead of throwing, so adapters stay testable without a
 * running worker. Deferred require avoids a hard dependency for callers that
 * don't run inside Temporal.
 */
export function tryGetActivityCancellationSignal(): AbortSignal | undefined {
  try {
    // Deliberately require(), not a static import: this must be lazy and
    // catchable (Context.current() throws outside a real activity context),
    // which a top-level `import` cannot do.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Context } = require("@temporalio/activity") as typeof import("@temporalio/activity");
    return Context.current().cancellationSignal;
  } catch {
    return undefined;
  }
}

/** Best-effort: no-op outside a real Temporal activity context (see above). */
export function tryHeartbeat(details?: unknown): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Context } = require("@temporalio/activity") as typeof import("@temporalio/activity");
    Context.current().heartbeat(details);
  } catch {
    // not running inside a Temporal activity (e.g. a unit test) -- fine to skip
  }
}
