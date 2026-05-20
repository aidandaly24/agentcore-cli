#!/usr/bin/env node
import { main } from './cli.js';
import { getErrorMessage } from './errors.js';

// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
(globalThis as any).__PREVIEW__ ??= process.env.BUILD_PREVIEW === '1';

// Strip cursor show/hide ANSI escapes from non-TTY stdout/stderr.
// ink (via cli-cursor) writes `\x1b[?25h` on exit, even when stdout is piped or
// redirected. That trailing escape corrupts machine-parseable output (e.g. the
// `--json` flag). Filter the two known cursor escapes while leaving real text
// alone. Real TTYs keep the escapes so interactive terminal behavior is
// unchanged.
// eslint-disable-next-line no-control-regex -- \x1b is the ANSI escape we are explicitly filtering
const CURSOR_ESCAPE_PATTERN = /\x1b\[\?25[hl]/g;
function patchStream(stream: NodeJS.WriteStream): void {
  if (stream.isTTY) return;
  const originalWrite = stream.write.bind(stream);
  stream.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk === 'string') {
      return originalWrite(chunk.replace(CURSOR_ESCAPE_PATTERN, ''), ...(rest as [never]));
    }
    if (chunk instanceof Buffer) {
      const filtered = chunk.toString('utf8').replace(CURSOR_ESCAPE_PATTERN, '');
      return originalWrite(filtered, ...(rest as [never]));
    }
    return originalWrite(chunk as never, ...(rest as [never]));
  }) as typeof stream.write;
}
patchStream(process.stdout);
patchStream(process.stderr);

// Global safety net — prevent raw stack traces from reaching the user
process.on('uncaughtException', err => {
  console.error(`Error: ${getErrorMessage(err)}`);
  process.exit(1);
});
process.on('unhandledRejection', reason => {
  console.error(`Error: ${getErrorMessage(reason)}`);
  process.exit(1);
});

main(process.argv).catch(err => {
  console.error(getErrorMessage(err));
  process.exit(1);
});
