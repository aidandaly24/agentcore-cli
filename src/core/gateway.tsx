import {
  CreateGatewayCommand,
  CreateGatewayRuleCommand,
  CreateGatewayTargetCommand,
  DeleteGatewayCommand,
  DeleteGatewayRuleCommand,
  DeleteGatewayTargetCommand,
  GetApiKeyCredentialProviderCommand,
  GetGatewayCommand,
  GetGatewayRuleCommand,
  GetGatewayTargetCommand,
  GetOauth2CredentialProviderCommand,
  GetTokenVaultCommand,
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
  GatewayTargetDeleteInput,
  GatewayRuleUpdateInput,
  GatewayTargetUpdatePatch,
  GatewayUpdatePatch,
} from "../handlers/gateway/types";
import type { AwsClients, CoreOptions } from "./types";
import {
  GatewayExecutionRole,
  GatewayMutationIndeterminateError,
  GatewayMutationTerminalError,
  matchesGatewayExecutionRole,
  type GatewayExecutionRoleOptions,
} from "./gatewayExecutionRole";
import { gatewayPolicy, type GatewayPolicyStatement } from "./gatewayPolicy";
import { toClientConfig } from "./utils";

const DEFAULT_CONNECTOR_PAGE_SIZE = 100;
const MAX_CONNECTOR_TARGET_PAGES = 101;
const DEFAULT_WAIT_ATTEMPTS = 150;
const DEFAULT_WAIT_DELAY_MS = 2_000;

type GatewayClientOptions = GatewayExecutionRoleOptions & {
  waitAttempts?: number;
  waitDelayMs?: number;
};

type GatewayCredentialState = {
  secrets: ReadonlyMap<string, string>;
  tokenVaultKmsKeyArn?: string;
};

type GatewayPolicyTargetState = Pick<
  GetGatewayTargetResponse,
  "targetConfiguration" | "credentialProviderConfigurations"
> & {
  targetId?: GetGatewayTargetResponse["targetId"];
};

type GatewayFamilyState = {
  gateway: GetGatewayResponse;
  targets: readonly GatewayPolicyTargetState[];
};

type GatewayPolicySnapshots = {
  current: GatewayPolicyStatement[];
  desired: GatewayPolicyStatement[];
};

export class GatewayClient implements CoreGatewayClient {
  constructor(
    private readonly clients: AwsClients,
    private readonly roleOptions: GatewayClientOptions = {},
  ) {}

  async getGatewayRolePolicyWarning(
    gatewayId: string,
    options: CoreOptions,
  ): Promise<string | undefined> {
    const gateway = await this.getGateway(gatewayId, options);
    const name = GatewayClient.required(gateway.name, "Gateway", "name");
    const roleArn = GatewayClient.required(gateway.roleArn, "Gateway", "role ARN");
    return (await this.managedExecutionRole(name, roleArn, options)) ? undefined : roleArn;
  }

