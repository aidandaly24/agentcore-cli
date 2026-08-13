import { randomUUID } from "node:crypto";
import {
  CreateHarnessCommand,
  CreateHarnessEndpointCommand,
  DeleteHarnessCommand,
  DeleteHarnessEndpointCommand,
  GetHarnessCommand,
  GetHarnessEndpointCommand,
  ListHarnessesCommand,
  ListHarnessEndpointsCommand,
  ListHarnessVersionsCommand,
  UpdateHarnessCommand,
  UpdateHarnessEndpointCommand,
  type CreateHarnessEndpointRequest,
  type CreateHarnessEndpointResponse,
  type CreateHarnessResponse,
  type DeleteHarnessEndpointRequest,
  type DeleteHarnessEndpointResponse,
  type DeleteHarnessRequest,
  type DeleteHarnessResponse,
  type GetHarnessResponse,
  type GetHarnessEndpointResponse,
  type ListHarnessesResponse,
  type ListHarnessEndpointsResponse,
  type ListHarnessVersionsResponse,
  type UpdateHarnessEndpointRequest,
  type UpdateHarnessEndpointResponse,
  type UpdateHarnessRequest,
  type UpdateHarnessResponse,
  type Harness,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  InvokeAgentRuntimeCommandCommand,
  InvokeHarnessCommand,
  type InvokeAgentRuntimeCommandRequest,
  type InvokeAgentRuntimeCommandResponse,
  type InvokeHarnessRequest,
  type InvokeHarnessResponse,
} from "@aws-sdk/client-bedrock-agentcore";
import type {
  CoreHarnessClient,
  CreateHarnessInput,
  HarnessUpdateInput,
} from "../handlers/harness/types";
import type { AwsClients, CoreOptions } from "./types";
import { abortable } from "./abortable";
import {
  CredentialProviderPolicyResolver,
  type CredentialProviderPolicyState,
} from "./credentialProviderPolicy";
import {
  ExecutionRoleManager,
  type ExecutionRoleManagerOptions,
  type ExecutionRolePolicyManagement,
} from "./executionRoleManager";
import {
  ExecutionRolePolicyUpdater,
  PolicyFinalizationError,
  PolicyOperationOutcomeUnknownError,
  type ExecutionRolePolicyUpdaterOptions,
} from "./executionRolePolicyUpdater";
import type { PolicyContribution } from "./executionRolePolicy";
import {
  HarnessPolicyPlanner,
  harnessCredentialProviderRequests,
  type HarnessPolicyState,
} from "./harnessPolicy";
import { toClientConfig } from "./utils";

const DEFAULT_WAIT_ATTEMPTS = 300;
const DEFAULT_WAIT_DELAY_MS = 2_000;

