import { randomUUID } from "node:crypto";
import {
  CreateGatewayCommand,
  CreateGatewayRuleCommand,
  CreateGatewayTargetCommand,
  DeleteGatewayCommand,
  DeleteGatewayRuleCommand,
  DeleteGatewayTargetCommand,
  GetGatewayCommand,
  GetGatewayRuleCommand,
  GetGatewayTargetCommand,
  ListGatewayRulesCommand,
  ListGatewaysCommand,
  ListGatewayTargetsCommand,
  TargetType,
  UpdateGatewayCommand,
  UpdateGatewayRuleCommand,
  UpdateGatewayTargetCommand,
  type CreateGatewayResponse,
  type CreateGatewayRuleResponse,
  type CreateGatewayTargetResponse,
  type DeleteGatewayResponse,
  type DeleteGatewayRuleResponse,
  type DeleteGatewayTargetResponse,
  type GetGatewayResponse,
  type GetGatewayRuleResponse,
  type GetGatewayTargetResponse,
  type CredentialProviderConfiguration,
  type ListGatewayRulesResponse,
  type ListGatewaysResponse,
  type ListGatewayTargetsResponse,
  type TargetConfiguration,
  type TargetSummary,
  type UpdateGatewayRequest,
  type UpdateGatewayResponse,
  type UpdateGatewayRuleResponse,
  type UpdateGatewayTargetRequest,
  type UpdateGatewayTargetResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  AgentCoreCLIError,
  ERROR_SOURCE,
  InputValidationError,
  ResultTruncationError,
} from "../errors";
import type {
  CoreGatewayClient,
  CreateGatewayInput,
  CreateGatewayRuleInput,
  CreateGatewayTargetInput,
  GatewayMutationResult,
  GatewayRuleUpdateInput,
  GatewayTargetUpdatePatch,
  GatewayUpdatePatch,
} from "../handlers/gateway/types";
import type { AwsClients, CoreOptions } from "./types";
import {
  ExecutionRoleManager,
  type ExecutionRoleManagerOptions,
  type ExecutionRolePolicyManagement,
} from "./executionRoleManager";
import { CredentialProviderPolicyResolver } from "./credentialProviderPolicy";
import type { PolicyContribution } from "./executionRolePolicy";
import {
  ExecutionRolePolicyUpdater,
  PolicyFinalizationError,
  PolicyOperationOutcomeUnknownError,
  type ExecutionRolePolicyUpdaterOptions,
} from "./executionRolePolicyUpdater";
import { GatewayPolicyPlanner, type GatewayCredentialProviderPolicyState } from "./gatewayPolicy";
import { toClientConfig } from "./utils";

const DEFAULT_CONNECTOR_PAGE_SIZE = 100;
const MAX_CONNECTOR_TARGET_PAGES = 101;
const DEFAULT_WAIT_ATTEMPTS = 60;
const DEFAULT_WAIT_DELAY_MS = 2_000;

