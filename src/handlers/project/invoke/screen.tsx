import { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp } from "ink";
import { Layout } from "../../../components/Layout";
import { RuntimeEndpointPicker } from "../../../components/RuntimeEndpointPicker";
import { DataTable, type DataTableColumn } from "../../../components/ui/data-table";
import { Spinner } from "../../../components/ui/spinner";
import { ProjectStateError } from "../../../errors/errors";
import { ProjectKey, type Context } from "../../../router";
import { HarnessChat } from "../../harness/invoke/screen";
import { RegionKey } from "../../keys";
import { RuntimeInvokeConsole } from "../../runtime/invoke/screen";
import type { ScreenProps } from "../../types";
import type { Project } from "../types";

type ProjectInvokableRow = Record<string, unknown> & {
  resourceType: "runtime" | "harness";
  type: "Runtime" | "Harness";
  name: string;
  protocol: string;
  source: string;
};

const columns = [
  { key: "type", header: "type", width: 10 },
  { key: "name", header: "name", flex: true },
  { key: "protocol", header: "protocol", width: 10 },
  { key: "source", header: "source", width: 24 },
] satisfies DataTableColumn<ProjectInvokableRow>[];

type Destination =
  | { resourceType: "runtime"; id: string; ctx: Context; qualifier?: string }
  | { resourceType: "harness"; id: string; ctx: Context };

export function ProjectInvokePickerScreen({ ctx, core }: ScreenProps) {
  const { exit } = useApp();
  const [project, setProject] = useState<Project | undefined>(() => ctx.value(ProjectKey));
  const [destination, setDestination] = useState<Destination>();
  const [resolving, setResolving] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (project) return;
    let active = true;
    const from = process.cwd();
    void core.projectManager
      .resolve({ filePath: from })
      .then((resolved) => {
        if (!active) return;
        if (!resolved) {
          exit(
            new ProjectStateError(
              `No AgentCore project found at ${from} or any parent directory ` +
                `(looked for agentcore/agentcore.json). ` +
                `Run 'agentcore project create' to scaffold one.`,
            ),
          );
          return;
        }
        setProject(resolved);
      })
      .catch((cause: unknown) => {
        if (active) exit(cause instanceof Error ? cause : new Error(String(cause)));
      });
    return () => {
      active = false;
    };
  }, [core.projectManager, exit, project]);

  const rows = useMemo<ProjectInvokableRow[]>(
    () => [
      ...(project?.spec.runtimes ?? []).map(({ name, protocol, codeLocation }) => ({
        resourceType: "runtime" as const,
        type: "Runtime" as const,
        name,
        protocol: protocol ?? "HTTP",
        source: codeLocation,
      })),
      ...(project?.spec.harnesses ?? []).map(({ name, path }) => ({
        resourceType: "harness" as const,
        type: "Harness" as const,
        name,
        protocol: "-",
        source: path,
      })),
    ],
    [project],
  );

  const select = async (row: ProjectInvokableRow) => {
    if (!project || resolving) return;
    setError(undefined);
    setResolving(row.name);
    try {
      const deployed = await core.projectManager.resolveDeployedResource(project, {
        target: "default",
        resourceType: row.resourceType,
        name: row.name,
      });
      setDestination({
        resourceType: row.resourceType,
        id: deployed.id,
        ctx: ctx.withValue(RegionKey, deployed.target.region),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setResolving(undefined);
    }
  };

  if (destination?.resourceType === "runtime") {
    if (!destination.qualifier) {
      return (
        <RuntimeEndpointPicker
          ctx={destination.ctx}
          core={core}
          runtimeId={destination.id}
          breadcrumb={["agentcore", "runtime", "invoke", destination.id]}
          description="choose an endpoint to invoke"
          onSelect={(qualifier) => setDestination({ ...destination, qualifier })}
          onEscape={() => setDestination(undefined)}
        />
      );
    }
    return (
      <RuntimeInvokeConsole
        ctx={destination.ctx}
        core={core}
        runtimeId={destination.id}
        qualifier={destination.qualifier}
        onBack={() => setDestination(undefined)}
      />
    );
  }

  if (destination?.resourceType === "harness") {
    return (
      <HarnessChat
        ctx={destination.ctx}
        core={core}
        harnessId={destination.id}
        variant="invoke"
        onBack={() => setDestination(undefined)}
      />
    );
  }

  if (!project) {
    return (
      <Layout
        breadcrumb={["agentcore", "project", "invoke"]}
        description="resolving the current project"
        keyHints={[{ key: "ctl+c", label: "quit" }]}
      >
        <Spinner label="Resolving project…" />
      </Layout>
    );
  }

  return (
    <Layout
      breadcrumb={["agentcore", "project", "invoke"]}
      description="choose a project resource to invoke on target default"
      keyHints={[
        { key: "↑↓/jk", label: "navigate" },
        { key: "/", label: "filter" },
        { key: "enter", label: "select" },
        { key: "esc", label: "cancel" },
        { key: "ctl+c", label: "quit" },
      ]}
    >
      <Box flexDirection="column">
        {error ? <Text color="red">{error}</Text> : null}
        <DataTable
          borderStyle="none"
          borderTop={false}
          borderBottom={false}
          borderRight={false}
          showFooter={false}
          focus={!resolving}
          columns={columns}
          data={rows}
          emptyMessage="No Runtimes or Harnesses are configured in this project."
          onSelect={(row) => void select(row)}
          onEscape={exit}
        />
        {resolving ? <Spinner label={`Resolving ${resolving}…`} /> : null}
      </Box>
    </Layout>
  );
}
