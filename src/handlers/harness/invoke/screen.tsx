import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { AgentConsole } from "../../../components/AgentConsole";
import { HarnessPicker } from "../../../components/HarnessPicker";
import { HarnessEndpointPicker } from "../../../components/HarnessEndpointPicker";
import type { ScreenProps } from "../../types";
import { coreOptsFromCtx } from "../../utils";

export function HarnessInvokeScreen(props: ScreenProps) {
  const { harnessId, sessionId } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  if (!harnessId) {
    return (
      <HarnessPicker
        {...props}
        breadcrumb={["agentcore", "harness", "invoke"]}
        description="choose a harness to chat with"
        onSelect={(id) => navigate(`/agentcore/harness/invoke/${id}`)}
      />
    );
  }
  return (
    <HarnessChat
      {...props}
      harnessId={harnessId}
      initialSessionId={sessionId}
      initialQualifier={search.get("qualifier") ?? undefined}
      variant="invoke"
    />
  );
}

type HarnessChatProps = ScreenProps & {
  harnessId: string;
  initialSessionId?: string;
  initialQualifier?: string;
  timeout?: number;
  variant: "invoke" | "exec";
  onBack?: () => void;
};

export function HarnessChat({
  ctx,
  core,
  harnessId,
  variant,
  onBack,
  ...initial
}: HarnessChatProps) {
  const opts = coreOptsFromCtx(ctx);
  const navigate = useNavigate();
  const detail = useQuery({
    queryKey: ["harness", opts.region, harnessId],
    queryFn: () => core.harness.getHarness(harnessId, opts),
  });
  return (
    <AgentConsole
      {...initial}
      breadcrumb={["agentcore", "harness", variant, harnessId]}
      target={{ arn: detail.data?.harness?.arn, isPending: detail.isPending, error: detail.error }}
      execute={(request, signal) => core.harness.invokeAgentRuntimeCommand(request, opts, signal)}
      invoke={(request, signal) => core.harness.invokeHarness(request, opts, signal)}
      initialMode={variant === "invoke" ? "chat" : "exec"}
      onBack={onBack ?? (() => navigate(-1))}
      pickEndpoint={({ onSelect, onEscape }) => (
        <HarnessEndpointPicker
          ctx={ctx}
          core={core}
          harnessId={harnessId}
          breadcrumb={["agentcore", "harness", variant, harnessId, "endpoint"]}
          description="choose the endpoint to use"
          onSelect={onSelect}
          onEscape={onEscape}
        />
      )}
    />
  );
}
