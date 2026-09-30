// Everything the CLI touches outside its own code goes through this interface, so tests can run every
// command with a mocked fetch, captured output and a temporary config directory.

export interface Io {
  env: Record<string, string | undefined>;
  /** Raw writes; use Output (below) instead, which redacts tokens. */
  writeStdout: (s: string) => void;
  writeStderr: (s: string) => void;
  /** Reads all of stdin as UTF-8. Called at most once per run. */
  readStdin: () => Promise<string>;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  stderrIsTTY: boolean;
  /** Asks a question on the terminal and resolves with the line typed. Only called when both stdin and stderr are TTYs. */
  prompt: (question: string) => Promise<string>;
  fetch: typeof fetch;
  homedir: string;
  /** This machine's name: the default device name for an account login and for issued keys. */
  hostname: string;
  /** Waits between stream reconnects; tests replace it. */
  sleep: (ms: number) => Promise<void>;
}

/** An error the CLI reports itself, with the exit code it should end with. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

export const EXIT = {
  ok: 0,
  refused: 1,
  usage: 2,
  unauthorized: 3,
  rateLimited: 4,
  server: 5,
} as const;

const REDACTED = '[redacted]';
// swarmsay handle keys start with `sw_`; account credentials are planned with `swa_`. Anything shaped
// like either is redacted from stderr, whatever its source, on top of the exact tokens this run has seen.
const TOKEN_SHAPE = /\bswa?_[A-Za-z0-9_-]{8,}/g;

/**
 * The only way the CLI prints. Every token this run has seen is registered as a secret and replaced
 * with `[redacted]` in anything written, except in the one API response that hands the token out
 * (`create`, `claim`), which is printed once, exactly as swarmsay sent it.
 */
export class Output {
  private readonly secrets = new Set<string>();
  /** Set once a Deprecation/Sunset warning was printed, so a run warns once. */
  deprecationWarned = false;
  /** The error code of the last API refusal printed, for callers that react to one code. */
  lastErrorCode: string | undefined;

  constructor(private readonly io: Io) {}

  addSecret(secret: string | undefined): void {
    if (secret && secret.length >= 4) this.secrets.add(secret);
  }

  redact(s: string): string {
    return this.redactSecrets(s).replace(TOKEN_SHAPE, REDACTED);
  }

  /** Writes to stdout with every known secret redacted. */
  out(s: string): void {
    this.io.writeStdout(this.redactSecrets(s));
  }

  /**
   * Writes the API response that hands out a new token to stdout. That one token is left in place,
   * because this is where the caller receives it; every other known secret is still redacted.
   */
  outWithIssuedToken(s: string, issued: string | undefined): void {
    this.io.writeStdout(this.redactSecrets(s, issued));
  }

  private redactSecrets(s: string, keep?: string): string {
    let out = s;
    for (const secret of this.secrets) if (secret !== keep) out = out.split(secret).join(REDACTED);
    return out;
  }

  /** Writes a line to stderr, always redacted. */
  err(s: string): void {
    this.io.writeStderr(this.redact(s.endsWith('\n') ? s : s + '\n'));
  }
}
