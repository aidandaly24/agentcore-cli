import { randomUUID } from "node:crypto";
import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams } from "react-router";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import cliTruncate from "cli-truncate";
import { ExecOutput } from "../../../components/ExecOutput";
import { Layout } from "../../../components/Layout";
import { MultilineInput } from "../../../components/MultilineInput";
import { RuntimeEndpointPicker } from "../../../components/RuntimeEndpointPicker";
import { RuntimePicker } from "../../../components/RuntimePicker";
import { Divider } from "../../../components/ui/divider";
import { Spinner } from "../../../components/ui/spinner";
import { applyExecEvent, finishExec, newExecItem, type ExecItem } from "../../exec";
import type { ScreenProps } from "../../types";
import { coreOptsFromCtx } from "../../utils";
import { RuntimeExecLaunchContextKey, type RuntimeExecLaunchContext } from "./launchContext";

const execPath = (...parts: string[]) =>
  ["/agentcore/runtime/exec", ...parts.map(encodeURIComponent)].join("/");

export function RuntimeExecScreen(props: ScreenProps) {
  const { runtimeId, qualifier } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const returnOnEscape = (location.state as { returnOnEscape?: boolean } | null)?.returnOnEscape;
  const launchContext = props.ctx.value(RuntimeExecLaunchContextKey);

  if (!runtimeId) {
    return (
      <RuntimePicker
        {...props}
        breadcrumb={["agentcore", "runtime", "exec"]}
        description="choose a Runtime to exec into"
        onSelect={(id) => navigate(execPath(id))}
      />
    );
  }
  if (!qualifier) {
    return (
      <RuntimeEndpointPicker
        {...props}
        runtimeId={runtimeId}
        breadcrumb={["agentcore", "runtime", "exec", runtimeId]}
        description="choose an endpoint to exec into"
        onSelect={(selected) =>
          navigate(execPath(runtimeId, selected), {
            replace: returnOnEscape === true,
            state: returnOnEscape ? { returnOnEscape } : undefined,
          })
        }
        onEscape={() => (returnOnEscape ? navigate(-1) : navigate(execPath()))}
      />
    );
  }
  return (
    <RuntimeExecConsole
      key={`${runtimeId}/${qualifier}`}
      {...props}
      runtimeId={runtimeId}
      qualifier={qualifier}
      initialContext={launchContext?.runtimeId === runtimeId ? launchContext : undefined}
      onBack={() => (returnOnEscape ? navigate(-1) : navigate(execPath(runtimeId)))}
    />
  );
}

