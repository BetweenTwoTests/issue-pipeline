import { execFile } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  input?: string;
}

interface ExecFileError extends Error {
  code?: number | string;
  stdout?: string;
  stderr?: string;
}

/** Always invoked with an argv array -- never shell-interpolated, so issue/PR
 * titles and bodies containing arbitrary text (including shell metacharacters)
 * can never be interpreted as shell syntax. */
export function runCommand(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 20 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const execError = error as ExecFileError;
          execError.stdout = stdout;
          execError.stderr = stderr;
          reject(execError);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    if (opts.input !== undefined) {
      child.stdin?.write(opts.input);
    }
    child.stdin?.end();
  });
}

export function isExecFileError(err: unknown): err is ExecFileError {
  return err instanceof Error;
}
