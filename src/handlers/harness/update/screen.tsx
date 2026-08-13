import { Text } from "ink";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import type { ScreenProps } from "../../types";
import { coreOptsFromCtx } from "../../utils";
import { HarnessPicker } from "../../../components/HarnessPicker";
import { HarnessWizard, fromHarness } from "../../../components/HarnessWizard";
import { useFinishFlow } from "../../../components/useFinishFlow";
import { Layout } from "../../../components/Layout";
import { Spinner } from "../../../components/ui/spinner";

// HarnessUpdateScreen is the interactive update-harness flow. Without a
// `:harnessId` route value it renders a harness picker; with one it loads the
// current configuration and reuses the create wizard's steps, prefilled, ending
// in an UpdateHarness call (which creates a new version).
export function HarnessUpdateScreen(props: ScreenProps) {
  const navigate = useNavigate();
  const { harnessId } = useParams();

  if (!harnessId) {
    return (
      <HarnessPicker
        {...props}
        breadcrumb={["agentcore", "harness", "update"]}
        description="choose a harness to update"
        onSelect={(id) => navigate(`/agentcore/harness/update/${id}`)}
      />
    );
  }
  return <UpdateWizard {...props} harnessId={harnessId} />;
}

function UpdateWizard({ ctx, core, harnessId }: ScreenProps & { harnessId: string }) {
  const opts = coreOptsFromCtx(ctx);
  const finishFlow = useFinishFlow("/agentcore/harness");

  // The wizard seeds its form state once on mount, so it renders only after the
  // current configuration has arrived.
  const detail = useQuery({
    queryKey: ["harness", opts.region, harnessId],
    queryFn: () => core.harness.getHarness(harnessId, opts),
  });
  const rolePolicyWarning = useQuery({
    queryKey: ["harness-role-policy-warning", opts.region, harnessId],
    queryFn: async () => (await core.harness.getHarnessRolePolicyWarning(harnessId, opts)) ?? null,
  });

  if (
    detail.isPending ||
    detail.isError ||
    rolePolicyWarning.isPending ||
    rolePolicyWarning.isError
  ) {
    return (
      <Layout
        breadcrumb={["agentcore", "harness", "update", harnessId]}
        keyHints={[
          { key: "esc", label: "back" },
          { key: "ctl+c", label: "quit" },
        ]}
      >
        {detail.isPending || rolePolicyWarning.isPending ? (
          <Spinner label="loading harness…" />
        ) : (
          <Text color="red">
            Error: {((detail.error ?? rolePolicyWarning.error) as Error).message}
          </Text>
        )}
      </Layout>
    );
  }

  return (
    <HarnessWizard
      ctx={ctx}
      core={core}
      mode="update"
      harnessId={harnessId}
      breadcrumb={["agentcore", "harness", "update", harnessId]}
      initial={fromHarness(detail.data.harness!)}
      rolePolicyWarning={rolePolicyWarning.data ?? undefined}
      onDone={(id) => finishFlow(`/agentcore/harness/get/${id}`)}
    />
  );
}
