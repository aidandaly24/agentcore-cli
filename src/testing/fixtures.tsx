import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "bun:test";
import {
  CreateGatewayCommand,
  CreateGatewayTargetCommand,
  DeleteGatewayTargetCommand,
  ListGatewayTargetsCommand,
  type BedrockAgentCoreControlClient,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import {
  CreateRoleCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  GetRoleCommand,
  GetRolePolicyCommand,
  ListRolePoliciesCommand,
  PutRolePolicyCommand,
  type IAMClient,
} from "@aws-sdk/client-iam";
import type { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import type {
  ClientConfig,
  CreateControlClient,
  CreateDataClient,
  CreateIamClient,
  CreateLogsClient,
} from "../core/types";
import {
  createControlClient,
  createDataClient,
  createIamClient,
  createLogsClient,
} from "../core/factories";
import { parse, stringify } from "./serialization";

// Golden-file record/replay for the AWS SDK seam.
//
// The whole suite runs in one of two modes, selected by the RECORD env var:
//
//   RECORD=1 bun test   — hit the live AWS APIs through the real client factories
//                         and save each response as a fixture (golden file).
//   bun test            — replay the saved fixtures; never touch the network.
//
// Recording plugs in at the SDK `.send()` seam (the same seam src/index.ts wires
// the real clients into), so replayed tests still exercise the real CoreClient,
// HarnessClient, and option translation — only the network call is swapped out.

// isRecording reports whether the suite should call the live APIs and refresh
// fixtures. Any truthy-ish RECORD value ("1", "true") turns it on.
export function isRecording(): boolean {
  const v = process.env.RECORD;
  return v === "1" || v === "true";
}

// settle waits out a service-side state transition between two calls that cannot
// overlap (e.g. AgentCore rejects an update while the resource is still UPDATING).
// It only sleeps while recording: on replay the fixtures are served from disk, so
// there is no state machine to wait for and the test stays fast and deterministic.
// Give the enclosing test a timeout that accommodates the wait.
export async function settle(ms = 5_000): Promise<void> {
  if (!isRecording()) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// An AWS SDK command as seen at the `.send()` boundary: its class carries the
// operation name and it holds the request `input`. We only read these.
interface SdkCommand {
  input: unknown;
  constructor: { name: string };
}

// fixturePath derives a stable, human-readable golden-file path for a command
// invocation: `<dir>/<Operation>.<inputHash>.json`. Keying on the input hash
// lets one operation have several fixtures (e.g. different harness IDs) while
// staying deterministic and offline-stable across runs.
function fixturePath(dir: string, command: SdkCommand): string {
  const op = command.constructor.name;
  const hash = Bun.hash(stringify(normalizeFixtureInput(command.input ?? {}))).toString(16);
  return join(dir, `${op}.${hash}.json`);
}

function normalizeFixtureInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeFixtureInput);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        key === "clientToken" ? "<generated-client-token>" : normalizeFixtureInput(entry),
      ]),
    );
  }
  return value;
}

// normalizeResponse strips volatile transport metadata from a recorded SDK
// response. `$metadata` holds the HTTP status, retry counts, and a per-request
// `requestId` — none of it domain data, all of it non-deterministic across
// recordings. Dropping it keeps fixtures stable and keeps golden output focused
// on behavior (the harness data) rather than transport implementation details.
// Handlers/screens never read `$metadata`, so this is behavior-preserving.
function normalizeResponse(response: unknown): unknown {
  if (response && typeof response === "object" && "$metadata" in response) {
    // eslint-disable-next-line no-unused-vars
    const { $metadata, ...rest } = response as Record<string, unknown>;
    return rest;
  }
  return response;
}

// Service errors are as much a part of a recorded flow as successes (e.g. the
// default-execution-role flow probes GetRole and expects NoSuchEntityException
// on a fresh account). A rejected send is recorded under this tag and re-thrown
// with the same name/message on replay.
const ERROR_TAG = "$error";

interface TaggedError {
  [ERROR_TAG]: { name: string; message: string };
}

function isTaggedError(value: unknown): value is TaggedError {
  return typeof value === "object" && value !== null && ERROR_TAG in value;
}

function reviveError(tagged: TaggedError): Error {
  const error = new Error(tagged[ERROR_TAG].message);
  error.name = tagged[ERROR_TAG].name;
  return error;
}