export type GatewayClientOptions = {
  policyUpdater?: ExecutionRolePolicyUpdaterOptions;
  roleManager?: ExecutionRoleManagerOptions;
  waitAttempts?: number;
  waitDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

type GatewayPolicyInventory = {
  gateway: GetGatewayResponse;
  targets: GetGatewayTargetResponse[];
  credentialProviders: GatewayCredentialProviderPolicyState[];
};

type ManagedGatewayPolicy = Extract<ExecutionRolePolicyManagement, { mode: "managed" }>;

export class GatewayTerminalStateError extends Error {
  constructor(
    readonly gatewayId: string,
    readonly status: string,
    readonly statusReasons: readonly string[],
  ) {
    super(
      `Gateway ${gatewayId} reached ${status}` +
        (statusReasons.length > 0 ? `: ${statusReasons.join("; ")}` : "."),
    );
    this.name = "GatewayTerminalStateError";
  }
}

export class GatewayTargetTerminalStateError extends Error {
  constructor(
    readonly gatewayId: string,
    readonly targetId: string,
    readonly status: string,
    readonly statusReasons: readonly string[],
  ) {
    super(
      `Gateway Target ${targetId} under ${gatewayId} reached ${status}` +
        (statusReasons.length > 0 ? `: ${statusReasons.join("; ")}` : "."),
    );
    this.name = "GatewayTargetTerminalStateError";
  }
}

export class GatewayOutcomeUnknownError extends Error {
  constructor(resource: string, options?: ErrorOptions) {
    super(`The final state of ${resource} could not be determined.`, options);
    this.name = "GatewayOutcomeUnknownError";
  }
}

export class GatewayClient implements CoreGatewayClient {
  private readonly planner = new GatewayPolicyPlanner();
  private readonly options: GatewayClientOptions;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly clients: AwsClients,
    options: GatewayClientOptions = {},
  ) {
    this.options = options;
    this.sleep = options.sleep ?? delay;
  }

  async createGateway(
    input: CreateGatewayInput,
    options: CoreOptions,
  ): Promise<CreateGatewayResponse> {
    const { protocol, roleArn, ...request } = input;
    const protocolType = protocol === "mcp" ? ("MCP" as const) : undefined;
    if (roleArn) {
      const { response } = await this.createGatewayAndWait(
        {
          ...request,
          clientToken: request.clientToken ?? randomUUID(),
          roleArn,
          ...(protocolType ? { protocolType } : {}),
        },
        options,
      );
      return response;
    }

    const existingGateway = await this.findGatewayByName(input.name!, options);
    if (existingGateway) {
      throw new InputValidationError(
        `Gateway "${input.name}" already exists as ${existingGateway.gatewayId}.`,
      );
    }
    const iam = this.clients.iam({ region: options.region });
    const roleManager = new ExecutionRoleManager(iam, this.options.roleManager);
    const managedRole = await roleManager.ensureCliRole({
      primitive: "gateway",
      resourceName: input.name!,
    });
    const policyName = ExecutionRoleManager.generatedPolicyName("gateway", {
      accountId: accountIdFromRoleArn(managedRole.arn),
      region: options.region,
      stableResourceKey: managedRole.name,
    });
    const policyUpdater = new ExecutionRolePolicyUpdater(iam, {
      propagationDelayMs: 10_000,
      ...this.options.policyUpdater,
    });
    const clientToken = request.clientToken ?? randomUUID();

    try {
      const result = await policyUpdater.update({
        roleName: managedRole.name,
        policyName,
        current: [],
        inventoryComplete: managedRole.created,
        desired: this.planner.plan({
          policyEngineConfiguration: request.policyEngineConfiguration,
          interceptorConfigurations: request.interceptorConfigurations,
          targets: [],
        }),
        operation: () =>
          this.createGatewayAndWait(
            {
              ...request,
              clientToken,
              roleArn: managedRole.arn,
              ...(protocolType ? { protocolType } : {}),
            },
            options,
          ),
        operationRetry: {
          maxAttempts: 8,
          delayMs: 2_000,
          shouldRetry: isExecutionRolePropagationError,
        },
        isOperationOutcomeUnknown: (error) => error instanceof GatewayOutcomeUnknownError,
        resolveDesired: async ({ settled }) => {
          const state = await this.readGatewayPolicyState(settled.gatewayId!, options, settled);
          return {
            contributions: this.planGatewayPolicy(state),
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

  async getGatewayRolePolicyWarning(
    gatewayId: string,
    options: CoreOptions,
  ): Promise<{ reason: "unknown-role"; roleArn: string } | undefined> {
    const gateway = await this.getGateway(gatewayId, options);
    if (!gateway.roleArn) {
      throw new Error(`Gateway ${gatewayId} returned no execution role ARN.`);
    }
    const management = ExecutionRoleManager.policyManagement({
      associatedRoleArn: gateway.roleArn,
      expectedCliRoleName: expectedGatewayCliRoleName(gateway, gatewayId),
    });
    return management.mode === "external" && management.reason === "unknown-role"
      ? { reason: "unknown-role", roleArn: management.roleArn }
      : undefined;
  }

  async getGateway(id: string, options: CoreOptions): Promise<GetGatewayResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new GetGatewayCommand({ gatewayIdentifier: id }));
  }

  async updateGateway(
    patch: GatewayUpdatePatch,
    options: CoreOptions,
  ): Promise<UpdateGatewayResponse> {
    const control = this.clients.control(toClientConfig(options));
    const current = await control.send(new GetGatewayCommand({ gatewayIdentifier: patch.id }));
    const resource = `Gateway "${patch.id}"`;
    const name = GatewayClient.required(current.name, resource, "name");
    const roleArn = GatewayClient.required(current.roleArn, resource, "role ARN");
    const authorizerType = GatewayClient.required(
      current.authorizerType,
      resource,
      "authorizer type",
    );
    if (patch.authorizerConfiguration !== undefined && authorizerType !== "CUSTOM_JWT") {
      throw new InputValidationError(
        "Authorizer configuration can only be updated for a CUSTOM_JWT Gateway",
      );
    }

    let policyEngineConfiguration = current.policyEngineConfiguration;
    if (patch.policyEngineConfiguration === null) {
      policyEngineConfiguration = undefined;
    } else if (patch.policyEngineConfiguration !== undefined) {
      const arn = patch.policyEngineConfiguration.arn ?? current.policyEngineConfiguration?.arn;
      const mode = patch.policyEngineConfiguration.mode ?? current.policyEngineConfiguration?.mode;
      if (!arn || !mode) {
        throw new InputValidationError(
          "Policy Engine update requires an ARN and mode, either existing or supplied",
        );
      }
      policyEngineConfiguration = { arn, mode };
    }

    const description = GatewayClient.replace(current.description, patch.description);
    const protocolConfiguration = GatewayClient.replace(
      current.protocolConfiguration,
      patch.protocolConfiguration,
    );
    const customTransformConfiguration = GatewayClient.replace(
      current.customTransformConfiguration,
      patch.customTransformConfiguration,
    );
    const interceptorConfigurations = GatewayClient.replace(
      current.interceptorConfigurations,
      patch.interceptorConfigurations,
    );
    const exceptionLevel = GatewayClient.replace(current.exceptionLevel, patch.exceptionLevel);
    const wafConfiguration = GatewayClient.replace(
      current.wafConfiguration,
      patch.wafConfiguration,
    );
    const request: UpdateGatewayRequest = {
      gatewayIdentifier: patch.id,
      name,
      roleArn: patch.roleArn ?? roleArn,
      authorizerType,
      description,
      protocolType: patch.clearProtocol ? undefined : current.protocolType,
      protocolConfiguration,
      authorizerConfiguration: patch.authorizerConfiguration ?? current.authorizerConfiguration,
      kmsKeyArn: current.kmsKeyArn,
      customTransformConfiguration,
      interceptorConfigurations,
      policyEngineConfiguration,
      exceptionLevel,
      wafConfiguration,
    };
    const management = ExecutionRoleManager.policyManagement({
      associatedRoleArn: roleArn,
      explicitRoleArn: patch.roleArn,
      skipPolicyUpdate: patch.skipRolePolicyUpdate,
      expectedCliRoleName: ExecutionRoleManager.cliRoleName("gateway", name),
    });
    if (management.mode === "external") {
      if (management.reason === "explicit-role" && !patch.skipRolePolicyUpdate) {
        const previousManagement = ExecutionRoleManager.policyManagement({
          associatedRoleArn: roleArn,
          expectedCliRoleName: ExecutionRoleManager.cliRoleName("gateway", name),
        });
        if (previousManagement.mode === "managed") {
          const policyName = gatewayPolicyName(
            previousManagement.roleName,
            previousManagement.roleArn,
            current.gatewayId ?? patch.id,
            options.region,
          );
          const policyUpdater = new ExecutionRolePolicyUpdater(
            this.clients.iam({ region: options.region }),
            {
              propagationDelayMs: 10_000,
              ...this.options.policyUpdater,
            },
          );
          const result = await policyUpdater.removeAfter({
            roleName: previousManagement.roleName,
            policyName,
            operation: () => this.updateGatewayAndWait(request, options),
            isOperationOutcomeUnknown: (error) => error instanceof GatewayOutcomeUnknownError,
          });
          return result.response;
        }
      }
      return (await this.updateGatewayAndWait(request, options)).response;
    }

    const currentState = await this.readGatewayPolicyState(patch.id, options, current);
    const desired = this.planGatewayPolicy(currentState, {
      policyEngineConfiguration,
      interceptorConfigurations,
      customTransformConfiguration,
    });
    const result = await this.reconcileManagedPolicy({
      gatewayId: patch.id,
      management,
      currentState,
      desired,
      operation: () => this.updateGatewayAndWait(request, options),
      retryPropagation: true,
      options,
    });
    return result.response;
  }

  async listGateways(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListGatewaysResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new ListGatewaysCommand({ nextToken, maxResults }));
  }

  async deleteGateway(id: string, options: CoreOptions): Promise<DeleteGatewayResponse> {
    const gateway = await this.getGateway(id, options);
    if (!gateway.roleArn) {
      throw new Error(`Gateway ${id} returned no execution role ARN.`);
    }
    const request = { gatewayIdentifier: id };
    const management = ExecutionRoleManager.policyManagement({
      associatedRoleArn: gateway.roleArn,
      expectedCliRoleName: expectedGatewayCliRoleName(gateway, id),
    });
    if (management.mode === "external") {
      return (await this.deleteGatewayAndWait(request, options)).response;
    }

    const policyName = gatewayPolicyName(
      management.roleName,
      management.roleArn,
      gateway.gatewayId ?? id,
      options.region,
    );
    const policyUpdater = new ExecutionRolePolicyUpdater(
      this.clients.iam({ region: options.region }),
      {
        propagationDelayMs: 10_000,
        ...this.options.policyUpdater,
      },
    );
    const result = await policyUpdater.removeAfter({
      roleName: management.roleName,
      policyName,
      operation: () => this.deleteGatewayAndWait(request, options),
      isOperationOutcomeUnknown: (error) => error instanceof GatewayOutcomeUnknownError,
    });
    return result.response;
  }

  async getGatewayTarget(
    gatewayId: string,
    targetId: string,
    options: CoreOptions,
  ): Promise<GetGatewayTargetResponse> {
    return this.clients.control(toClientConfig(options)).send(
      new GetGatewayTargetCommand({
        gatewayIdentifier: gatewayId,
        targetId,
      }),
    );
  }

  async listGatewayTargets(
    gatewayId: string,
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListGatewayTargetsResponse> {
    return this.clients.control(toClientConfig(options)).send(
      new ListGatewayTargetsCommand({
        gatewayIdentifier: gatewayId,
        nextToken,
        maxResults,
      }),
    );
  }

  async createGatewayTarget(
    input: CreateGatewayTargetInput,
    options: CoreOptions,
  ): Promise<GatewayMutationResult<CreateGatewayTargetResponse>> {
    const gateway = await this.getGateway(input.gatewayIdentifier!, options);
    if (!gateway.roleArn) {
      throw new Error(`Gateway ${input.gatewayIdentifier} returned no execution role ARN.`);
    }
    const management = ExecutionRoleManager.policyManagement({
      associatedRoleArn: gateway.roleArn,
      expectedCliRoleName: expectedGatewayCliRoleName(gateway, input.gatewayIdentifier!),
    });
    const control = this.clients.control(toClientConfig(options));

    if (management.mode === "external") {
      const request = {
        ...input,
        clientToken: input.clientToken ?? randomUUID(),
      };
      let response: CreateGatewayTargetResponse;
      try {
        response = await control.send(new CreateGatewayTargetCommand(request));
      } catch (error) {
        if (isAmbiguousCreateError(error)) {
          throw new GatewayOutcomeUnknownError(`Gateway Target under ${input.gatewayIdentifier}`, {
            cause: error,
          });
        }
        throw error;
      }
      if (!response.targetId) {
        throw new Error("CreateGatewayTarget returned no Target ID.");
      }
      const settled = await this.waitForGatewayTarget(
        input.gatewayIdentifier!,
        response.targetId,
        options,
      );
      return {
        response: isPendingAuthorizationStatus(settled.status)
          ? ({ ...response, ...settled } as CreateGatewayTargetResponse)
          : response,
        ...(management.reason === "unknown-role"
          ? {
              rolePolicyWarning: {
                reason: "unknown-role" as const,
                roleArn: management.roleArn,
              },
            }
          : {}),
      };
    }

    const currentState = await this.readGatewayPolicyState(
      input.gatewayIdentifier!,
      options,
      gateway,
    );
    const proposedTarget = {
      name: input.name,
      targetConfiguration: input.targetConfiguration,
      credentialProviderConfigurations: input.credentialProviderConfigurations,
    };
    const desiredTargets = [...currentState.targets, proposedTarget];
    const desiredCredentialProviders = await this.resolveCredentialProviderPolicyState(
      desiredTargets,
      options,
    );
    const desired = this.planGatewayPolicy(currentState, {
      credentialProviders: desiredCredentialProviders,
      targets: desiredTargets,
    });
    const request = {
      ...input,
      clientToken: input.clientToken ?? randomUUID(),
    };

    const response = await this.reconcileManagedPolicy({
      gatewayId: input.gatewayIdentifier!,
      management,
      currentState,
      desired,
      operation: async () => {
        let response: CreateGatewayTargetResponse;
        try {
          response = await control.send(new CreateGatewayTargetCommand(request));
        } catch (error) {
          if (isExecutionRolePropagationError(error)) throw error;
          if (isAmbiguousCreateError(error)) {
            throw new GatewayOutcomeUnknownError(
              `Gateway Target under ${input.gatewayIdentifier}`,
              { cause: error },
            );
          }
          throw error;
        }
        if (!response.targetId) {
          throw new Error("CreateGatewayTarget returned no Target ID.");
        }
        await this.waitForGatewayTarget(input.gatewayIdentifier!, response.targetId, options);
        return response;
      },
      retryPropagation: true,
      options,
    });
    return { response };
  }

  async getGatewayConnector(
    gatewayId: string,
    targetId: string,
    options: CoreOptions,
  ): Promise<GetGatewayTargetResponse> {
    const target = await this.getGatewayTarget(gatewayId, targetId, options);
    if (!GatewayClient.isConnectorTarget(target.targetConfiguration)) {
      throw new InputValidationError(`Gateway Target "${targetId}" is not connector-backed`);
    }
    return target;
  }

  async listGatewayConnectors(
    gatewayId: string,
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListGatewayTargetsResponse> {
    const pageSize = maxResults ?? DEFAULT_CONNECTOR_PAGE_SIZE;
    const items: TargetSummary[] = [];
    let token = nextToken;
    let filling = true;

    for (let page = 0; page < MAX_CONNECTOR_TARGET_PAGES; page++) {
      const requestToken = token;
      const requestSize = filling ? pageSize - items.length : DEFAULT_CONNECTOR_PAGE_SIZE;
      const response = await this.listGatewayTargets(gatewayId, token, requestSize, options);
      const connectors = (response.items ?? []).filter(
        (target) => target.targetType === TargetType.CONNECTOR,
      );

      if (filling) {
        items.push(...connectors);
        filling = items.length < pageSize;
      } else if (connectors.length > 0) {
        return { ...response, items, nextToken: requestToken };
      }

      if (response.nextToken === undefined) {
        return { ...response, items, nextToken: undefined };
      }
      token = response.nextToken;
    }

    throw new ResultTruncationError(
      `Gateway Connector discovery exceeded ${MAX_CONNECTOR_TARGET_PAGES} Target pages; results are incomplete`,
    );
  }

  async updateGatewayTarget(
    patch: GatewayTargetUpdatePatch,
    options: CoreOptions,
  ): Promise<UpdateGatewayTargetResponse> {
    return this.updateTarget(patch, options, false);
  }

  async updateGatewayConnector(
    patch: GatewayTargetUpdatePatch,
    options: CoreOptions,
  ): Promise<UpdateGatewayTargetResponse> {
    return this.updateTarget(patch, options, true);
  }

  async deleteGatewayTarget(
    gatewayId: string,
    targetId: string,
    options: CoreOptions,
  ): Promise<DeleteGatewayTargetResponse> {
    const gateway = await this.getGateway(gatewayId, options);
    if (!gateway.roleArn) {
      throw new Error(`Gateway ${gatewayId} returned no execution role ARN.`);
    }
    const request = {
      gatewayIdentifier: gatewayId,
      targetId,
    };
    const management = ExecutionRoleManager.policyManagement({
      associatedRoleArn: gateway.roleArn,
      expectedCliRoleName: expectedGatewayCliRoleName(gateway, gatewayId),
    });
    if (management.mode === "external") {
      return (await this.deleteGatewayTargetAndWait(request, options)).response;
    }

    const currentState = await this.readGatewayPolicyState(gatewayId, options, gateway);
    const result = await this.reconcileManagedPolicy({
      gatewayId,
      management,
      currentState,
      desired: this.planGatewayPolicy(currentState),
      operation: () => this.deleteGatewayTargetAndWait(request, options),
      options,
    });
    return result.response;
  }

  async getGatewayRule(
    gatewayId: string,
    ruleId: string,
    options: CoreOptions,
  ): Promise<GetGatewayRuleResponse> {
    return this.clients.control(toClientConfig(options)).send(
      new GetGatewayRuleCommand({
        gatewayIdentifier: gatewayId,
        ruleId,
      }),
    );
  }

  async listGatewayRules(
    gatewayId: string,
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListGatewayRulesResponse> {
    return this.clients.control(toClientConfig(options)).send(
      new ListGatewayRulesCommand({
        gatewayIdentifier: gatewayId,
        nextToken,
        maxResults,
      }),
    );
  }

  async createGatewayRule(
    input: CreateGatewayRuleInput,
    options: CoreOptions,
  ): Promise<CreateGatewayRuleResponse> {
    return this.clients.control(toClientConfig(options)).send(new CreateGatewayRuleCommand(input));
  }

  async updateGatewayRule(
    input: GatewayRuleUpdateInput,
    options: CoreOptions,
  ): Promise<UpdateGatewayRuleResponse> {
    return this.clients.control(toClientConfig(options)).send(new UpdateGatewayRuleCommand(input));
  }

  async deleteGatewayRule(
    gatewayId: string,
    ruleId: string,
    options: CoreOptions,
  ): Promise<DeleteGatewayRuleResponse> {
    return this.clients.control(toClientConfig(options)).send(
      new DeleteGatewayRuleCommand({
        gatewayIdentifier: gatewayId,
        ruleId,
      }),
    );
  }

  private async updateTarget(
    patch: GatewayTargetUpdatePatch,
    options: CoreOptions,
    connectorOnly: boolean,
  ): Promise<UpdateGatewayTargetResponse> {
    const control = this.clients.control(toClientConfig(options));
    const current = await control.send(
      new GetGatewayTargetCommand({
        gatewayIdentifier: patch.gatewayId,
        targetId: patch.targetId,
      }),
    );
    const currentTargetConfiguration = GatewayClient.required(
      current.targetConfiguration,
      `Gateway Target "${patch.targetId}"`,
      "configuration",
    );
    if (connectorOnly && !GatewayClient.isConnectorTarget(currentTargetConfiguration)) {
      throw new InputValidationError(`Gateway Target "${patch.targetId}" is not connector-backed`);
    }

    let targetConfiguration = patch.targetConfiguration;
    if (targetConfiguration === undefined && patch.endpoint !== undefined) {
      const mcpServer = currentTargetConfiguration.mcp?.mcpServer;
      if (!mcpServer) {
        throw new InputValidationError("Endpoint updates require an existing MCP server Target");
      }
      targetConfiguration = {
        mcp: {
          mcpServer: {
            ...mcpServer,
            endpoint: patch.endpoint,
          },
        },
      };
    }
    targetConfiguration ??= currentTargetConfiguration;

    const name = GatewayClient.replace(current.name, patch.name);
    const description = GatewayClient.replace(current.description, patch.description);
    const credentialProviderConfigurations = GatewayClient.replace(
      current.credentialProviderConfigurations,
      patch.credentialProviderConfigurations,
    );
    const metadataConfiguration = GatewayClient.replace(
      current.metadataConfiguration,
      patch.metadataConfiguration,
    );
    const privateEndpoint = GatewayClient.replace(current.privateEndpoint, patch.privateEndpoint);
    const request: UpdateGatewayTargetRequest = {
      gatewayIdentifier: patch.gatewayId,
      targetId: patch.targetId,
      targetConfiguration,
      name,
      description,
      credentialProviderConfigurations,
      metadataConfiguration,
      privateEndpoint,
    };
    if (connectorOnly && !GatewayClient.isConnectorTarget(request.targetConfiguration)) {
      throw new InputValidationError(
        "Connector updates require an MCP or inference connector Target configuration",
      );
    }
    const gateway = await this.getGateway(patch.gatewayId, options);
    if (!gateway.roleArn) {
      throw new Error(`Gateway ${patch.gatewayId} returned no execution role ARN.`);
    }
    const management = ExecutionRoleManager.policyManagement({
      associatedRoleArn: gateway.roleArn,
      skipPolicyUpdate: patch.skipRolePolicyUpdate,
      expectedCliRoleName: expectedGatewayCliRoleName(gateway, patch.gatewayId),
    });
    if (management.mode === "external") {
      return (await this.updateGatewayTargetAndWait(request, options)).response;
    }

    const currentState = await this.readGatewayPolicyState(patch.gatewayId, options, gateway);
    const targetIndex = currentState.targets.findIndex(
      (target) => target.targetId === patch.targetId,
    );
    if (targetIndex < 0) {
      throw new Error(`Gateway ${patch.gatewayId} inventory is missing Target ${patch.targetId}.`);
    }
    const desiredTargets = [...currentState.targets];
    desiredTargets[targetIndex] = {
      ...current,
      name: request.name,
      targetConfiguration: request.targetConfiguration,
      credentialProviderConfigurations: request.credentialProviderConfigurations,
    };
    const desiredCredentialProviders = await this.resolveCredentialProviderPolicyState(
      desiredTargets,
      options,
    );
    const desired = this.planGatewayPolicy(currentState, {
      credentialProviders: desiredCredentialProviders,
      targets: desiredTargets,
    });
    const result = await this.reconcileManagedPolicy({
      gatewayId: patch.gatewayId,
      management,
      currentState,
      desired,
      operation: () => this.updateGatewayTargetAndWait(request, options),
      retryPropagation: true,
      options,
    });
    return result.response;
  }

  private static replace<T>(
    current: T | undefined,
    replacement: T | null | undefined,
  ): T | undefined {
    if (replacement === undefined) return current;
    return replacement === null ? undefined : replacement;
  }

  private static required<T>(value: T | undefined, resource: string, field: string): T {
    if (value === undefined) {
      throw new AgentCoreCLIError(`${resource} is missing its ${field} required for update`, {
        source: ERROR_SOURCE.SERVICE,
      });
    }
    return value;
  }

  private static isConnectorTarget(configuration: TargetConfiguration | undefined): boolean {
    return (
      configuration?.mcp?.connector !== undefined ||
      configuration?.inference?.connector !== undefined
    );
  }

  private async waitForGateway(
    gatewayId: string,
    options: CoreOptions,
  ): Promise<GetGatewayResponse> {
    const attempts = this.options.waitAttempts ?? DEFAULT_WAIT_ATTEMPTS;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let response: GetGatewayResponse;
      try {
        response = await this.getGateway(gatewayId, options);
      } catch (error) {
        if ((error as Error).name === "ResourceNotFoundException" && attempt < attempts) {
          await this.sleep(this.options.waitDelayMs ?? DEFAULT_WAIT_DELAY_MS);
          continue;
        }
        throw new GatewayOutcomeUnknownError(`Gateway ${gatewayId}`, { cause: error });
      }
      if (response.status === "READY") return response;
      if (response.status === "FAILED" || response.status === "UPDATE_UNSUCCESSFUL") {
        throw new GatewayTerminalStateError(
          gatewayId,
          response.status,
          response.statusReasons ?? [],
        );
      }
      if (attempt < attempts) {
        await this.sleep(this.options.waitDelayMs ?? DEFAULT_WAIT_DELAY_MS);
      }
    }
    throw new GatewayOutcomeUnknownError(`Gateway ${gatewayId}`);
  }

  private async waitForGatewayDeletion(gatewayId: string, options: CoreOptions): Promise<void> {
    const attempts = this.options.waitAttempts ?? DEFAULT_WAIT_ATTEMPTS;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await this.getGateway(gatewayId, options);
        if (response.status === "FAILED" || response.status === "UPDATE_UNSUCCESSFUL") {
          throw new GatewayTerminalStateError(
            gatewayId,
            response.status,
            response.statusReasons ?? [],
          );
        }
      } catch (error) {
        if ((error as Error).name === "ResourceNotFoundException") return;
        if (error instanceof GatewayTerminalStateError) throw error;
        throw new GatewayOutcomeUnknownError(`Gateway ${gatewayId}`, { cause: error });
      }
      if (attempt < attempts) {
        await this.sleep(this.options.waitDelayMs ?? DEFAULT_WAIT_DELAY_MS);
      }
    }
    throw new GatewayOutcomeUnknownError(`Gateway ${gatewayId}`);
  }

  private async createGatewayAndWait(
    input: CreateGatewayCommand["input"],
    options: CoreOptions,
  ): Promise<{ response: CreateGatewayResponse; settled: GetGatewayResponse }> {
    const control = this.clients.control(toClientConfig(options));
    let response: CreateGatewayResponse;
    try {
      response = await control.send(new CreateGatewayCommand(input));
    } catch (error) {
      if (isExecutionRolePropagationError(error)) throw error;
      if (!isAmbiguousCreateError(error)) throw error;
      const observed = await this.observeGatewayByName(input.name!, input.roleArn!, options);
      if (observed) {
        return { response: observed as CreateGatewayResponse, settled: observed };
      }
      throw new GatewayOutcomeUnknownError(`Gateway ${input.name}`, { cause: error });
    }
    if (!response.gatewayId) throw new Error("CreateGateway returned no Gateway ID.");
    return {
      response,
      settled: await this.waitForGateway(response.gatewayId, options),
    };
  }

  private async updateGatewayAndWait(
    input: UpdateGatewayCommand["input"],
    options: CoreOptions,
  ): Promise<{ response: UpdateGatewayResponse; settled: GetGatewayResponse }> {
    const control = this.clients.control(toClientConfig(options));
    let response: UpdateGatewayResponse;
    try {
      response = await control.send(new UpdateGatewayCommand(input));
    } catch (error) {
      if (isExecutionRolePropagationError(error)) throw error;
      if (isAmbiguousMutationError(error)) {
        throw new GatewayOutcomeUnknownError(`Gateway ${input.gatewayIdentifier}`, {
          cause: error,
        });
      }
      throw error;
    }
    return {
      response,
      settled: await this.waitForGateway(input.gatewayIdentifier!, options),
    };
  }

  private async deleteGatewayAndWait(
    input: DeleteGatewayCommand["input"],
    options: CoreOptions,
  ): Promise<{ response: DeleteGatewayResponse }> {
    const control = this.clients.control(toClientConfig(options));
    let response: DeleteGatewayResponse;
    try {
      response = await control.send(new DeleteGatewayCommand(input));
    } catch (error) {
      if (isAmbiguousMutationError(error)) {
        throw new GatewayOutcomeUnknownError(`Gateway ${input.gatewayIdentifier}`, {
          cause: error,
        });
      }
      throw error;
    }
    await this.waitForGatewayDeletion(input.gatewayIdentifier!, options);
    return { response };
  }

  private async updateGatewayTargetAndWait(
    input: UpdateGatewayTargetCommand["input"],
    options: CoreOptions,
  ): Promise<{
    response: UpdateGatewayTargetResponse;
    settled: GetGatewayTargetResponse;
  }> {
    const control = this.clients.control(toClientConfig(options));
    let response: UpdateGatewayTargetResponse;
    try {
      response = await control.send(new UpdateGatewayTargetCommand(input));
    } catch (error) {
      if (isExecutionRolePropagationError(error)) throw error;
      if (isAmbiguousMutationError(error)) {
        throw new GatewayOutcomeUnknownError(
          `Gateway Target ${input.targetId} under ${input.gatewayIdentifier}`,
          { cause: error },
        );
      }
      throw error;
    }
    return {
      response,
      settled: await this.waitForGatewayTarget(input.gatewayIdentifier!, input.targetId!, options),
    };
  }

  private async deleteGatewayTargetAndWait(
    input: DeleteGatewayTargetCommand["input"],
    options: CoreOptions,
  ): Promise<{ response: DeleteGatewayTargetResponse }> {
    const control = this.clients.control(toClientConfig(options));
    let response: DeleteGatewayTargetResponse;
    try {
      response = await control.send(new DeleteGatewayTargetCommand(input));
    } catch (error) {
      if (isAmbiguousMutationError(error)) {
        throw new GatewayOutcomeUnknownError(
          `Gateway Target ${input.targetId} under ${input.gatewayIdentifier}`,
          { cause: error },
        );
      }
      throw error;
    }
    await this.waitForGatewayTargetDeletion(input.gatewayIdentifier!, input.targetId!, options);
    return { response };
  }

  private async observeGatewayByName(
    name: string,
    roleArn: string,
    options: CoreOptions,
  ): Promise<GetGatewayResponse | undefined> {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        let nextToken: string | undefined;
        const seenTokens = new Set<string>();
        do {
          const page = await this.listGateways(nextToken, 100, options);
          const match = (page.items ?? []).find((gateway) => gateway.name === name);
          if (match?.gatewayId) {
            const observed = await this.waitForGateway(match.gatewayId, options);
            return observed.roleArn === roleArn ? observed : undefined;
          }
          if (page.nextToken && seenTokens.has(page.nextToken)) break;
          if (page.nextToken) seenTokens.add(page.nextToken);
          nextToken = page.nextToken;
        } while (nextToken);
      } catch (error) {
        if (error instanceof GatewayTerminalStateError) throw error;
      }
      if (attempt < 5) {
        await this.sleep(this.options.waitDelayMs ?? DEFAULT_WAIT_DELAY_MS);
      }
    }
    return undefined;
  }

  private async findGatewayByName(
    name: string,
    options: CoreOptions,
  ): Promise<{ gatewayId: string; name?: string } | undefined> {
    let nextToken: string | undefined;
    const seenTokens = new Set<string>();
    do {
      const page = await this.listGateways(nextToken, 100, options);
      const match = (page.items ?? []).find(
        (gateway) => gateway.name === name && gateway.gatewayId,
      );
      if (match?.gatewayId) return { gatewayId: match.gatewayId, name: match.name };
      if (page.nextToken && seenTokens.has(page.nextToken)) break;
      if (page.nextToken) seenTokens.add(page.nextToken);
      nextToken = page.nextToken;
    } while (nextToken);
    return undefined;
  }

  private async waitForGatewayTarget(
    gatewayId: string,
    targetId: string,
    options: CoreOptions,
  ): Promise<GetGatewayTargetResponse> {
    const attempts = this.options.waitAttempts ?? DEFAULT_WAIT_ATTEMPTS;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let response: GetGatewayTargetResponse;
      try {
        response = await this.getGatewayTarget(gatewayId, targetId, options);
      } catch (error) {
        if ((error as Error).name === "ResourceNotFoundException" && attempt < attempts) {
          await this.sleep(this.options.waitDelayMs ?? DEFAULT_WAIT_DELAY_MS);
          continue;
        }
        throw new GatewayOutcomeUnknownError(`Gateway Target ${targetId} under ${gatewayId}`, {
          cause: error,
        });
      }
      const status: string | undefined = response.status;
      if (status === "READY" || isPendingAuthorizationStatus(status)) return response;
      if (
        status === "FAILED" ||
        status === "UPDATE_UNSUCCESSFUL" ||
        status === "SYNCHRONIZE_UNSUCCESSFUL"
      ) {
        throw new GatewayTargetTerminalStateError(
          gatewayId,
          targetId,
          status,
          response.statusReasons ?? [],
        );
      }
      if (attempt < attempts) {
        await this.sleep(this.options.waitDelayMs ?? DEFAULT_WAIT_DELAY_MS);
      }
    }
    throw new GatewayOutcomeUnknownError(`Gateway Target ${targetId} under ${gatewayId}`);
  }

  private async waitForGatewayTargetDeletion(
    gatewayId: string,
    targetId: string,
    options: CoreOptions,
  ): Promise<void> {
    const attempts = this.options.waitAttempts ?? DEFAULT_WAIT_ATTEMPTS;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await this.getGatewayTarget(gatewayId, targetId, options);
        if (
          response.status === "FAILED" ||
          response.status === "UPDATE_UNSUCCESSFUL" ||
          response.status === "SYNCHRONIZE_UNSUCCESSFUL"
        ) {
          throw new GatewayTargetTerminalStateError(
            gatewayId,
            targetId,
            response.status,
            response.statusReasons ?? [],
          );
        }
      } catch (error) {
        if ((error as Error).name === "ResourceNotFoundException") return;
        if (error instanceof GatewayTargetTerminalStateError) throw error;
        throw new GatewayOutcomeUnknownError(`Gateway Target ${targetId} under ${gatewayId}`, {
          cause: error,
        });
      }
      if (attempt < attempts) {
        await this.sleep(this.options.waitDelayMs ?? DEFAULT_WAIT_DELAY_MS);
      }
    }
    throw new GatewayOutcomeUnknownError(`Gateway Target ${targetId} under ${gatewayId}`);
  }

  private planGatewayPolicy(
    inventory: GatewayPolicyInventory,
    overrides: Partial<{
      policyEngineConfiguration: GetGatewayResponse["policyEngineConfiguration"];
      interceptorConfigurations: GetGatewayResponse["interceptorConfigurations"];
      customTransformConfiguration: GetGatewayResponse["customTransformConfiguration"];
      targets: readonly {
        targetId?: string;
        name?: string;
        targetConfiguration?: TargetConfiguration;
        credentialProviderConfigurations?: readonly CredentialProviderConfiguration[];
      }[];
      credentialProviders: readonly GatewayCredentialProviderPolicyState[];
    }> = {},
  ): PolicyContribution[] {
    return this.planner.plan({
      gatewayArn: inventory.gateway.gatewayArn,
      workloadIdentityArn: inventory.gateway.workloadIdentityDetails?.workloadIdentityArn,
      policyEngineConfiguration:
        "policyEngineConfiguration" in overrides
          ? overrides.policyEngineConfiguration
          : inventory.gateway.policyEngineConfiguration,
      interceptorConfigurations:
        "interceptorConfigurations" in overrides
          ? overrides.interceptorConfigurations
          : inventory.gateway.interceptorConfigurations,
      customTransformConfiguration:
        "customTransformConfiguration" in overrides
          ? overrides.customTransformConfiguration
          : inventory.gateway.customTransformConfiguration,
      targets: overrides.targets ?? inventory.targets,
      credentialProviders: overrides.credentialProviders ?? inventory.credentialProviders,
    });
  }

  private async reconcileManagedPolicy<T>(input: {
    gatewayId: string;
    management: ManagedGatewayPolicy;
    currentState: GatewayPolicyInventory;
    desired: readonly PolicyContribution[];
    operation: () => Promise<T>;
    retryPropagation?: boolean;
    options: CoreOptions;
  }): Promise<T> {
    const iam = this.clients.iam({ region: input.options.region });
    const roleManager = new ExecutionRoleManager(iam, this.options.roleManager);
    const gatewayArn = GatewayClient.required(
      input.currentState.gateway.gatewayArn,
      `Gateway "${input.gatewayId}"`,
      "ARN",
    );
    await roleManager.validateAgentCoreTrust(input.management.roleName, {
      sourceAccount: accountIdFromRoleArn(input.management.roleArn),
      sourceArn: gatewayArn,
    });
    const policyName = gatewayPolicyName(
      input.management.roleName,
      input.management.roleArn,
      input.currentState.gateway.gatewayId ?? input.gatewayId,
      input.options.region,
    );
    const policyUpdater = new ExecutionRolePolicyUpdater(iam, {
      propagationDelayMs: 10_000,
      ...this.options.policyUpdater,
    });
    const result = await policyUpdater.update({
      roleName: input.management.roleName,
      policyName,
      current: this.planGatewayPolicy(input.currentState),
      desired: input.desired,
      operation: input.operation,
      ...(input.retryPropagation
        ? {
            operationRetry: {
              maxAttempts: 8,
              delayMs: 2_000,
              shouldRetry: isExecutionRolePropagationError,
            },
          }
        : {}),
      isOperationOutcomeUnknown: (error) => error instanceof GatewayOutcomeUnknownError,
      resolveDesired: async () => {
        const settledState = await this.readGatewayPolicyState(input.gatewayId, input.options);
        return {
          contributions: this.planGatewayPolicy(settledState),
          inventoryComplete: true,
        };
      },
    });
    return result.value;
  }

  private async readGatewayPolicyState(
    gatewayId: string,
    options: CoreOptions,
    knownGateway?: GetGatewayResponse,
  ): Promise<GatewayPolicyInventory> {
    const gateway = knownGateway ?? (await this.getGateway(gatewayId, options));
    const targets: GetGatewayTargetResponse[] = [];
    const seenTokens = new Set<string>();
    let nextToken: string | undefined;

    do {
      const page = await this.listGatewayTargets(gatewayId, nextToken, 100, options);
      for (const summary of page.items ?? []) {
        if (!summary.targetId)
          throw new Error(`Gateway ${gatewayId} returned a Target without ID.`);
        targets.push(await this.getGatewayTarget(gatewayId, summary.targetId, options));
      }
      if (page.nextToken && seenTokens.has(page.nextToken)) {
        throw new Error(`Gateway ${gatewayId} repeated Target pagination token.`);
      }
      if (page.nextToken) seenTokens.add(page.nextToken);
      nextToken = page.nextToken;
    } while (nextToken);

    return {
      gateway,
      targets,
      credentialProviders: await this.resolveCredentialProviderPolicyState(targets, options),
    };
  }

  private async resolveCredentialProviderPolicyState(
    targets: readonly {
      credentialProviderConfigurations?: readonly CredentialProviderConfiguration[];
    }[],
    options: CoreOptions,
  ): Promise<GatewayCredentialProviderPolicyState[]> {
    const providerTypes = new Map<string, "api-key" | "oauth">();
    for (const target of targets) {
      for (const configuration of target.credentialProviderConfigurations ?? []) {
        const providerArn =
          configuration.credentialProvider?.apiKeyCredentialProvider?.providerArn ??
          configuration.credentialProvider?.oauthCredentialProvider?.providerArn;
        const type =
          configuration.credentialProviderType === "API_KEY"
            ? "api-key"
            : configuration.credentialProviderType === "OAUTH"
              ? "oauth"
              : undefined;
        if (!type) continue;
        if (!providerArn) {
          throw new Error(
            `${configuration.credentialProviderType} credential provider ARN is missing.`,
          );
        }
        const existing = providerTypes.get(providerArn);
        if (existing && existing !== type) {
          throw new Error(`Credential provider ${providerArn} is used as two provider types.`);
        }
        providerTypes.set(providerArn, type);
      }
    }
    return new CredentialProviderPolicyResolver(
      this.clients.control(toClientConfig(options)),
    ).resolve(
      [...providerTypes].map(([providerArn, type]) => ({
        type,
        providerArn,
      })),
    );
  }
}