function RuntimeExecConsole({
  ctx,
  core,
  runtimeId,
  qualifier: initialQualifier,
  initialContext,
  onBack,
}: ScreenProps & {
  runtimeId: string;
  qualifier: string;
  initialContext?: RuntimeExecLaunchContext;
  onBack: () => void;
}) {
  const opts = coreOptsFromCtx(ctx);
  const { columns, rows } = useWindowSize();
  const detail = useQuery({
    queryKey: ["runtime", opts.region, runtimeId],
    queryFn: ({ signal }) => core.runtime.getRuntime(runtimeId, opts, signal),
  });
  const [sessionId, setSessionId] = useState(
    () => initialContext?.runtimeSessionId ?? randomUUID(),
  );
  const [qualifier, setQualifier] = useState(initialQualifier);
  const [pickingEndpoint, setPickingEndpoint] = useState(false);
  const [input, setInput] = useState("");
  const [items, setItems] = useState<ExecItem[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const aliveRef = useRef(true);
  const scrollRef = useRef<ScrollViewRef>(null);
  const stickRef = useRef(true);
  const keepScrolledToBottom = useCallback(() => {
    if (stickRef.current) scrollRef.current?.scrollToBottom();
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const run = async (text: string) => {
    const command = text.trim();
    const arn = detail.data?.agentRuntimeArn;
    if (!command || !arn || abortRef.current) return;

    const item = newExecItem(command);
    const controller = new AbortController();
    abortRef.current = controller;
    stickRef.current = true;
    setInput("");
    setItems((current) => [...current, item]);
    const sync = () => {
      if (aliveRef.current) setItems((current) => [...current]);
    };
    try {
      const response = await core.runtime.invokeAgentRuntimeCommand(
        {
          agentRuntimeArn: arn,
          qualifier,
          runtimeSessionId: sessionId,
          body: { command, timeout: initialContext?.timeout },
        },
        opts,
        controller.signal,
      );
      if (aliveRef.current && response.runtimeSessionId) setSessionId(response.runtimeSessionId);
      for await (const event of response.stream ?? []) {
        if (!aliveRef.current) return;
        applyExecEvent(item, event);
        sync();
      }
    } catch (error) {
      item.status = "error";
      const message = controller.signal.aborted
        ? "interrupted"
        : error instanceof Error
          ? error.message
          : String(error);
      item.output += `${item.output && !item.output.endsWith("\n") ? "\n" : ""}${message}\n`;
    } finally {
      finishExec(item);
      abortRef.current = null;
      sync();
    }
  };

  useInput(
    (input, key) => {
      if (key.escape) {
        if (abortRef.current) abortRef.current.abort();
        else onBack();
        return;
      }
      if (key.ctrl && input === "t") {
        if (!abortRef.current) setPickingEndpoint(true);
        return;
      }
      const view = scrollRef.current;
      if (!view) return;
      if (key.upArrow || key.downArrow) {
        const next = Math.max(
          0,
          Math.min(view.getBottomOffset(), view.getScrollOffset() + (key.upArrow ? -1 : 1)),
        );
        view.scrollTo(next);
        stickRef.current = next >= view.getBottomOffset();
      }
    },
    { isActive: !pickingEndpoint },
  );

  if (pickingEndpoint) {
    return (
      <RuntimeEndpointPicker
        ctx={ctx}
        core={core}
        runtimeId={runtimeId}
        breadcrumb={["agentcore", "runtime", "exec", runtimeId]}
        description="choose an endpoint to exec into"
        onSelect={(selected) => {
          if (selected !== qualifier) {
            setQualifier(selected);
            setSessionId(randomUUID());
            setItems([]);
          }
          setPickingEndpoint(false);
        }}
        onEscape={() => setPickingEndpoint(false)}
      />
    );
  }
  const busy = items.at(-1)?.status === "running";
  const inputRows = Math.min(4, Math.max(1, input.split("\n").length));
  return (
    <Layout
      breadcrumb={["agentcore", "runtime", "exec", runtimeId, qualifier]}
      keyHints={
        busy
          ? [
              { key: "esc", label: "interrupt" },
              { key: "ctrl+c", label: "quit" },
            ]
          : [
              { key: "enter", label: "run" },
              { key: "ctrl+t", label: "endpoint" },
              { key: "\u2191\u2193", label: "scroll" },
              { key: "esc", label: "back" },
              { key: "ctrl+c", label: "quit" },
            ]
      }
    >
      {detail.isPending ? (
        <Spinner label="loading Runtime..." />
      ) : detail.isError ? (
        <Text color="red">Error: {detail.error.message}</Text>
      ) : !detail.data.agentRuntimeArn ? (
        <Text color="red">Runtime returned no ARN</Text>
      ) : (
        <Box flexDirection="column">
          <Box height={Math.max(1, rows - 7 - inputRows)} flexDirection="column">
            <ScrollView ref={scrollRef} onContentHeightChange={keepScrolledToBottom}>
              {items.map((item, index) => (
                <Box key={index} paddingBottom={1}>
                  <ExecOutput item={item} width={columns} />
                </Box>
              ))}
            </ScrollView>
          </Box>
          <Divider />
          <MultilineInput
            value={input}
            onChange={setInput}
            onSubmit={() => void run(input)}
            submitDisabled={busy}
            prompt="$ "
            placeholder="run a command..."
          />
          <Divider />
          <Box height={1}>
            {busy ? (
              <Spinner label="working..." />
            ) : (
              <Text color="gray">
                {cliTruncate(`session: ${sessionId} | qualifier: ${qualifier}`, columns)}
              </Text>
            )}
          </Box>
        </Box>
      )}
    </Layout>
  );
}