export type HarnessClientOptions = {
  policyUpdater?: ExecutionRolePolicyUpdaterOptions;
  roleManager?: ExecutionRoleManagerOptions;
  waitAttempts?: number;
  waitDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

type HarnessPolicyInventory = {
  harness: Harness;
  credentials: CredentialProviderPolicyState[];
};

type ManagedHarnessPolicy = Extract<ExecutionRolePolicyManagement, { mode: "managed" }>;

export class HarnessTerminalStateError extends Error {
  constructor(
    readonly harnessId: string,
    readonly status: string,
    readonly failureReason: string | undefined,
  ) {
    super(`Harness ${harnessId} reached ${status}` + (failureReason ? `: ${failureReason}` : "."));
    this.name = "HarnessTerminalStateError";
  }
}

export class HarnessOutcomeUnknownError extends Error {
  constructor(harnessId: string, options?: ErrorOptions) {
    super(`The final state of Harness ${harnessId} could not be determined.`, options);
    this.name = "HarnessOutcomeUnknownError";
  }
}

export class HarnessClient implements CoreHarnessClient {
  private readonly planner = new HarnessPolicyPlanner();
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly clients: AwsClients,
    private readonly options: HarnessClientOptions = {},
  ) {
    this.sleep = options.sleep ?? delay;
  }

  async getHarnessRolePolicyWarning(
    harnessId: string,
    options: CoreOptions,
  ): Promise<{ reason: "unknown-role"; roleArn: string } | undefined> {
    const harness = requiredHarness(await this.getHarness(harnessId, options), harnessId);
    const roleArn = harness.executionRoleArn;
    if (!roleArn) throw new Error(`Harness ${harnessId} returned no execution role ARN.`);
    const management = ExecutionRoleManager.policyManagement({
      associatedRoleArn: roleArn,
      expectedCliRoleName: expectedHarnessCliRoleName(harness),
    });
    return management.mode === "external" && management.reason === "unknown-role"
      ? { reason: "unknown-role", roleArn }
      : undefined;
  }

  async getHarness(id: string, options: CoreOptions): Promise<GetHarnessResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new GetHarnessCommand({ harnessId: id }));
  }

  async getHarnessVersion(
    id: string,
    version: string,
    options: CoreOptions,
  ): Promise<GetHarnessResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new GetHarnessCommand({ harnessId: id, harnessVersion: version }));
  }

  async getHarnessEndpoint(
    id: string,
    qualifier: string,
    options: CoreOptions,
  ): Promise<GetHarnessEndpointResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new GetHarnessEndpointCommand({ harnessId: id, endpointName: qualifier }));
  }

  async listHarnesses(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListHarnessesResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new ListHarnessesCommand({ nextToken, maxResults }));
  }

  async listHarnessEndpoints(
    id: string,
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListHarnessEndpointsResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new ListHarnessEndpointsCommand({ harnessId: id, nextToken, maxResults }));
  }

  async listHarnessVersions(
    id: string,
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListHarnessVersionsResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new ListHarnessVersionsCommand({ harnessId: id, nextToken, maxResults }));
  }

  async createHarness(
    input: CreateHarnessInput,
    options: CoreOptions,
  ): Promise<CreateHarnessResponse> {
    const { executionRoleArn, ...request } = input;
    const clientToken = request.clientToken ?? randomUUID();
    if (executionRoleArn) {
      return this.clients
        .control(toClientConfig(options))
        .send(new CreateHarnessCommand({ ...request, clientToken, executionRoleArn }));
    }

    const iam = this.clients.iam({ region: options.region });
    const roleManager = new ExecutionRoleManager(iam, this.options.roleManager);
    const managedRole = await roleManager.ensureCliRole({
      primitive: "harness",
      resourceName: input.harnessName!,
    });
    const policyName = ExecutionRoleManager.generatedPolicyName("harness", {
      accountId: accountIdFromRoleArn(managedRole.arn),
      region: options.region,
      stableResourceKey: managedRole.name,
    });
    const updater = this.policyUpdater(iam);

    try {
      const state = await this.enrichState(
        {
          region: options.region,
          accountId: accountIdFromRoleArn(managedRole.arn),
          harnessName: input.harnessName!,
          model: request.model,
          tools: request.tools,
          skills: request.skills,
          memory: request.memory,
          environment: request.environment,
          environmentArtifact: request.environmentArtifact,
        },
        options,
      );
      const result = await updater.update({
        roleName: managedRole.name,
        policyName,
        current: [],
        inventoryComplete: managedRole.created,
        desired: this.planner.plan(state),
        operation: () =>
          this.createHarnessAndWait(
            {
              ...request,
              clientToken,
              executionRoleArn: managedRole.arn,
            },
            options,
          ),
        operationRetry: {
          maxAttempts: 8,
          delayMs: 2_000,
          shouldRetry: isExecutionRolePropagationError,
        },
        isOperationOutcomeUnknown: (error) => error instanceof HarnessOutcomeUnknownError,
        resolveDesired: async ({ settled }) => {
          const inventory = await this.readPolicyInventory(settled.harnessId!, options, settled);
          return {
            contributions: this.planner.plan(this.policyState(inventory, options)),
            inventoryComplete: true,
          };
        },
      });
      return result.value.response;
    } catch (error) {
      if (
        error instanceof PolicyFinalizationError ||
        error instanceof PolicyOperationOutcomeUnknownError
      ) {
        throw error;
      }
      return roleManager.rollbackFailedCreate(managedRole, policyName, error);
    }
  }

  async updateHarness(
    input: HarnessUpdateInput,
    options: CoreOptions,
  ): Promise<UpdateHarnessResponse> {
    const { skipRolePolicyUpdate, ...request } = input;
    const updateRequest = { ...request, clientToken: request.clientToken ?? randomUUID() };
    if (skipRolePolicyUpdate) {
      return this.clients
        .control(toClientConfig(options))
        .send(new UpdateHarnessCommand(updateRequest));
    }
    const currentResponse = await this.getHarness(request.harnessId!, options);
    const current = requiredHarness(currentResponse, request.harnessId!);
    if (!current.executionRoleArn) {
      throw new Error(`Harness ${request.harnessId} returned no execution role ARN.`);
    }
    const management = ExecutionRoleManager.policyManagement({
      associatedRoleArn: current.executionRoleArn,
      explicitRoleArn: request.executionRoleArn,
      expectedCliRoleName: expectedHarnessCliRoleName(current),
    });
    if (management.mode === "external") {
      if (
        management.reason === "explicit-role" &&
        request.executionRoleArn !== current.executionRoleArn
      ) {
        const previous = ExecutionRoleManager.policyManagement({
          associatedRoleArn: current.executionRoleArn,
          expectedCliRoleName: expectedHarnessCliRoleName(current),
        });
        if (previous.mode === "managed") {
          const result = await this.policyUpdater(
            this.clients.iam({ region: options.region }),
          ).removeAfter({
            roleName: previous.roleName,
            policyName: harnessPolicyName(previous, current, options.region),
            operation: () => this.updateHarnessAndWait(updateRequest, options),
            isOperationOutcomeUnknown: (error) => error instanceof HarnessOutcomeUnknownError,
          });
          return result.response;
        }
      }
      return this.clients
        .control(toClientConfig(options))
        .send(new UpdateHarnessCommand(updateRequest));
    }

    const inventory = await this.readPolicyInventory(request.harnessId!, options, current);
    const desiredHarness = applyHarnessUpdate(current, request);
    const desiredState = await this.enrichState(
      this.policyState({ ...inventory, harness: desiredHarness }, options),
      options,
    );
    const result = await this.reconcileManaged({
      harnessId: request.harnessId!,
      management,
      current: inventory,
      desired: this.planner.plan(desiredState),
      operation: () => this.updateHarnessAndWait(updateRequest, options),
      options,
    });
    return result.response;
  }

  async deleteHarness(
    request: DeleteHarnessRequest,
    options: CoreOptions,
  ): Promise<DeleteHarnessResponse> {
    const current = requiredHarness(
      await this.getHarness(request.harnessId!, options),
      request.harnessId!,
    );
    if (!current.executionRoleArn) {
      throw new Error(`Harness ${request.harnessId} returned no execution role ARN.`);
    }
    const management = ExecutionRoleManager.policyManagement({
      associatedRoleArn: current.executionRoleArn,
      expectedCliRoleName: expectedHarnessCliRoleName(current),
    });
    const operation = () => this.deleteHarnessAndWait(request, options);
    if (management.mode === "external") {
      return this.clients.control(toClientConfig(options)).send(new DeleteHarnessCommand(request));
    }
    const result = await this.policyUpdater(
      this.clients.iam({ region: options.region }),
    ).removeAfter({
      roleName: management.roleName,
      policyName: harnessPolicyName(management, current, options.region),
      operation,
      isOperationOutcomeUnknown: (error) => error instanceof HarnessOutcomeUnknownError,
    });
    return result.response;
  }

  async createHarnessEndpoint(
    request: CreateHarnessEndpointRequest,
    options: CoreOptions,
  ): Promise<CreateHarnessEndpointResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new CreateHarnessEndpointCommand({ ...request }));
  }

  async updateHarnessEndpoint(
    request: UpdateHarnessEndpointRequest,
    options: CoreOptions,
  ): Promise<UpdateHarnessEndpointResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new UpdateHarnessEndpointCommand({ ...request }));
  }

  async deleteHarnessEndpoint(
    request: DeleteHarnessEndpointRequest,
    options: CoreOptions,
  ): Promise<DeleteHarnessEndpointResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new DeleteHarnessEndpointCommand({ ...request }));
  }

  private policyUpdater(iam: ReturnType<AwsClients["iam"]>): ExecutionRolePolicyUpdater {
    return new ExecutionRolePolicyUpdater(iam, {
      propagationDelayMs: 10_000,
      ...this.options.policyUpdater,
    });
  }

  private policyState(inventory: HarnessPolicyInventory, options: CoreOptions): HarnessPolicyState {
    const harness = inventory.harness;
    return {
      region: options.region,
      accountId: accountIdFromRoleArn(harness.executionRoleArn!),
      harnessName: harness.harnessName!,
      model: harness.model,
      tools: harness.tools,
      skills: harness.skills,
      memory: harness.memory,
      environment: harness.environment,
      environmentArtifact: harness.environmentArtifact,
      credentialProviders: inventory.credentials,
    };
  }

  private async enrichState(
    state: HarnessPolicyState,
    options: CoreOptions,
  ): Promise<HarnessPolicyState> {
    const credentials = await new CredentialProviderPolicyResolver(
      this.clients.control(toClientConfig(options)),
    ).resolve(harnessCredentialProviderRequests(state));
    return { ...state, credentialProviders: credentials };
  }

  private async readPolicyInventory(
    harnessId: string,
    options: CoreOptions,
    knownHarness?: Harness,
  ): Promise<HarnessPolicyInventory> {
    const harness =
      knownHarness ?? requiredHarness(await this.getHarness(harnessId, options), harnessId);
    const state: HarnessPolicyState = {
      region: options.region,
      accountId: accountIdFromRoleArn(harness.executionRoleArn!),
      harnessName: harness.harnessName!,
      model: harness.model,
      tools: harness.tools,
      skills: harness.skills,
      memory: harness.memory,
      environment: harness.environment,
      environmentArtifact: harness.environmentArtifact,
    };
    const enriched = await this.enrichState(state, options);
    return {
      harness,
      credentials: [...(enriched.credentialProviders ?? [])],
    };
  }

  private async reconcileManaged<T>(input: {
    harnessId: string;
    management: ManagedHarnessPolicy;
    current: HarnessPolicyInventory;
    desired: readonly PolicyContribution[];
    operation: () => Promise<T>;
    options: CoreOptions;
  }): Promise<T> {
    const iam = this.clients.iam({ region: input.options.region });
    const roleManager = new ExecutionRoleManager(iam, this.options.roleManager);
    await roleManager.validateAgentCoreTrust(input.management.roleName, {
      sourceAccount: accountIdFromRoleArn(input.management.roleArn),
      sourceArn: input.current.harness.arn!,
    });
    const result = await this.policyUpdater(iam).update({
      roleName: input.management.roleName,
      policyName: harnessPolicyName(input.management, input.current.harness, input.options.region),
      current: this.planner.plan(this.policyState(input.current, input.options)),
      desired: input.desired,
      operation: input.operation,
      operationRetry: {
        maxAttempts: 8,
        delayMs: 2_000,
        shouldRetry: isExecutionRolePropagationError,
      },
      isOperationOutcomeUnknown: (error) => error instanceof HarnessOutcomeUnknownError,
      resolveDesired: async () => {
        const settled = await this.readPolicyInventory(input.harnessId, input.options);
        return {
          contributions: this.planner.plan(this.policyState(settled, input.options)),
          inventoryComplete: true,
        };
      },
    });
    return result.value;
  }

  private async createHarnessAndWait(
    input: CreateHarnessCommand["input"],
    options: CoreOptions,
  ): Promise<{ response: CreateHarnessResponse; settled: Harness }> {
    const control = this.clients.control(toClientConfig(options));
    let response: CreateHarnessResponse;
    try {
      response = await control.send(new CreateHarnessCommand(input));
    } catch (error) {
      if (isExecutionRolePropagationError(error)) throw error;
      if (isAmbiguousMutationError(error)) {
        throw new HarnessOutcomeUnknownError(input.harnessName ?? "unknown", {
          cause: error,
        });
      }
      throw error;
    }
    const harnessId = response.harness?.harnessId;
    if (!harnessId) throw new Error("CreateHarness returned no Harness ID.");
    const harnessVersion = response.harness?.harnessVersion;
    if (!harnessVersion) throw new Error("CreateHarness returned no Harness version.");
    return {
      response,
      settled: await this.waitForHarness(harnessId, harnessVersion, options),
    };
  }

  private async updateHarnessAndWait(
    input: UpdateHarnessCommand["input"],
    options: CoreOptions,
  ): Promise<{ response: UpdateHarnessResponse; settled: Harness }> {
    const control = this.clients.control(toClientConfig(options));
    let response: UpdateHarnessResponse;
    try {
      response = await control.send(new UpdateHarnessCommand(input));
    } catch (error) {
      if (isExecutionRolePropagationError(error)) throw error;
      if (isAmbiguousMutationError(error)) {
        throw new HarnessOutcomeUnknownError(input.harnessId ?? "unknown", {
          cause: error,
        });
      }
      throw error;
    }
    const harnessVersion = response.harness?.harnessVersion;
    if (!harnessVersion) throw new Error("UpdateHarness returned no Harness version.");
    return {
      response,
      settled: await this.waitForHarness(input.harnessId!, harnessVersion, options),
    };
  }

  private async deleteHarnessAndWait(
    input: DeleteHarnessRequest,
    options: CoreOptions,
  ): Promise<{ response: DeleteHarnessResponse }> {
    const control = this.clients.control(toClientConfig(options));
    let response: DeleteHarnessResponse;
    try {
      response = await control.send(new DeleteHarnessCommand(input));
    } catch (error) {
      if (isAmbiguousMutationError(error)) {
        throw new HarnessOutcomeUnknownError(input.harnessId ?? "unknown", {
          cause: error,
        });
      }
      throw error;
    }
    await this.waitForHarnessDeletion(input.harnessId!, options);
    return { response };
  }

  private async waitForHarness(
    harnessId: string,
    harnessVersion: string,
    options: CoreOptions,
  ): Promise<Harness> {
    const attempts = this.options.waitAttempts ?? DEFAULT_WAIT_ATTEMPTS;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const harness = requiredHarness(await this.getHarness(harnessId, options), harnessId);
        if (harness.harnessVersion === harnessVersion) {
          if (harness.status === "READY") return harness;
          if (harness.status === "CREATE_FAILED" || harness.status === "UPDATE_FAILED") {
            throw new HarnessTerminalStateError(harnessId, harness.status, harness.failureReason);
          }
        }
      } catch (error) {
        if (error instanceof HarnessTerminalStateError) throw error;
        if ((error as Error).name !== "ResourceNotFoundException" || attempt >= attempts) {
          throw new HarnessOutcomeUnknownError(harnessId, { cause: error });
        }
      }
      if (attempt < attempts) {
        await this.sleep(this.options.waitDelayMs ?? DEFAULT_WAIT_DELAY_MS);
      }
    }
    throw new HarnessOutcomeUnknownError(harnessId);
  }

  private async waitForHarnessDeletion(harnessId: string, options: CoreOptions): Promise<void> {
    const attempts = this.options.waitAttempts ?? DEFAULT_WAIT_ATTEMPTS;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const harness = requiredHarness(await this.getHarness(harnessId, options), harnessId);
        if (harness.status === "DELETE_FAILED") {
          throw new HarnessTerminalStateError(harnessId, harness.status, harness.failureReason);
        }
      } catch (error) {
        if ((error as Error).name === "ResourceNotFoundException") return;
        if (error instanceof HarnessTerminalStateError) throw error;
        throw new HarnessOutcomeUnknownError(harnessId, { cause: error });
      }
      if (attempt < attempts) {
        await this.sleep(this.options.waitDelayMs ?? DEFAULT_WAIT_DELAY_MS);
      }
    }
    throw new HarnessOutcomeUnknownError(harnessId);
  }

  async invokeHarness(
    request: InvokeHarnessRequest,
    options: CoreOptions,
    abortSignal?: AbortSignal,
  ): Promise<InvokeHarnessResponse> {
    const response = await this.clients
      .data(toClientConfig(options))
      .send(new InvokeHarnessCommand(request), { abortSignal });
    if (!response.stream || !abortSignal) return response;
    // The SDK honors the abort signal while the request is being established,
    // but once the event stream is flowing, aborting no longer tears the
    // iteration down — consumers awaiting the next event would hang until the
    // turn ran to completion. Racing each read against the signal keeps abort
    // (esc in the TUI) responsive mid-stream.
    return { ...response, stream: abortable(response.stream, abortSignal) };
  }

  async invokeAgentRuntimeCommand(
    request: InvokeAgentRuntimeCommandRequest,
    options: CoreOptions,
    abortSignal?: AbortSignal,
  ): Promise<InvokeAgentRuntimeCommandResponse> {
    const response = await this.clients
      .data(toClientConfig(options))
      .send(new InvokeAgentRuntimeCommandCommand(request), { abortSignal });
    if (!response.stream || !abortSignal) return response;
    // Same mid-stream abort gap as invokeHarness; see above.
    return { ...response, stream: abortable(response.stream, abortSignal) };
  }
}

