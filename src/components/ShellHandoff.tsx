import { useEffect, useRef, useState } from "react";
import { Text, useApp, useInput, useStderr, useStdin, useStdout } from "ink";
import { useLocation, useNavigate } from "react-router";
import { AgentCoreCLIError, SilentCLIError } from "../errors";
import type { AppIO } from "../io";
import { Layout } from "./Layout";
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
  const location = useLocation();
  const navigate = useNavigate();
  const requested = useRef(false);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);

  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") exit();
      else if (key.escape) {
        navigate(returnPath ?? location.pathname.slice(0, location.pathname.lastIndexOf("/")), {
          replace: true,
        });
      } else if (input === "r") {
        requested.current = false;
        setError(null);
        setAttempt((current) => current + 1);
      }
    },
    { isActive: error !== null },
  );

  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    void (async () => {
      try {
        await suspendTerminal(() => run({ stdin, stdout, stderr }));
      } catch (caught) {
        if (!(caught instanceof SilentCLIError)) {
          setError(AgentCoreCLIError.fromError(caught));
          return;
        }
        if (returnPath === undefined) {
          exit(caught);
          return;
        }
      }
      if (returnPath === undefined) exit();
      else navigate(returnPath, { replace: true });
    })();
  }, [attempt, exit, navigate, returnPath, run, stderr, stdin, stdout, suspendTerminal]);

  if (error) {
    return (
      <Layout
        breadcrumb={location.pathname.split("/").filter(Boolean).map(decodeURIComponent)}
        keyHints={[
          { key: "r", label: "retry" },
          { key: "esc", label: "back" },
          { key: "ctrl+c", label: "quit" },
        ]}
      >
        <Text color="red">Error: {error.message}</Text>
      </Layout>
    );
  }
  return <Spinner label={label} />;
}