// makeRecordingSend returns a `.send()` that records to / replays from `dir`.
// In record mode it delegates to the real client, saves the response (or the
// service error), and propagates it; otherwise it reads the fixture, failing
// with an actionable message when one is missing.
function makeRecordingSend<C extends { send: (command: any) => Promise<any> }>(
  realClient: C,
  dir: string,
): (command: SdkCommand) => Promise<unknown> {
  return async (command: SdkCommand) => {
    const path = fixturePath(dir, command);

    if (isRecording()) {
      mkdirSync(dir, { recursive: true });
      let response: unknown;
      try {
        response = normalizeResponse(await realClient.send(command as never));
      } catch (error) {
        const tagged: TaggedError = {
          [ERROR_TAG]: { name: (error as Error).name, message: (error as Error).message },
        };
        writeFileSync(path, stringify(tagged));
        throw error;
      }
      writeFileSync(path, stringify(response));
      return response;
    }

    if (!existsSync(path)) {
      throw new Error(
        `Missing fixture ${path} for ${command.constructor.name}. ` +
          `Re-run with RECORD=1 to record it against the live API.`,
      );
    }
    const recorded = parse(readFileSync(path, "utf8"));
    if (isTaggedError(recorded)) throw reviveError(recorded);
    return recorded;
  };
}

function makeIamRecordingSend(
  realClient: IAMClient,
  dir: string,
): (command: SdkCommand) => Promise<unknown> {
  const recordedSend = makeRecordingSend(realClient, dir);
  const inlinePolicies = new Map<string, Map<string, string>>();
  const deletedPolicies = new Map<string, Set<string>>();
  const rolesCreatedInScenario = recordedCreatedRoleNames(dir);
  const existingRoles = new Set<string>();

  return async (command: SdkCommand) => {
    if (isRecording()) return recordedSend(command);

    if (command instanceof GetRoleCommand) {
      const roleName = command.input.RoleName;
      if (roleName && rolesCreatedInScenario.has(roleName) && !existingRoles.has(roleName)) {
        const error = new Error(`Role ${roleName} does not exist in replay state.`);
        error.name = "NoSuchEntityException";
        throw error;
      }
      return recordedSend(command);
    }

    if (command instanceof CreateRoleCommand) {
      const response = await recordedSend(command);
      if (command.input.RoleName) existingRoles.add(command.input.RoleName);
      return response;
    }

    if (command instanceof DeleteRoleCommand) {
      const response = await recordedSend(command);
      if (command.input.RoleName) existingRoles.delete(command.input.RoleName);
      return response;
    }

    if (command instanceof PutRolePolicyCommand) {
      const response = await recordedSend(command);
      const { RoleName, PolicyName, PolicyDocument } = command.input;
      if (RoleName && PolicyName && PolicyDocument) {
        let policies = inlinePolicies.get(RoleName);
        if (!policies) {
          policies = new Map();
          inlinePolicies.set(RoleName, policies);
        }
        policies.set(PolicyName, PolicyDocument);
        deletedPolicies.get(RoleName)?.delete(PolicyName);
      }
      return response;
    }

    if (command instanceof DeleteRolePolicyCommand) {
      const response = await recordedSend(command);
      const { RoleName, PolicyName } = command.input;
      if (RoleName && PolicyName) {
        inlinePolicies.get(RoleName)?.delete(PolicyName);
        let deleted = deletedPolicies.get(RoleName);
        if (!deleted) {
          deleted = new Set();
          deletedPolicies.set(RoleName, deleted);
        }
        deleted.add(PolicyName);
      }
      return response;
    }

    if (command instanceof GetRolePolicyCommand) {
      const { RoleName, PolicyName } = command.input;
      const current = RoleName && PolicyName ? inlinePolicies.get(RoleName)?.get(PolicyName) : null;
      if (current) {
        return {
          RoleName,
          PolicyName,
          PolicyDocument: encodeURIComponent(current),
        };
      }
      return recordedSend(command);
    }

    if (command instanceof ListRolePoliciesCommand) {
      const recorded = (await recordedSend(command)) as {
        PolicyNames?: string[];
        IsTruncated?: boolean;
        Marker?: string;
      };
      const roleName = command.input.RoleName;
      const deleted = roleName ? deletedPolicies.get(roleName) : undefined;
      const current = roleName ? inlinePolicies.get(roleName) : undefined;
      const policyNames = new Set(
        (recorded.PolicyNames ?? []).filter((policyName) => !deleted?.has(policyName)),
      );
      for (const policyName of current?.keys() ?? []) policyNames.add(policyName);
      return {
        ...recorded,
        PolicyNames: [...policyNames].sort(),
      };
    }

    return recordedSend(command);
  };
}

