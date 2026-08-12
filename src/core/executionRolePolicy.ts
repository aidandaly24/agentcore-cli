import { createHash } from "node:crypto";

export type OwnerKey = string;

export type GeneratedPolicyStatement = {
  effect: "Allow";
  actions: readonly string[];
  resources: readonly string[];
  conditions?: Readonly<Record<string, unknown>>;
};

export type PolicyContribution = {
  owner: OwnerKey;
  reason: string;
  statements: readonly GeneratedPolicyStatement[];
};

export type PolicyPermissionOwner = {
  owner: OwnerKey;
  reason: string;
};

export type CompiledPermission = {
  action: string;
  resource: string;
  conditions?: Readonly<Record<string, unknown>>;
  owners: readonly PolicyPermissionOwner[];
};

export type IamPolicyStatement = {
  Effect: "Allow";
  Action: readonly string[];
  Resource: readonly string[];
  Condition?: Readonly<Record<string, unknown>>;
};

export type IamPolicyDocument = {
  Version: "2012-10-17";
  Statement: readonly IamPolicyStatement[];
};

export type CompiledPolicy = {
  document: IamPolicyDocument;
  json: string;
  hash: string;
  characterCount: number;
  permissions: readonly CompiledPermission[];
};

type PermissionAtom = {
  action: string;
  resource: string;
  conditions?: Readonly<Record<string, unknown>>;
  owners: Map<string, PolicyPermissionOwner>;
};

export class PolicyCompilationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid generated execution policy:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "PolicyCompilationError";
  }
}

export class PolicySizeError extends Error {
  constructor(
    readonly characterCount: number,
    readonly maxCharacters: number,
  ) {
    super(
      `The generated execution policy is ${characterCount} characters, exceeding the ${maxCharacters}-character IAM limit.`,
    );
    this.name = "PolicySizeError";
  }
}

export const IAM_ROLE_INLINE_POLICY_MAX_CHARACTERS = 10_240;

export type PolicyCompilerOptions = {
  maxPolicyCharacters?: number;
};

export function allow(
  actions: readonly string[],
  resources: readonly string[],
  conditions?: Readonly<Record<string, unknown>>,
): GeneratedPolicyStatement {
  return {
    effect: "Allow",
    actions,
    resources,
    ...(conditions ? { conditions } : {}),
  };
}

export class PolicyCompiler {
  private readonly maxPolicyCharacters: number;

  constructor(options: PolicyCompilerOptions = {}) {
    this.maxPolicyCharacters = options.maxPolicyCharacters ?? IAM_ROLE_INLINE_POLICY_MAX_CHARACTERS;
  }

  compile(contributions: readonly PolicyContribution[]): CompiledPolicy {
    const issues = validateContributions(contributions);
    if (issues.length > 0) throw new PolicyCompilationError(issues);

    const atoms = new Map<string, PermissionAtom>();

    for (const contribution of contributions) {
      for (const statement of contribution.statements) {
        const actions = [...new Set(statement.actions)].sort();
        const resources = [...new Set(statement.resources)].sort();
        const conditions = statement.conditions
          ? (normalizeConditionValue(statement.conditions) as Readonly<Record<string, unknown>>)
          : undefined;
        const conditionsJson = conditions ? canonicalJson(conditions) : "";

        for (const action of actions) {
          for (const resource of resources) {
            const key = canonicalJson([conditionsJson, action, resource]);
            let atom = atoms.get(key);
            if (!atom) {
              atom = {
                action,
                resource,
                ...(conditions ? { conditions } : {}),
                owners: new Map(),
              };
              atoms.set(key, atom);
            }
            atom.owners.set(canonicalJson([contribution.owner, contribution.reason]), {
              owner: contribution.owner,
              reason: contribution.reason,
            });
          }
        }
      }
    }

    const permissions = [...atoms.values()].sort(compareAtoms).map<CompiledPermission>((atom) => ({
      action: atom.action,
      resource: atom.resource,
      ...(atom.conditions ? { conditions: atom.conditions } : {}),
      owners: [...atom.owners.values()].sort(compareOwners),
    }));
    const document: IamPolicyDocument = {
      Version: "2012-10-17",
      Statement: compactIdenticalNeighborhoods(permissions),
    };
    const json = canonicalJson(document);
    const characterCount = json.length;
    if (characterCount > this.maxPolicyCharacters) {
      throw new PolicySizeError(characterCount, this.maxPolicyCharacters);
    }

    return {
      document,
      json,
      hash: createHash("sha256").update(json).digest("hex"),
      characterCount,
      permissions,
    };
  }
}

function validateContributions(contributions: readonly PolicyContribution[]): string[] {
  const issues: string[] = [];

  contributions.forEach((contribution, contributionIndex) => {
    const contributionPath = `contribution[${contributionIndex}]`;
    if (!nonEmptyString(contribution.owner)) {
      issues.push(`${contributionPath}.owner must not be empty`);
    }
    if (!nonEmptyString(contribution.reason)) {
      issues.push(`${contributionPath}.reason must not be empty`);
    }
    if (!Array.isArray(contribution.statements)) {
      issues.push(`${contributionPath}.statements must be an array`);
      return;
    }

    contribution.statements.forEach((statement, statementIndex) => {
      const statementPath = `${contributionPath}.statements[${statementIndex}]`;
      if (statement.effect !== "Allow") {
        issues.push(`${statementPath}.effect must be "Allow"`);
      }
      validateStringList(statement.actions, `${statementPath}.actions`, "action", issues);
      validateStringList(statement.resources, `${statementPath}.resources`, "resource", issues);
      if (statement.conditions !== undefined) {
        validateJson(statement.conditions, `${statementPath}.conditions`, issues, new Set());
      }
    });
  });

  return issues;
}