function expectedGatewayCliRoleName(gateway: GetGatewayResponse, gatewayId: string): string {
  if (!gateway.name) throw new Error(`Gateway ${gatewayId} returned no name.`);
  return ExecutionRoleManager.cliRoleName("gateway", gateway.name);
}

function accountIdFromRoleArn(roleArn: string): string {
  const accountId = roleArn.split(":")[4];
  if (!accountId) throw new Error(`Cannot extract account ID from role ARN "${roleArn}".`);
  return accountId;
}

function isExecutionRolePropagationError(error: unknown): boolean {
  return (
    ["ValidationException", "AccessDeniedException"].includes((error as Error).name) &&
    /role|permission|authoriz|assum|policy engine|lambda|invoke/i.test(
      (error as Error).message ?? "",
    )
  );
}

function isAmbiguousCreateError(error: unknown): boolean {
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

function stableGatewayPolicyKey(roleName: string, gatewayId: string): string {
  return roleName.startsWith("AgentCoreCliGateway-") ? roleName : gatewayId;
}

function gatewayPolicyName(
  roleName: string,
  roleArn: string,
  gatewayId: string,
  region: string,
): string {
  return ExecutionRoleManager.generatedPolicyName("gateway", {
    accountId: accountIdFromRoleArn(roleArn),
    region,
    stableResourceKey: stableGatewayPolicyKey(roleName, gatewayId),
  });
}

function isPendingAuthorizationStatus(status: string | undefined): boolean {
  return (
    status === "CREATE_PENDING_AUTH" ||
    status === "UPDATE_PENDING_AUTH" ||
    status === "SYNCHRONIZE_PENDING_AUTH"
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
