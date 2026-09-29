import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams } from "react-router";
import { AgentConsole } from "../../../components/AgentConsole";
import { RuntimeEndpointPicker } from "../../../components/RuntimeEndpointPicker";
import { RuntimePicker } from "../../../components/RuntimePicker";
import type { ScreenProps } from "../../types";
import { coreOptsFromCtx } from "../../utils";
import { RuntimeExecLaunchContextKey } from "./launchContext";

const execPath = (...parts: string[]) =>
  ["/agentcore/runtime/exec", ...parts.map(encodeURIComponent)].join("/");

export function RuntimeExecScreen({ ctx, core }: ScreenProps) {
  const { runtimeId, qualifier } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const opts = coreOptsFromCtx(ctx);
  const returnOnEscape = (location.state as { returnOnEscape?: boolean } | null)?.returnOnEscape;
  const launchContext = ctx.value(RuntimeExecLaunchContextKey);
  const initial = launchContext?.runtimeId === runtimeId ? launchContext : undefined;
  const detail = useQuery({
    queryKey: ["runtime", opts.region, runtimeId],
    queryFn: ({ signal }) => core.runtime.getRuntime(runtimeId!, opts, signal),
    enabled: runtimeId !== undefined && qualifier !== undefined,
  });

  if (!runtimeId) {
    return (
      <RuntimePicker
        ctx={ctx}
        core={core}
        breadcrumb={["agentcore", "runtime", "exec"]}
        description="choose a Runtime to exec into"
        onSelect={(id) => navigate(execPath(id))}
      />
    );
  }
  const breadcrumb = ["agentcore", "runtime", "exec", runtimeId];
  const pickEndpoint = ({
    onSelect,
    onEscape,
  }: {
    onSelect: (selected: string) => void;
    onEscape: () => void;
  }) => (
    <RuntimeEndpointPicker
      ctx={ctx}
      core={core}
      runtimeId={runtimeId}
      breadcrumb={breadcrumb}
      description="choose an endpoint to exec into"
      onSelect={onSelect}
      onEscape={onEscape}
    />
  );
  if (!qualifier) {
    return pickEndpoint({
      onSelect: (selected) =>
        navigate(execPath(runtimeId, selected), {
          replace: returnOnEscape === true,
          state: returnOnEscape ? { returnOnEscape } : undefined,
        }),
      onEscape: () => (returnOnEscape ? navigate(-1) : navigate(execPath())),
    });
  }
  return (
    <AgentConsole
      key={`${runtimeId}/${qualifier}`}
      breadcrumb={breadcrumb}
      target={{
        arn: detail.data?.agentRuntimeArn,
        isPending: detail.isPending,
        error: detail.error,
      }}
      execute={(request, signal) => core.runtime.invokeAgentRuntimeCommand(request, opts, signal)}
      initialSessionId={initial?.runtimeSessionId}
      initialQualifier={qualifier}
      timeout={initial?.timeout}
      pickEndpoint={pickEndpoint}
      onBack={() => (returnOnEscape ? navigate(-1) : navigate(execPath(runtimeId)))}
    />
  );
}
