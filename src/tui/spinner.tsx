import { render } from "ink";
import { Spinner } from "../components/ui/spinner";
import type { AppIO } from "../io";

export async function runWithSpinner<T>(
  operation: (stop: () => Promise<void>) => Promise<T>,
  options: { io: AppIO; label: string; enabled: boolean },
): Promise<T> {
  const instance =
    options.enabled && options.io.stderr.isTTY === true && process.env.INK_SCREEN_READER !== "true"
      ? render(<Spinner label={options.label} />, {
          stdout: options.io.stderr,
          stderr: options.io.stderr,
          stdin: options.io.stdin,
          interactive: true,
          exitOnCtrlC: false,
          patchConsole: false,
        })
      : undefined;

  let stopped: Promise<void> | undefined;
  const stop = () =>
    (stopped ??= (async () => {
      process.off("SIGINT", stopOnInterrupt);
      if (!instance) return;
      instance.clear();
      instance.unmount();
      await instance.waitUntilExit();
    })());

  // Stop before Ink handles an interrupt outside a cancellable request (e.g. lookup).
  // A once listener removes itself before Ink checks for other SIGINT handlers.
  const stopOnInterrupt = () => {
    void stop();
  };
  if (instance) process.prependOnceListener("SIGINT", stopOnInterrupt);

  try {
    // stdout and stderr can share a terminal; stop before either receives results.
    return await operation(stop);
  } finally {
    await stop();
  }
}