function validateStringList(
  values: readonly string[],
  path: string,
  itemName: string,
  issues: string[],
): void {
  if (!Array.isArray(values)) {
    issues.push(`${path} must be an array`);
    return;
  }
  if (values.length === 0) {
    issues.push(`${path} must contain at least one ${itemName}`);
  }
  values.forEach((value, index) => {
    if (!nonEmptyString(value)) issues.push(`${path}[${index}] must not be empty`);
  });
}

function validateJson(
  value: unknown,
  path: string,
  issues: string[],
  ancestors: Set<object>,
): void {
  if (
    value === undefined ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    issues.push(`${path} must be valid JSON`);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (ancestors.has(value)) {
    issues.push(`${path} must be valid JSON`);
    return;
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateJson(entry, `${path}[${index}]`, issues, ancestors));
  } else {
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .forEach(([key, entry]) => validateJson(entry, `${path}.${key}`, issues, ancestors));
  }
  ancestors.delete(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeConditionValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const normalized = value.map(normalizeConditionValue);
    const byJson = new Map(normalized.map((entry) => [canonicalJson(entry), entry]));
    return [...byJson.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, entry]) => entry);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeConditionValue(entry)]),
    );
  }
  return value;
}

function compactIdenticalNeighborhoods(
  permissions: readonly CompiledPermission[],
): IamPolicyStatement[] {
  const conditionGroups = new Map<
    string,
    {
      conditions?: Readonly<Record<string, unknown>>;
      permissions: CompiledPermission[];
    }
  >();
  for (const permission of permissions) {
    const conditionsJson = permission.conditions ? canonicalJson(permission.conditions) : "";
    let group = conditionGroups.get(conditionsJson);
    if (!group) {
      group = {
        ...(permission.conditions ? { conditions: permission.conditions } : {}),
        permissions: [],
      };
      conditionGroups.set(conditionsJson, group);
    }
    group.permissions.push(permission);
  }

  const statements: IamPolicyStatement[] = [];
  for (const group of [...conditionGroups.values()].sort((left, right) =>
    canonicalJson(left.conditions ?? {}).localeCompare(canonicalJson(right.conditions ?? {})),
  )) {
    const byActions = compactConditionGroup(group.permissions, group.conditions, "actions");
    const byResources = compactConditionGroup(group.permissions, group.conditions, "resources");
    const actionsJson = canonicalJson(byActions);
    const resourcesJson = canonicalJson(byResources);
    statements.push(
      ...(resourcesJson.length < actionsJson.length ||
      (resourcesJson.length === actionsJson.length && resourcesJson < actionsJson)
        ? byResources
        : byActions),
    );
  }

  return statements.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function compactConditionGroup(
  permissions: readonly CompiledPermission[],
  conditions: Readonly<Record<string, unknown>> | undefined,
  orientation: "actions" | "resources",
): IamPolicyStatement[] {
  const neighborhoods = new Map<string, Set<string>>();
  for (const permission of permissions) {
    const primary = orientation === "actions" ? permission.action : permission.resource;
    const secondary = orientation === "actions" ? permission.resource : permission.action;
    let neighbors = neighborhoods.get(primary);
    if (!neighbors) {
      neighbors = new Set();
      neighborhoods.set(primary, neighbors);
    }
    neighbors.add(secondary);
  }

  const groups = new Map<string, { primary: Set<string>; secondary: readonly string[] }>();
  for (const [primary, neighbors] of neighborhoods) {
    const secondary = [...neighbors].sort();
    const key = canonicalJson(secondary);
    let group = groups.get(key);
    if (!group) {
      group = { primary: new Set(), secondary };
      groups.set(key, group);
    }
    group.primary.add(primary);
  }

  return [...groups.values()]
    .map<IamPolicyStatement>((group) => ({
      Effect: "Allow",
      Action: orientation === "actions" ? [...group.primary].sort() : [...group.secondary].sort(),
      Resource: orientation === "actions" ? [...group.secondary].sort() : [...group.primary].sort(),
      ...(conditions ? { Condition: conditions } : {}),
    }))
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function compareAtoms(left: PermissionAtom, right: PermissionAtom): number {
  const conditionsOrder = canonicalJson(left.conditions ?? {}).localeCompare(
    canonicalJson(right.conditions ?? {}),
  );
  return (
    conditionsOrder ||
    left.action.localeCompare(right.action) ||
    left.resource.localeCompare(right.resource)
  );
}

function compareOwners(left: PolicyPermissionOwner, right: PolicyPermissionOwner): number {
  return left.owner.localeCompare(right.owner) || left.reason.localeCompare(right.reason);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}
