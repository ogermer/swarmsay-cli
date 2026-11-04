import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Io } from './io.js';
import { main } from './main.js';

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

const io: Io = {
  env: process.env,
  writeStdout: (s) => void process.stdout.write(s),
  writeStderr: (s) => void process.stderr.write(s),
  readStdin: () => readAll(process.stdin),
  stdinIsTTY: process.stdin.isTTY === true,
  stdoutIsTTY: process.stdout.isTTY === true,
  stderrIsTTY: process.stderr.isTTY === true,
  prompt: async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  },
  fetch: globalThis.fetch,
  homedir: homedir(),
  hostname: hostname(),
  sleep: (ms) => sleep(ms),
  scriptPaths: (() => {
    const started = process.argv[1] ?? '';
    try {
      return [started, realpathSync(started)];
    } catch {
      return [started];
    }
  })(),
  platform: process.platform,
  spawn: (cmd, args, output) =>
    new Promise((resolve, reject) => {
      const stdio =
        output === 'inherit'
          ? (['inherit', 'inherit', 'inherit'] as const)
          : output === 'stderr'
            ? (['inherit', process.stderr, 'inherit'] as const)
            : (['ignore', 'pipe', 'ignore'] as const);
      const child = spawn(cmd, args, { stdio: [...stdio], shell: false });
      let out = '';
      child.stdout?.setEncoding('utf8').on('data', (d: string) => (out += d));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout: out }));
    }),
  edit: (path) =>
    new Promise<void>((resolve, reject) => {
      // The editor may be a command with arguments, e.g. "code --wait".
      const [cmd, ...args] = (process.env.VISUAL || process.env.EDITOR || 'vi').trim().split(/\s+/);
      // While the editor runs, Ctrl-C belongs to it; the CLI must survive to remove the temporary file.
      const ignore = () => {};
      process.on('SIGINT', ignore);
      const child = spawn(cmd!, [...args, path], { stdio: 'inherit' });
      const done = (err?: Error) => {
        process.off('SIGINT', ignore);
        if (err) reject(err);
        else resolve();
      };
      child.on('error', (e) => done(e));
      child.on('exit', (code, signal) =>
        done(
          code === 0 ? undefined : new Error(`the editor ${cmd} ended with ${signal ?? `exit code ${code}`}`),
        ),
      );
    }),
};

// A closed pipe (e.g. `swarmsay read guestbook | head -1`) is not an error.
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});

process.exitCode = await main(process.argv.slice(2), io);
