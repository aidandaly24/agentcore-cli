import { useEffect, useRef } from "react";
import { useApp, useStderr, useStdin, useStdout } from "ink";
import { useNavigate } from "react-router";
import { SilentCLIError } from "../errors";
import type { AppIO } from "../io";
import { Spinner } from "./ui/spinner";

type ShellHandoffProps = {
  label: string;
  returnPath?: string;
  run: (io: AppIO) => Promise<void>;
};

export function ShellHandoff({ label, returnPath, run }: ShellHandoffProps) {
  const { exit, suspendTerminal } = useApp();
  const { stdin } = useStdin();
  const { stdout } = useStdout();
  const { stderr } = useStderr();
  const navigate = useNavigate();
  const requested = useRef(false);

  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    void (async () => {
      try {
        await suspendTerminal(() => run({ stdin, stdout, stderr }));
      } catch (error) {
        if (returnPath === undefined || !(error instanceof SilentCLIError)) {
          exit(error);
          return;
        }
      }
      if (returnPath === undefined) exit();
      else navigate(returnPath, { replace: true });
    })();
  }, [exit, navigate, returnPath, run, stderr, stdin, stdout, suspendTerminal]);

  return <Spinner label={label} />;
}
