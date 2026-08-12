import {
  DeleteRolePolicyCommand,
  GetRolePolicyCommand,
  ListRolePoliciesCommand,
  PutRolePolicyCommand,
  type IAMClient,
} from "@aws-sdk/client-iam";
import {
  PolicyCompiler,
  IAM_ROLE_INLINE_POLICY_MAX_CHARACTERS,
  canonicalJson,
  type CompiledPolicy,
  type GeneratedPolicyStatement,
  type PolicyContribution,
} from "./executionRolePolicy";

export type ExecutionRolePolicyUpdaterOptions = {
  compiler?: PolicyCompiler;
  maxVisibilityAttempts?: number;
  retryDelayMs?: number;
  propagationDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export type ExecutionRolePolicyUpdate<T> = {
  roleName: string;
  policyName: string;
  current: readonly PolicyContribution[];
  desired: readonly PolicyContribution[];
  inventoryComplete?: boolean;
  operation: () => Promise<T>;
  operationRetry?: OperationRetryPolicy;
  resolveDesired?: (value: T) => Promise<ResolvedExecutionRolePolicy>;
};

export type OperationRetryPolicy = {
  maxAttempts: number;
  delayMs: number;
  shouldRetry: (error: unknown, attempt: number) => boolean;
};

export type ResolvedExecutionRolePolicy = {
  contributions: readonly PolicyContribution[];
  inventoryComplete?: boolean;
};

export type ExecutionRolePolicyUpdateResult<T> = {
  value: T;
  currentHash: string;
  transitionHash: string;
  desiredHash: string;
  tightened: boolean;
};

export class PolicyPropagationError extends Error {
  constructor(
    readonly roleName: string,
    readonly policyName: string,
  ) {
    super(`IAM policy ${policyName} on role ${roleName} did not become visible after update.`);
    this.name = "PolicyPropagationError";
  }
}

export class PolicyDriftError extends Error {
  constructor(
    readonly roleName: string,
    readonly policyName: string,
  ) {
    super(`IAM policy ${policyName} on role ${roleName} changed during the AgentCore operation.`);
    this.name = "PolicyDriftError";
  }
}

export class ExistingGeneratedPolicyError extends Error {
  constructor(
    readonly roleName: string,
    readonly policyName: string,
    message: string,
  ) {
    super(`Cannot preserve generated IAM policy ${policyName} on role ${roleName}: ${message}`);
    this.name = "ExistingGeneratedPolicyError";
  }
}

export class RoleInlinePolicyQuotaError extends Error {
  readonly totalCharacterCount: number;

  constructor(
    readonly roleName: string,
    readonly policyName: string,
    readonly externalCharacterCount: number,
    readonly generatedCharacterCount: number,
    readonly maxCharacters: number,
  ) {
    const totalCharacterCount = externalCharacterCount + generatedCharacterCount;
    super(
      `The generated execution policy cannot fit on role ${roleName}: ` +
        `${externalCharacterCount} existing inline-policy characters plus ` +
        `${generatedCharacterCount} generated characters exceeds IAM's ` +
        `${maxCharacters}-character role limit.`,
    );
    this.name = "RoleInlinePolicyQuotaError";
    this.totalCharacterCount = totalCharacterCount;
  }
}

export class PolicyFinalizationError<T> extends Error {
  constructor(
    readonly value: T,
    readonly transitionHash: string,
    readonly desiredHash: string,
    options: ErrorOptions,
  ) {
    super("AgentCore succeeded but execution-role policy finalization failed.", options);
    this.name = "PolicyFinalizationError";
  }
}

export class ExecutionRolePolicyUpdater {
  private readonly compiler: PolicyCompiler;
  private readonly maxVisibilityAttempts: number;
  private readonly retryDelayMs: number;
  private readonly propagationDelayMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly iam: IAMClient,
    options: ExecutionRolePolicyUpdaterOptions = {},
  ) {
    this.compiler = options.compiler ?? new PolicyCompiler();
    this.maxVisibilityAttempts = options.maxVisibilityAttempts ?? 8;
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.propagationDelayMs = options.propagationDelayMs ?? 2_000;
    this.sleep = options.sleep ?? delay;
  }

  async update<T>(
    request: ExecutionRolePolicyUpdate<T>,
  ): Promise<ExecutionRolePolicyUpdateResult<T>> {
    return rolePolicyTransactions.run(request.roleName, () => this.updateUnlocked(request));
  }

  private async updateUnlocked<T>(
    request: ExecutionRolePolicyUpdate<T>,
  ): Promise<ExecutionRolePolicyUpdateResult<T>> {
    const stagedInventoryComplete = request.inventoryComplete ?? true;
    const existingPolicy = stagedInventoryComplete
      ? undefined
      : await this.readExistingPolicyContribution(request.roleName, request.policyName);
    const safeCurrentContributions = existingPolicy
      ? [existingPolicy, ...request.current]
      : request.current;
    const current = this.compiler.compile(safeCurrentContributions);
    const stagedDesiredContributions = stagedInventoryComplete
      ? request.desired
      : [...safeCurrentContributions, ...request.desired];
    let desired = this.compiler.compile(stagedDesiredContributions);
    const transitionContributions = [...safeCurrentContributions, ...stagedDesiredContributions];
    const transition = this.compiler.compile(transitionContributions);
    const transitionStaged = transition.document.Statement.length > 0;

    if (transitionStaged) {
      await this.preflightRoleQuota(request.roleName, request.policyName, transition);
      try {
        await this.putAndWait(request.roleName, request.policyName, transition);
      } catch (transitionError) {
        try {
          await this.writeExact(request.roleName, request.policyName, current);
        } catch (rollbackError) {
          throw new AggregateError(
            [transitionError, rollbackError],
            "Execution-role transition failed and the current policy could not be restored.",
          );
        }
        throw transitionError;
      }
    }

    let value: T;
    try {
      value = await this.runOperation(request.operation, request.operationRetry);
    } catch (operationError) {
      if (transitionStaged) {
        try {
          await this.writeExact(request.roleName, request.policyName, current);
        } catch (rollbackError) {
          throw new AggregateError(
            [operationError, rollbackError],
            "AgentCore operation failed and its execution-role policy could not be restored.",
          );
        }
      }
      throw operationError;
    }

    let finalInventoryComplete = stagedInventoryComplete;
    try {
      if (request.resolveDesired) {
        const resolved = await request.resolveDesired(value);
        finalInventoryComplete = resolved.inventoryComplete ?? true;
        const finalContributions = finalInventoryComplete
          ? resolved.contributions
          : [...transitionContributions, ...resolved.contributions];
        desired = this.compiler.compile(finalContributions);
      }
      if (transitionStaged) {
        await this.assertExact(request.roleName, request.policyName, transition);
      }
      if (!transitionStaged || transition.hash !== desired.hash) {
        await this.writeExact(request.roleName, request.policyName, desired);
      }
    } catch (error) {
      throw new PolicyFinalizationError(value, transition.hash, desired.hash, { cause: error });
    }

    return {
      value,
      currentHash: current.hash,
      transitionHash: transition.hash,
      desiredHash: desired.hash,
      tightened: finalInventoryComplete && transition.hash !== desired.hash,
    };
  }

  private async runOperation<T>(
    operation: () => Promise<T>,
    retry: OperationRetryPolicy | undefined,
  ): Promise<T> {
    const maxAttempts = Math.max(1, retry?.maxAttempts ?? 1);
    for (let attempt = 1; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (!retry || attempt >= maxAttempts || !retry.shouldRetry(error, attempt)) throw error;
        await this.sleep(retry.delayMs);
      }
    }
  }

  private async writeExact(
    roleName: string,
    policyName: string,
    policy: CompiledPolicy,
  ): Promise<void> {
    if (policy.document.Statement.length === 0) {
      await this.deletePolicy(roleName, policyName);
      await this.waitUntilAbsent(roleName, policyName);
      return;
    }

    await this.preflightRoleQuota(roleName, policyName, policy);
    await this.putAndWait(roleName, policyName, policy);
  }

  private async putAndWait(
    roleName: string,
    policyName: string,
    policy: CompiledPolicy,
  ): Promise<void> {
    await this.iam.send(
      new PutRolePolicyCommand({
        RoleName: roleName,
        PolicyName: policyName,
        PolicyDocument: policy.json,
      }),
    );
    await this.waitUntilExact(roleName, policyName, policy);
  }

  private async preflightRoleQuota(
    roleName: string,
    policyName: string,
    policy: CompiledPolicy,
  ): Promise<void> {
    const policyNames = await this.listRolePolicyNames(roleName);
    let externalCharacterCount = 0;

    for (const existingPolicyName of policyNames.sort()) {
      if (existingPolicyName === policyName) continue;
      const response = await this.iam.send(
        new GetRolePolicyCommand({
          RoleName: roleName,
          PolicyName: existingPolicyName,
        }),
      );
      if (response.PolicyDocument === undefined) {
        throw new Error(
          `IAM returned no policy document for ${existingPolicyName} on role ${roleName}.`,
        );
      }
      externalCharacterCount += countPolicyCharacters(response.PolicyDocument);
    }

    if (externalCharacterCount + policy.characterCount > IAM_ROLE_INLINE_POLICY_MAX_CHARACTERS) {
      throw new RoleInlinePolicyQuotaError(
        roleName,
        policyName,
        externalCharacterCount,
        policy.characterCount,
        IAM_ROLE_INLINE_POLICY_MAX_CHARACTERS,
      );
    }
  }

  private async readExistingPolicyContribution(
    roleName: string,
    policyName: string,
  ): Promise<PolicyContribution | undefined> {
    let policyDocument: string;
    try {
      const response = await this.iam.send(
        new GetRolePolicyCommand({ RoleName: roleName, PolicyName: policyName }),
      );
      if (response.PolicyDocument === undefined) {
        throw new ExistingGeneratedPolicyError(
          roleName,
          policyName,
          "IAM returned no policy document.",
        );
      }
      policyDocument = response.PolicyDocument;
    } catch (error) {
      if ((error as Error).name === "NoSuchEntityException") return undefined;
      throw error;
    }

    try {
      const parsed = JSON.parse(decodePolicyDocument(policyDocument)) as unknown;
      if (!isRecord(parsed)) throw new Error("policy document must be an object");
      const rawStatements = Array.isArray(parsed.Statement) ? parsed.Statement : [parsed.Statement];
      const statements = rawStatements.map<GeneratedPolicyStatement>((rawStatement, index) => {
        if (!isRecord(rawStatement)) throw new Error(`statement[${index}] must be an object`);
        if (rawStatement.Effect !== "Allow") {
          throw new Error(`statement[${index}] must use Effect Allow`);
        }
        if ("NotAction" in rawStatement || "NotResource" in rawStatement) {
          throw new Error(`statement[${index}] cannot use NotAction or NotResource`);
        }
        const actions = policyStringList(rawStatement.Action, `statement[${index}].Action`);
        const resources = policyStringList(rawStatement.Resource, `statement[${index}].Resource`);
        if (rawStatement.Condition !== undefined && !isRecord(rawStatement.Condition)) {
          throw new Error(`statement[${index}].Condition must be an object`);
        }
        return {
          effect: "Allow",
          actions,
          resources,
          ...(rawStatement.Condition
            ? { conditions: rawStatement.Condition as Readonly<Record<string, unknown>> }
            : {}),
        };
      });
      return {
        owner: `existing-policy:${policyName}`,
        reason: "preserve permissions from incomplete inventory",
        statements,
      };
    } catch (error) {
      if (error instanceof ExistingGeneratedPolicyError) throw error;
      throw new ExistingGeneratedPolicyError(roleName, policyName, (error as Error).message);
    }
  }

  private async listRolePolicyNames(roleName: string): Promise<string[]> {
    const policyNames = new Set<string>();
    let marker: string | undefined;

    do {
      const response = await this.iam.send(
        new ListRolePoliciesCommand({
          RoleName: roleName,
          ...(marker ? { Marker: marker } : {}),
        }),
      );
      for (const policyName of response.PolicyNames ?? []) policyNames.add(policyName);
      if (response.IsTruncated && !response.Marker) {
        throw new Error(`IAM truncated inline policies for role ${roleName} without a marker.`);
      }
      marker = response.IsTruncated ? response.Marker : undefined;
    } while (marker);

    return [...policyNames];
  }

  private async assertExact(
    roleName: string,
    policyName: string,
    policy: CompiledPolicy,
  ): Promise<void> {
    try {
      const response = await this.iam.send(
        new GetRolePolicyCommand({ RoleName: roleName, PolicyName: policyName }),
      );
      if (
        response.PolicyDocument === undefined ||
        normalizePolicyDocument(response.PolicyDocument) !== policy.json
      ) {
        throw new PolicyDriftError(roleName, policyName);
      }
    } catch (error) {
      if ((error as Error).name === "NoSuchEntityException") {
        throw new PolicyDriftError(roleName, policyName);
      }
      throw error;
    }
  }

  private async waitUntilExact(
    roleName: string,
    policyName: string,
    policy: CompiledPolicy,
  ): Promise<void> {
    for (let attempt = 1; attempt <= this.maxVisibilityAttempts; attempt++) {
      try {
        const response = await this.iam.send(
          new GetRolePolicyCommand({ RoleName: roleName, PolicyName: policyName }),
        );
        if (
          response.PolicyDocument !== undefined &&
          normalizePolicyDocument(response.PolicyDocument) === policy.json
        ) {
          await this.sleep(this.propagationDelayMs);
          return;
        }
      } catch (error) {
        if ((error as Error).name !== "NoSuchEntityException") throw error;
      }
      if (attempt < this.maxVisibilityAttempts) await this.sleep(this.retryDelayMs);
    }
    throw new PolicyPropagationError(roleName, policyName);
  }

  private async deletePolicy(roleName: string, policyName: string): Promise<void> {
    try {
      await this.iam.send(
        new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: policyName }),
      );
    } catch (error) {
      if ((error as Error).name !== "NoSuchEntityException") throw error;
    }
  }

  private async waitUntilAbsent(roleName: string, policyName: string): Promise<void> {
    for (let attempt = 1; attempt <= this.maxVisibilityAttempts; attempt++) {
      try {
        await this.iam.send(
          new GetRolePolicyCommand({ RoleName: roleName, PolicyName: policyName }),
        );
      } catch (error) {
        if ((error as Error).name === "NoSuchEntityException") {
          await this.sleep(this.propagationDelayMs);
          return;
        }
        throw error;
      }
      if (attempt < this.maxVisibilityAttempts) await this.sleep(this.retryDelayMs);
    }
    throw new PolicyPropagationError(roleName, policyName);
  }
}

class KeyedTransactionSerializer {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(
      () => current,
      () => current,
    );
    this.tails.set(key, tail);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

const rolePolicyTransactions = new KeyedTransactionSerializer();

function normalizePolicyDocument(policyDocument: string): string {
  return canonicalJson(JSON.parse(decodePolicyDocument(policyDocument)));
}

function countPolicyCharacters(policyDocument: string): number {
  const decoded = decodePolicyDocument(policyDocument);
  let count = 0;
  let inString = false;
  let escaped = false;

  for (const character of decoded) {
    if (inString) {
      count++;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
    } else if (character === '"') {
      count++;
      inString = true;
    } else if (!/\s/.test(character)) {
      count++;
    }
  }

  return count;
}

function decodePolicyDocument(policyDocument: string): string {
  try {
    JSON.parse(policyDocument);
    return policyDocument;
  } catch (originalError) {
    try {
      const decoded = decodeURIComponent(policyDocument);
      JSON.parse(decoded);
      return decoded;
    } catch {
      throw originalError;
    }
  }
}

function policyStringList(value: unknown, path: string): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
  throw new Error(`${path} must be a string or string array`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