function requiredHarness(response: GetHarnessResponse, harnessId: string): Harness {
  if (!response.harness) throw new Error(`GetHarness returned no Harness for ${harnessId}.`);
  return response.harness;
}

function expectedHarnessCliRoleName(harness: Harness): string {
  if (!harness.harnessName) throw new Error("Harness returned no name.");
  return ExecutionRoleManager.cliRoleName("harness", harness.harnessName);
}

function applyHarnessUpdate(current: Harness, request: UpdateHarnessRequest): Harness {
  return {
    ...current,
    executionRoleArn: request.executionRoleArn ?? current.executionRoleArn,
    environment: (request.environment ?? current.environment) as Harness["environment"],
    environmentArtifact:
      request.environmentArtifact === undefined
        ? current.environmentArtifact
        : request.environmentArtifact.optionalValue,
    model: request.model ?? current.model,
    tools: request.tools ?? current.tools,
    skills: request.skills ?? current.skills,
    memory: request.memory === undefined ? current.memory : request.memory.optionalValue,
  };
}

function harnessPolicyName(
  management: ManagedHarnessPolicy,
  harness: Harness,
  region: string,
): string {
  const stableResourceKey = management.roleName.startsWith("AgentCoreCliHarness-")
    ? management.roleName
    : harness.harnessId!;
  return ExecutionRoleManager.generatedPolicyName("harness", {
    accountId: accountIdFromRoleArn(management.roleArn),
    region,
    stableResourceKey,
  });
}

function accountIdFromRoleArn(roleArn: string): string {
  const accountId = roleArn.split(":")[4];
  if (!accountId) throw new Error(`Cannot extract account ID from role ARN "${roleArn}".`);
  return accountId;
}

function isExecutionRolePropagationError(error: unknown): boolean {
  return (
    ["ValidationException", "AccessDeniedException"].includes((error as Error).name) &&
    /role|permission|authoriz|assum|memory|model|browser|interpreter|gateway/i.test(
      (error as Error).message ?? "",
    )
  );
}

function isAmbiguousMutationError(error: unknown): boolean {
  const name = (error as Error).name;
  const statusCode = (
    error as {
      $metadata?: { httpStatusCode?: number };
    }
  ).$metadata?.httpStatusCode;
  return (
    ["TimeoutError", "AbortError", "NetworkingError"].includes(name) ||
    (statusCode !== undefined && statusCode >= 500)
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
