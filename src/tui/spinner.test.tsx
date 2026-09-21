import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { UserCancellationError } from "../errors";
import { withUserCancellation } from "../runnable";
import { testIO } from "../testing/testIO";
import { tick, waitFor } from "../testing/timing";
import { runWithSpinner } from "./spinner";

test.each([0, 180])(
  "SIGINT stops animation once even when cancellation takes %i ms",
  async (delay) => {
    const io = testIO({ isTTY: true });
    const pending = runWithSpinner(
      () =>
        withUserCancellation(
          (signal) =>
            new Promise<never>((_, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  setTimeout(() => reject(signal.reason), delay);
                },
                { once: true },
              );
            }),
        ),
      { io: io.io, label: "Pending request", enabled: true },
    );
    const outcome = pending.catch((error: unknown) => error);
    let interrupted = false;
    try {
      await waitFor(() => io.stderr().includes("Pending request"));
      const beforeInterrupt = io.stderr().length;
      process.emit("SIGINT", "SIGINT");
      interrupted = true;
      await waitFor(() => io.stderr().includes("\u001b[?25h"));
      const stopped = io.stderr();
      expect(await outcome).toBeInstanceOf(UserCancellationError);
      await tick(120);
      expect(io.stderr()).toBe(stopped);
      const teardown = io.stderr().slice(beforeInterrupt);
      expect(teardown).not.toContain("Pending request");
      expect(teardown.split("\u001b[1A").length - 1).toBe(1);
    } finally {
      if (!interrupted) process.emit("SIGINT", "SIGINT");
      await outcome;
    }
  },
);

test("SIGINT clears progress and still exits when the operation has no cancellation handler", async () => {
  const modulePath = fileURLToPath(new URL("./spinner.tsx", import.meta.url));
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
import { runWithSpinner } from ${JSON.stringify(modulePath)};
Object.defineProperty(process.stderr, "isTTY", { value: true });
await runWithSpinner(
  () => new Promise(() => {}),
  { io: process, label: "Pending lookup", enabled: true },
);
`,
    ],
    {
      stdout: "ignore",
      stderr: "pipe",
      env: { ...process.env, INK_SCREEN_READER: "false", FORCE_COLOR: "0" },
    },
  );
  let output = "";
  const capture = (async () => {
    const reader = child.stderr.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += decoder.decode(chunk.value, { stream: true });
    }
  })();
  try {
    await waitFor(() => output.includes("Pending lookup"), 3000);
    child.kill("SIGINT");
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, 1000);
    expect(await child.exited).toBe(130);
    await capture;
    expect(output.lastIndexOf("\u001b[2K")).toBeGreaterThan(output.lastIndexOf("Pending lookup"));
    expect(output).toContain("\u001b[?25h");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
    await capture;
  }
});