  async createGateway(
    input: CreateGatewayInput,
    options: CoreOptions,
  ): Promise<CreateGatewayResponse> {
    const control = this.clients.control(toClientConfig(options));
    const { protocol, roleArn, ...request } = input;
    const operation = (executionRoleArn: string) =>
      control.send(
        new CreateGatewayCommand({
          ...request,
          roleArn: executionRoleArn,
          ...(protocol === "mcp" ? { protocolType: "MCP" as const } : {}),
        }),
      );
    if (roleArn) return operation(roleArn);
    const roleManager = this.executionRole(options);
    const role = await roleManager.ensure(request.name!, options.region);
    let response: CreateGatewayResponse;
    let createdResponse: CreateGatewayResponse | undefined;
    let mutationAccepted = false;
    try {
      const staged = gatewayPolicy({
        policyEngineArn: request.policyEngineConfiguration?.arn,
        interceptorConfigurations: request.interceptorConfigurations,
      });
      const current = role.created ? [] : await roleManager.read(role.arn);
      response = await roleManager.update(
        role.arn,
        current,
        staged,
        {
          mutate: async () => {
            const created = await this.mutate(
              () => operation(role.arn),
              `Gateway "${request.name}"`,
            );
            mutationAccepted = true;
            createdResponse = created;
            return created;
          },
          stabilize: async () => {
            const gatewayId = GatewayClient.required(
              createdResponse?.gatewayId,
              "Created Gateway",
              "ID",
            );
            await this.waitForGateway(gatewayId, options);
          },
        },
        { forcePropagation: role.created },
      );
    } catch (error) {
      if (
        error instanceof GatewayMutationTerminalError ||
        (!mutationAccepted && !(error instanceof GatewayMutationIndeterminateError))
      ) {
        await roleManager.rollbackCreate(role);
      }
      throw error;
    }
    const gatewayArn = GatewayClient.required(response.gatewayArn, "Created Gateway", "ARN");
    await roleManager.replace(
      role.arn,
      gatewayPolicy({
        gatewayArn,
        policyEngineArn: request.policyEngineConfiguration?.arn,
        interceptorConfigurations: request.interceptorConfigurations,
      }),
    );
    return response;
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
    const operation = () => control.send(new UpdateGatewayCommand(request));
    if (patch.skipRolePolicyUpdate) return operation();
    if (patch.roleArn && patch.roleArn !== roleArn) {
      const response = await operation();
      const roleManager = await this.managedExecutionRole(name, roleArn, options);
      if (roleManager) {
        await this.waitForGateway(patch.id, options);
        await roleManager.replace(roleArn, []);
      }
      return response;
    }
    if (
      patch.policyEngineConfiguration === undefined &&
      patch.interceptorConfigurations === undefined &&
      patch.customTransformConfiguration === undefined
    ) {
      return operation();
    }

    const roleManager = await this.managedExecutionRole(name, roleArn, options);
    if (!roleManager) return operation();
    const targets = await this.targetInventory(patch.id, options);
    const snapshots = await this.policySnapshots(
      { gateway: current, targets },
      {
        gateway: {
          ...current,
          policyEngineConfiguration,
          interceptorConfigurations,
          customTransformConfiguration,
        },
        targets,
      },
      options,
    );
    return roleManager.update(roleArn, snapshots.current, snapshots.desired, {
      mutate: () => this.mutate(operation, resource),
      stabilize: () => this.waitForGateway(patch.id, options),
    });
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
    const control = this.clients.control(toClientConfig(options));
    const operation = () => control.send(new DeleteGatewayCommand({ gatewayIdentifier: id }));
    const gateway = await control.send(new GetGatewayCommand({ gatewayIdentifier: id }));
    const name = GatewayClient.required(gateway.name, "Gateway", "name");
    const roleArn = GatewayClient.required(gateway.roleArn, "Gateway", "role ARN");
    const roleManager = await this.managedExecutionRole(name, roleArn, options);
    if (!roleManager) return operation();

    const response = await operation();
    await this.waitForGatewayDeletion(id, options);
    await roleManager.replace(roleArn, []);
    return response;
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
  ): Promise<CreateGatewayTargetResponse> {
    const control = this.clients.control(toClientConfig(options));
    const { skipRolePolicyUpdate, ...request } = input;
    const operation = () => control.send(new CreateGatewayTargetCommand(request));
    if (skipRolePolicyUpdate) return operation();
    const gateway = await control.send(
      new GetGatewayCommand({ gatewayIdentifier: request.gatewayIdentifier }),
    );
    const name = GatewayClient.required(gateway.name, "Gateway", "name");
    const roleArn = GatewayClient.required(gateway.roleArn, "Gateway", "role ARN");
    const roleManager = await this.managedExecutionRole(name, roleArn, options);
    if (!roleManager) return operation();

    const targets = await this.targetInventory(request.gatewayIdentifier!, options);
    const targetConfiguration = GatewayClient.required(
      request.targetConfiguration,
      "Gateway Target",
      "configuration",
    );
    const desiredTargets = [
      ...targets,
      {
        targetConfiguration,
        credentialProviderConfigurations: request.credentialProviderConfigurations,
      },
    ];
    const snapshots = await this.policySnapshots(
      { gateway, targets },
      { gateway, targets: desiredTargets },
      options,
    );
    let targetId: string | undefined;
    return roleManager.update(roleArn, snapshots.current, snapshots.desired, {
      mutate: async () => {
        const response = await this.mutate(
          operation,
          `Gateway Target "${request.name ?? "unnamed"}"`,
        );
        if (!response.targetId) {
          throw new GatewayMutationIndeterminateError(
            `Gateway Target "${request.name ?? "unnamed"}"`,
          );
        }
        targetId = response.targetId;
        return response;
      },
      stabilize: () => this.waitForGatewayTarget(request.gatewayIdentifier!, targetId!, options),
    });
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
    input: GatewayTargetDeleteInput,
    options: CoreOptions,
  ): Promise<DeleteGatewayTargetResponse> {
    const control = this.clients.control(toClientConfig(options));
    const { gatewayId, targetId, skipRolePolicyUpdate } = input;
    const request = { gatewayIdentifier: gatewayId, targetId };
    const operation = () => control.send(new DeleteGatewayTargetCommand(request));
    if (skipRolePolicyUpdate) return operation();
    const gateway = await control.send(new GetGatewayCommand({ gatewayIdentifier: gatewayId }));
    const name = GatewayClient.required(gateway.name, "Gateway", "name");
    const roleArn = GatewayClient.required(gateway.roleArn, "Gateway", "role ARN");
    const roleManager = await this.managedExecutionRole(name, roleArn, options);
    if (!roleManager) return operation();

    const remaining = await this.targetInventory(gatewayId, options, undefined, targetId);
    const credentials = await this.credentials(remaining, options);
    const desiredPolicy = this.policy(gateway, remaining, credentials);
    const reconcile = () => roleManager.replace(roleArn, desiredPolicy);

    let response: DeleteGatewayTargetResponse;
    try {
      response = await operation();
    } catch (error) {
      if ((error as Error).name !== "ResourceNotFoundException") throw error;
      await reconcile();
      throw error;
    }
    await this.waitForGatewayTargetDeletion(gatewayId, targetId, options);
    await reconcile();
    return response;
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
    const metadataConfiguration = GatewayClient.nonEmptyMetadata(
      GatewayClient.replace(current.metadataConfiguration, patch.metadataConfiguration),
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
    const operation = () => control.send(new UpdateGatewayTargetCommand(request));
    if (patch.skipRolePolicyUpdate) return operation();
    const gateway = await control.send(
      new GetGatewayCommand({ gatewayIdentifier: patch.gatewayId }),
    );
    const gatewayName = GatewayClient.required(gateway.name, "Gateway", "name");
    const roleArn = GatewayClient.required(gateway.roleArn, "Gateway", "role ARN");
    const roleManager = await this.managedExecutionRole(gatewayName, roleArn, options);
    if (!roleManager) return operation();

    const targets = await this.targetInventory(patch.gatewayId, options, current);
    const desiredTargets = targets.map((target) =>
      target.targetId === patch.targetId
        ? { ...target, targetConfiguration, credentialProviderConfigurations }
        : target,
    );
    const snapshots = await this.policySnapshots(
      { gateway, targets },
      { gateway, targets: desiredTargets },
      options,
    );
    return roleManager.update(roleArn, snapshots.current, snapshots.desired, {
      mutate: () =>
        this.mutate(
          operation,
          `Gateway Target "${patch.targetId}" under Gateway "${patch.gatewayId}"`,
        ),
      stabilize: () => this.waitForGatewayTarget(patch.gatewayId, patch.targetId, options),
    });
  }

  private static replace<T>(
    current: T | undefined,
    replacement: T | null | undefined,
  ): T | undefined {
    if (replacement === undefined) return current;
    return replacement === null ? undefined : replacement;
  }

  private static nonEmptyMetadata(
    configuration: UpdateGatewayTargetRequest["metadataConfiguration"],
  ): UpdateGatewayTargetRequest["metadataConfiguration"] {
    if (
      configuration &&
      Object.values(configuration).some((values) => values && values.length > 0)
    ) {
      return configuration;
    }
    return undefined;
  }

  private executionRole(options: CoreOptions): GatewayExecutionRole {
    return new GatewayExecutionRole(this.clients.iam({ region: options.region }), this.roleOptions);
  }

  private async managedExecutionRole(
    gatewayName: string,
    roleArn: string,
    options: CoreOptions,
  ): Promise<GatewayExecutionRole | undefined> {
    if (!matchesGatewayExecutionRole(gatewayName, options.region, roleArn)) return undefined;
    const role = this.executionRole(options);
    return (await role.isManaged(gatewayName, options.region, roleArn)) ? role : undefined;
  }

  private policy(
    gateway: GetGatewayResponse,
    targets: readonly GatewayPolicyTargetState[],
    credentials: GatewayCredentialState = { secrets: new Map() },
  ): GatewayPolicyStatement[] {
    return gatewayPolicy({
      gatewayArn: GatewayClient.required(gateway.gatewayArn, "Gateway", "ARN"),
      workloadIdentityArn: gateway.workloadIdentityDetails?.workloadIdentityArn,
      policyEngineArn: gateway.policyEngineConfiguration?.arn,
      interceptorConfigurations: gateway.interceptorConfigurations,
      customTransformConfiguration: gateway.customTransformConfiguration,
      credentialSecrets: credentials.secrets,
      tokenVaultKmsKeyArn: credentials.tokenVaultKmsKeyArn,
      targets: targets.map((target) => ({
        targetConfiguration: GatewayClient.required(
          target.targetConfiguration,
          "Gateway Target",
          "configuration",
        ),
        credentialProviderConfigurations: target.credentialProviderConfigurations,
      })),
    });
  }

  private async policySnapshots(
    current: GatewayFamilyState,
    desired: GatewayFamilyState,
    options: CoreOptions,
  ): Promise<GatewayPolicySnapshots> {
    const credentials = await this.credentials([...current.targets, ...desired.targets], options);
    return {
      current: this.policy(current.gateway, current.targets, credentials),
      desired: this.policy(desired.gateway, desired.targets, credentials),
    };
  }

  private async credentials(
    targets: readonly Pick<GatewayPolicyTargetState, "credentialProviderConfigurations">[],
    options: CoreOptions,
  ): Promise<GatewayCredentialState> {
    const providers = new Map<string, "api-key" | "oauth">();
    for (const target of targets) {
      for (const configuration of target.credentialProviderConfigurations ?? []) {
        const kind =
          configuration.credentialProviderType === "API_KEY"
            ? "api-key"
            : configuration.credentialProviderType === "OAUTH"
              ? "oauth"
              : undefined;
        if (!kind) continue;
        const providerArn =
          kind === "api-key"
            ? configuration.credentialProvider?.apiKeyCredentialProvider?.providerArn
            : configuration.credentialProvider?.oauthCredentialProvider?.providerArn;
        if (!providerArn) throw new Error(`${configuration.credentialProviderType} ARN is missing`);
        if (providers.get(providerArn) && providers.get(providerArn) !== kind) {
          throw new Error(`Credential provider ${providerArn} is used as two provider types`);
        }
        providers.set(providerArn, kind);
      }
    }

    const control = this.clients.control(toClientConfig(options));
    const secrets = new Map<string, string>();
    for (const [providerArn, kind] of providers) {
      const name = credentialProviderName(providerArn, kind);
      const response =
        kind === "api-key"
          ? await control.send(new GetApiKeyCredentialProviderCommand({ name }))
          : await control.send(new GetOauth2CredentialProviderCommand({ name }));
      if (response.credentialProviderArn !== providerArn) {
        throw new Error(`Credential provider ${name} returned an unexpected ARN`);
      }
      if (
        ("apiKeySecretSource" in response && response.apiKeySecretSource === "EXTERNAL") ||
        ("clientSecretSource" in response && response.clientSecretSource === "EXTERNAL")
      ) {
        throw new InputValidationError(
          `${kind === "api-key" ? "API key" : "OAuth"} credential provider ${providerArn} uses an external secret; rerun with --skip-role-policy-update and manage its secret and KMS permissions externally`,
        );
      }
      const secretArn =
        "apiKeySecretArn" in response
          ? response.apiKeySecretArn?.secretArn
          : response.clientSecretArn?.secretArn;
      if (!secretArn) throw new Error(`Credential provider ${providerArn} returned no secret ARN`);
      secrets.set(providerArn, secretArn);
    }
    if (providers.size === 0) return { secrets };
    const vault = await control.send(new GetTokenVaultCommand({ tokenVaultId: "default" }));
    const tokenVaultKmsKeyArn =
      vault.kmsConfiguration?.keyType === "CustomerManagedKey"
        ? vault.kmsConfiguration.kmsKeyArn
        : undefined;
    if (vault.kmsConfiguration?.keyType === "CustomerManagedKey" && !tokenVaultKmsKeyArn) {
      throw new Error("Default Token Vault returned no customer-managed KMS key ARN");
    }
    return { secrets, tokenVaultKmsKeyArn };
  }

  private async targetInventory(
    gatewayId: string,
    options: CoreOptions,
    known?: GetGatewayTargetResponse,
    excludedTargetId?: string,
  ): Promise<GetGatewayTargetResponse[]> {
    const targets: GetGatewayTargetResponse[] = [];
    let nextToken: string | undefined;
    for (let page = 0; page < MAX_CONNECTOR_TARGET_PAGES; page++) {
      const response = await this.listGatewayTargets(
        gatewayId,
        nextToken,
        DEFAULT_CONNECTOR_PAGE_SIZE,
        options,
      );
      for (const summary of response.items ?? []) {
        const targetId = GatewayClient.required(summary.targetId, "Gateway Target", "ID");
        if (targetId === excludedTargetId) continue;
        targets.push(
          known?.targetId === targetId
            ? known
            : await this.getGatewayTarget(gatewayId, targetId, options),
        );
      }
      if (!response.nextToken) return targets;
      nextToken = response.nextToken;
    }
    throw new ResultTruncationError(
      `Gateway Target discovery exceeded ${MAX_CONNECTOR_TARGET_PAGES} pages; policy inventory is incomplete`,
    );
  }

  private async mutate<T>(operation: () => Promise<T>, resource: string): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const statusCode = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode;
      if (statusCode === undefined || statusCode >= 500) {
        throw new GatewayMutationIndeterminateError(resource, { cause: error });
      }
      throw error;
    }
  }

  private async waitForGateway(gatewayId: string, options: CoreOptions): Promise<void> {
    await this.waitForTerminal(
      `Gateway "${gatewayId}"`,
      () => this.getGateway(gatewayId, options),
      ["READY"],
      ["FAILED", "UPDATE_UNSUCCESSFUL"],
    );
  }

  private async waitForGatewayTarget(
    gatewayId: string,
    targetId: string,
    options: CoreOptions,
  ): Promise<void> {
    await this.waitForTerminal(
      `Gateway Target "${targetId}"`,
      () => this.getGatewayTarget(gatewayId, targetId, options),
      ["READY", "CREATE_PENDING_AUTH", "UPDATE_PENDING_AUTH", "SYNCHRONIZE_PENDING_AUTH"],
      ["FAILED", "UPDATE_UNSUCCESSFUL", "SYNCHRONIZE_UNSUCCESSFUL"],
    );
  }

  private async waitForGatewayTargetDeletion(
    gatewayId: string,
    targetId: string,
    options: CoreOptions,
  ): Promise<void> {
    await this.waitForTerminal(
      `Gateway Target "${targetId}"`,
      () => this.getGatewayTarget(gatewayId, targetId, options),
      [],
      ["FAILED", "UPDATE_UNSUCCESSFUL", "SYNCHRONIZE_UNSUCCESSFUL"],
      true,
    );
  }

  private async waitForGatewayDeletion(gatewayId: string, options: CoreOptions): Promise<void> {
    await this.waitForTerminal(
      `Gateway "${gatewayId}"`,
      () => this.getGateway(gatewayId, options),
      [],
      ["FAILED", "UPDATE_UNSUCCESSFUL"],
      true,
    );
  }

  private async waitForTerminal(
    resource: string,
    read: () => Promise<{ status?: string; statusReasons?: string[] }>,
    successful: readonly string[],
    failed: readonly string[],
    missingIsSuccess = false,
  ): Promise<void> {
    const attempts = this.roleOptions.waitAttempts ?? DEFAULT_WAIT_ATTEMPTS;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const current = await read();
        lastError = undefined;
        if (current.status && successful.includes(current.status)) return;
        if (current.status && failed.includes(current.status)) {
          throw new GatewayMutationTerminalError(
            resource,
            current.status,
            current.statusReasons ?? [],
          );
        }
      } catch (error) {
        if (error instanceof GatewayMutationTerminalError) throw error;
        if ((error as Error).name === "ResourceNotFoundException" && missingIsSuccess) return;
        lastError = error;
      }
      if (attempt < attempts - 1) await this.wait();
    }
    throw new GatewayMutationIndeterminateError(
      resource,
      lastError === undefined ? undefined : { cause: lastError },
    );
  }

  private async wait(): Promise<void> {
    const milliseconds = this.roleOptions.waitDelayMs ?? DEFAULT_WAIT_DELAY_MS;
    if (milliseconds > 0) {
      await (
        this.roleOptions.sleep ?? ((delay) => new Promise((resolve) => setTimeout(resolve, delay)))
      )(milliseconds);
    }
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
}

function credentialProviderName(providerArn: string, kind: "api-key" | "oauth"): string {
  const resource = providerArn.split(":").slice(5).join(":");
  const type = kind === "api-key" ? "apikeycredentialprovider" : "oauth2credentialprovider";
  const name = resource.match(new RegExp(`^token-vault/[^/]+/${type}/([^/]+)$`))?.[1];
  if (!name) throw new Error(`Invalid ${kind} credential provider ARN: ${providerArn}`);
  return name;
}