function recordedCreatedRoleNames(dir: string): Set<string> {
  if (!existsSync(dir)) return new Set();
  const names = new Set<string>();
  for (const file of readdirSync(dir).filter((name) => name.startsWith("CreateRoleCommand."))) {
    const response = parse(readFileSync(join(dir, file), "utf8")) as {
      Role?: { RoleName?: string };
    };
    if (response.Role?.RoleName) names.add(response.Role.RoleName);
  }
  return names;
}

function makeControlRecordingSend(
  realClient: BedrockAgentCoreControlClient,
  dir: string,
): (command: SdkCommand) => Promise<unknown> {
  const recordedSend = makeRecordingSend(realClient, dir);
  const targetIdsByGateway = new Map<string, Set<string>>();

  return async (command: SdkCommand) => {
    if (isRecording()) return recordedSend(command);

    if (command instanceof CreateGatewayCommand) {
      const response = (await recordedSend(command)) as { gatewayId?: string };
      if (response.gatewayId) targetIdsByGateway.set(response.gatewayId, new Set());
      return response;
    }

    if (command instanceof CreateGatewayTargetCommand) {
      const response = (await recordedSend(command)) as { targetId?: string };
      const gatewayId = command.input.gatewayIdentifier;
      if (gatewayId && response.targetId) {
        let targetIds = targetIdsByGateway.get(gatewayId);
        if (!targetIds) {
          targetIds = new Set();
          targetIdsByGateway.set(gatewayId, targetIds);
        }
        targetIds.add(response.targetId);
      }
      return response;
    }

    if (command instanceof DeleteGatewayTargetCommand) {
      const response = await recordedSend(command);
      const { gatewayIdentifier, targetId } = command.input;
      if (gatewayIdentifier && targetId) {
        targetIdsByGateway.get(gatewayIdentifier)?.delete(targetId);
      }
      return response;
    }

    if (command instanceof ListGatewayTargetsCommand) {
      const recorded = (await recordedSend(command)) as {
        items?: { targetId?: string }[];
      };
      const targetIds = command.input.gatewayIdentifier
        ? targetIdsByGateway.get(command.input.gatewayIdentifier)
        : undefined;
      if (!targetIds) return recorded;
      return {
        ...recorded,
        items: (recorded.items ?? []).filter(
          (target) => target.targetId && targetIds.has(target.targetId),
        ),
      };
    }

    return recordedSend(command);
  };
}

// fixtureFactories builds Core client factories backed by the golden files in
// `dir`. Drop these into `new CoreClient(...)` to run the real command flow
// (parsing → middleware → handler → CoreClient) against recorded data. The fake
// clients only implement `.send()`, which is all CoreClient uses.
export function fixtureFactories(dir: string): {
  createControlClient: CreateControlClient;
  createDataClient: CreateDataClient;
  createIamClient: CreateIamClient;
  createLogsClient: CreateLogsClient;
} {
  return {
    createControlClient: (config: ClientConfig) => {
      // The real client is only constructed to satisfy record mode; in replay
      // mode its `.send()` is never reached.
      const real = createControlClient(config);
      return {
        send: makeControlRecordingSend(real, dir),
      } as unknown as BedrockAgentCoreControlClient;
    },
    createDataClient: (config: ClientConfig) => {
      const real = createDataClient(config);
      return {
        send: makeRecordingSend(real, dir),
      } as unknown as BedrockAgentCoreClient;
    },
    createIamClient: (config: ClientConfig) => {
      const real = createIamClient(config);
      return {
        send: makeIamRecordingSend(real, dir),
      } as unknown as IAMClient;
    },
    createLogsClient: (config: ClientConfig) => {
      const real = createLogsClient(config);
      return {
        send: makeRecordingSend(real, dir),
      } as unknown as CloudWatchLogsClient;
    },
  };
}

// matchGolden compares `actual` against the golden file `<dir>/<name>`. In record
// mode it (re)writes the file; otherwise it asserts equality, so a behavior change
// surfaces as a reviewable golden diff. Use for asserting a command's rendered
// output rather than pinning exact strings inline.
//
// Trailing whitespace is ignored on both sides: golden files are committed and
// the pre-commit Prettier hook adds a final newline to *.json, which is not a
// behavior difference worth failing on.
export function matchGolden(dir: string, name: string, actual: string): void {
  const path = join(dir, name);

  if (isRecording()) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, actual);
    return;
  }

  if (!existsSync(path)) {
    throw new Error(`Missing golden file ${path}. Re-run with RECORD=1 to record expected output.`);
  }
  const expected = readFileSync(path, "utf8");
  expect(actual.replace(/\s+$/, "")).toBe(expected.replace(/\s+$/, ""));
}
