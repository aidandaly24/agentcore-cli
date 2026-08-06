import { randomUUID } from "node:crypto";
import {
  CreateGatewayCommand,
  CreateGatewayRuleCommand,
  CreateGatewayTargetCommand,
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
  type GetGatewayResponse,
  type GetGatewayRuleResponse,
  type GetGatewayTargetResponse,
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
import { InputValidationError, ResultTruncationError } from "../errors";
import { GatewayConnectorTarget } from "../handlers/gateway/connector/gatewayConnectorTarget";
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
import { ExecutionRoleManager, type ExecutionRoleManagerOptions } from "./executionRoleManager";
import {
  ExecutionRolePolicyUpdater,
  PolicyFinalizationError,
  PolicyOperationOutcomeUnknownError,
  type ExecutionRolePolicyUpdaterOptions,
} from "./executionRolePolicyUpdater";
import { GatewayPolicyPlanner } from "./gatewayPolicy";
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
        resolveDesired: async ({ settled }) => ({
          contributions: this.planner.plan(
            await this.readGatewayPolicyState(settled.gatewayId!, options, settled).then(
              (state) => ({
                gatewayArn: state.gateway.gatewayArn,
                policyEngineConfiguration: state.gateway.policyEngineConfiguration,
                interceptorConfigurations: state.gateway.interceptorConfigurations,
                customTransformConfiguration: state.gateway.customTransformConfiguration,
                targets: state.targets,
              }),
            ),
          ),
          inventoryComplete: true,
        }),
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
    const name = GatewayClient.required(current.name, patch.id, "name");
    const roleArn = GatewayClient.required(current.roleArn, patch.id, "role ARN");
    const authorizerType = GatewayClient.required(
      current.authorizerType,
      patch.id,
      "authorizer type",
    );
    if (patch.authorizerConfiguration !== undefined && authorizerType !== "CUSTOM_JWT") {
      throw new InputValidationError(
        "--authorizer-configuration is valid only for a CUSTOM_JWT Gateway",
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
      ...(description !== undefined ? { description } : {}),
      ...(!patch.clearProtocol && current.protocolType !== undefined
        ? { protocolType: current.protocolType }
        : {}),
      ...(protocolConfiguration !== undefined ? { protocolConfiguration } : {}),
      ...(current.authorizerConfiguration !== undefined ||
      patch.authorizerConfiguration !== undefined
        ? {
            authorizerConfiguration:
              patch.authorizerConfiguration ?? current.authorizerConfiguration,
          }
        : {}),
      ...(current.kmsKeyArn !== undefined ? { kmsKeyArn: current.kmsKeyArn } : {}),
      ...(customTransformConfiguration !== undefined ? { customTransformConfiguration } : {}),
      ...(interceptorConfigurations !== undefined ? { interceptorConfigurations } : {}),
      ...(policyEngineConfiguration !== undefined ? { policyEngineConfiguration } : {}),
      ...(exceptionLevel !== undefined ? { exceptionLevel } : {}),
      ...(wafConfiguration !== undefined ? { wafConfiguration } : {}),
    };
    return control.send(new UpdateGatewayCommand(request));
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
    const iam = this.clients.iam({ region: options.region });
    const roleManager = new ExecutionRoleManager(iam, this.options.roleManager);
    await roleManager.validateAgentCoreTrust(management.roleName);
    const policyName = ExecutionRoleManager.generatedPolicyName("gateway", {
      accountId: accountIdFromRoleArn(management.roleArn),
      region: options.region,
      stableResourceKey: stableGatewayPolicyKey(
        management.roleName,
        currentState.gateway.gatewayId ?? input.gatewayIdentifier!,
      ),
    });
    const current = this.planner.plan({
      gatewayArn: currentState.gateway.gatewayArn,
      policyEngineConfiguration: currentState.gateway.policyEngineConfiguration,
      interceptorConfigurations: currentState.gateway.interceptorConfigurations,
      customTransformConfiguration: currentState.gateway.customTransformConfiguration,
      targets: currentState.targets,
    });
    const proposedTarget = {
      name: input.name,
      targetConfiguration: input.targetConfiguration,
      credentialProviderConfigurations: input.credentialProviderConfigurations,
    };
    const desired = this.planner.plan({
      gatewayArn: currentState.gateway.gatewayArn,
      policyEngineConfiguration: currentState.gateway.policyEngineConfiguration,
      interceptorConfigurations: currentState.gateway.interceptorConfigurations,
      customTransformConfiguration: currentState.gateway.customTransformConfiguration,
      targets: [...currentState.targets, proposedTarget],
    });
    const policyUpdater = new ExecutionRolePolicyUpdater(iam, {
      propagationDelayMs: 10_000,
      ...this.options.policyUpdater,
    });
    const request = {
      ...input,
      clientToken: input.clientToken ?? randomUUID(),
    };

    const result = await policyUpdater.update({
      roleName: management.roleName,
      policyName,
      current,
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
      operationRetry: {
        maxAttempts: 8,
        delayMs: 2_000,
        shouldRetry: isExecutionRolePropagationError,
      },
      isOperationOutcomeUnknown: (error) => error instanceof GatewayOutcomeUnknownError,
      resolveDesired: async () => {
        const settledState = await this.readGatewayPolicyState(input.gatewayIdentifier!, options);
        return {
          contributions: this.planner.plan({
            gatewayArn: settledState.gateway.gatewayArn,
            policyEngineConfiguration: settledState.gateway.policyEngineConfiguration,
            interceptorConfigurations: settledState.gateway.interceptorConfigurations,
            customTransformConfiguration: settledState.gateway.customTransformConfiguration,
            targets: settledState.targets,
          }),
          inventoryComplete: true,
        };
      },
    });
    return { response: result.value };
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
    if (connectorOnly && !GatewayConnectorTarget.is(current.targetConfiguration)) {
      throw new InputValidationError(`Gateway Target "${patch.targetId}" is not connector-backed`);
    }

    let targetConfiguration = patch.targetConfiguration;
    if (targetConfiguration === undefined && patch.endpoint !== undefined) {
      const mcpServer = current.targetConfiguration?.mcp?.mcpServer;
      if (!mcpServer) {
        throw new InputValidationError("--endpoint requires an existing MCP server Target");
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
    targetConfiguration ??= current.targetConfiguration;
    if (!targetConfiguration) {
      throw new InputValidationError(
        `Gateway Target "${patch.targetId}" is missing its configuration required for update`,
      );
    }

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
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(credentialProviderConfigurations !== undefined
        ? { credentialProviderConfigurations }
        : {}),
      ...(metadataConfiguration !== undefined ? { metadataConfiguration } : {}),
      ...(privateEndpoint !== undefined ? { privateEndpoint } : {}),
    };
    if (connectorOnly && !GatewayConnectorTarget.is(request.targetConfiguration)) {
      throw new InputValidationError(
        "--connector-configuration must contain an MCP or inference connector Target",
      );
    }
    return control.send(new UpdateGatewayTargetCommand(request));
  }

  private static replace<T>(
    current: T | undefined,
    replacement: T | null | undefined,
  ): T | undefined {
    if (replacement === undefined) return current;
    return replacement === null ? undefined : replacement;
  }

  private static required<T>(value: T | undefined, id: string, field: string): T {
    if (value === undefined) {
      throw new InputValidationError(`Gateway "${id}" is missing its ${field} required for update`);
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

  private async readGatewayPolicyState(
    gatewayId: string,
    options: CoreOptions,
    knownGateway?: GetGatewayResponse,
  ): Promise<{
    gateway: GetGatewayResponse;
    targets: GetGatewayTargetResponse[];
  }> {
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

    return { gateway, targets };
  }
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

function stableGatewayPolicyKey(roleName: string, gatewayId: string): string {
  return roleName.startsWith("AgentCoreCliGateway-") ? roleName : gatewayId;
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
