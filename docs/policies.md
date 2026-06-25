# Policies & Guardrails

Policy engines apply [Cedar](https://www.cedarpolicy.com/)-based authorization to gateway requests. A policy engine
attaches to one or more gateways and evaluates each request (and, for output-phase policies, each response) against the
policies it contains. Policies can be raw Cedar or built from a guided **form** that emits Bedrock guardrails — content
filters, prompt-attack detection, and sensitive-information detection.

The CLI models this as two resources:

- **Policy engine** (`add policy-engine`) — the Cedar engine that attaches to gateways.
- **Policy** (`add policy`) — an individual policy authored within an engine.

## Quick Start

```bash
# 1. Create a project
agentcore create --name MyProject --defaults
cd MyProject

# 2. Add a gateway to protect
agentcore add gateway --name MyGateway

# 3. Add a policy engine and attach it to the gateway in shadow (log-only) mode
agentcore add policy-engine \
  --name MyPolicyEngine \
  --description "Authorization for production gateways" \
  --attach-to-gateways MyGateway \
  --attach-mode LOG_ONLY

# 4. Add a content-filter guardrail policy built from the form
agentcore add policy \
  --name BlockHarmfulContent \
  --engine MyPolicyEngine \
  --form-category contentFilter \
  --form-filters VIOLENCE,HATE,SEXUAL,MISCONDUCT,INSULTS \
  --form-effect forbid

# 5. Deploy
agentcore deploy -y
```

Run interactively (`agentcore add policy-engine` / `agentcore add policy` with no flags) to use the TUI, which walks
through engine selection, the source method, and the form builder step by step.

## Policy Engines

A policy engine is a Cedar authorization engine. It holds a set of policies and is attached to one or more gateways; at
request time the gateway consults the engine to decide whether a request is allowed.

```bash
agentcore add policy-engine \
  --name MyPolicyEngine \
  --description "Authorization for production gateways" \
  --attach-to-gateways MyGateway,OtherGateway \
  --attach-mode ENFORCE
```

| Flag                              | Description                                                     |
| --------------------------------- | --------------------------------------------------------------- |
| `--name <name>`                   | Policy engine name                                              |
| `--description <desc>`            | Policy engine description                                       |
| `--encryption-key-arn <arn>`      | KMS encryption key ARN                                          |
| `--attach-to-gateways <gateways>` | Comma-separated gateway names to attach this engine to          |
| `--attach-mode <mode>`            | Enforcement mode for attached gateways: `LOG_ONLY` or `ENFORCE` |

`--attach-mode` controls how the engine behaves on the gateways it is attached to: `ENFORCE` blocks requests that fail
authorization, while `LOG_ONLY` evaluates policies and records the decision without blocking (shadow mode) — useful for
validating a new engine against production traffic before enforcing it.

## Policies

A policy lives inside an engine. There are four ways to supply one — the source method:

| Method     | Flag                  | Description                                                              |
| ---------- | --------------------- | ------------------------------------------------------------------------ |
| `form`     | `--form-*`            | Build a Bedrock guardrail from categories, filters, effect, and a data path |
| `file`     | `--source <path>`     | Load a Cedar policy from a file in your project                          |
| `inline`   | `--statement <cedar>` | Write a Cedar policy statement directly                                  |
| `generate` | `--generate <prompt>` | Generate a Cedar policy from a natural-language description              |

Only one source method may be used per policy.

```bash
# From a Cedar policy file
agentcore add policy \
  --name AdminAccess \
  --engine MyPolicyEngine \
  --source ./policies/admin.cedar

# Inline statement
agentcore add policy \
  --name DenyDelete \
  --engine MyPolicyEngine \
  --statement 'forbid(principal, action == Action::"Delete", resource);'

# Generate from natural language (uses a deployed gateway as context)
agentcore add policy \
  --name ReadOnlyForGuests \
  --engine MyPolicyEngine \
  --generate "Allow guests to read but never write or delete" \
  --gateway MyGateway
```

| Flag                       | Description                                                          |
| -------------------------- | -------------------------------------------------------------------- |
| `--name <name>`            | Policy name                                                          |
| `--engine <engine>`        | Policy engine name (must already exist)                              |
| `--description <desc>`     | Policy description                                                   |
| `--source <path>`          | Path to a Cedar policy file                                          |
| `--statement <cedar>`      | Cedar policy statement (inline)                                      |
| `-g, --generate <prompt>`  | Generate Cedar policy from natural language description              |
| `--gateway <name>`         | Deployed gateway name for policy generation (used with `--generate`) |
| `--target <name>`          | Gateway target name for Cedar action scope                          |
| `--form-category <type>`   | Guardrail category (see [Guardrail Categories](#guardrail-categories)) |
| `--form-filters <list>`    | Comma-separated filters for the chosen category                     |
| `--form-effect <effect>`   | Policy effect: `forbid`, `permit`, or `suppressOutput` (default: `forbid`) |
| `--form-data-path <path>`  | Data path to evaluate (default: `context.input.prompt`)             |
| `--validation-mode <mode>` | Validation mode: `FAIL_ON_ANY_FINDINGS` or `IGNORE_ALL_FINDINGS`    |
| `--enforcement-mode <mode>`| Enforcement mode: `ACTIVE` or `LOG_ONLY` (default: `ACTIVE`)        |

## Guardrail Categories

The form builder maps to Bedrock guardrails. Choose one category and the filters within it:

### Content Filter (`contentFilter`)

Detects harmful content. Filters: `VIOLENCE`, `HATE`, `SEXUAL`, `MISCONDUCT`, `INSULTS`.

### Prompt Attack (`promptAttack`)

Detects attempts to subvert the model. Filters: `JAILBREAK`, `PROMPT_INJECTION`, `PROMPT_LEAKAGE`.

### Sensitive Information (`sensitiveInformation`)

Detects PII and credentials. Filters include `ADDRESS`, `AGE`, `EMAIL`, `NAME`, `PHONE`, `PASSWORD`, `USERNAME`,
`URL`, `IP_ADDRESS`, `MAC_ADDRESS`, `DRIVER_ID`, `LICENSE_PLATE`, `VEHICLE_IDENTIFICATION_NUMBER`, the
`CREDIT_DEBIT_CARD_*` set, `AWS_ACCESS_KEY` / `AWS_SECRET_KEY`, the `US_*` identifiers (SSN, passport, bank account,
routing number, ITIN), the `UK_*` identifiers, the `CA_*` identifiers, `INTERNATIONAL_BANK_ACCOUNT_NUMBER`,
`SWIFT_CODE`, and `PIN`.

## Policy Effects

A form policy's effect determines what happens when a guardrail trips and which authorization phase the policy is
registered under:

| Effect           | Phase           | Behavior                                                                    |
| ---------------- | --------------- | --------------------------------------------------------------------------- |
| `forbid`         | `INITIATE`      | Block requests that exceed the threshold (evaluated against the input)      |
| `permit`         | `INITIATE`      | Allow requests that fall below the threshold (evaluated against the input)  |
| `suppressOutput` | `RETURN_OUTPUT` | Block the model's response when the output exceeds the threshold            |

`forbid` and `permit` evaluate the request at the `INITIATE` phase against input data (default data path
`context.input.prompt`). `suppressOutput` is an output-phase effect: it evaluates the model's response at the
`RETURN_OUTPUT` phase against `context.output.*` (default data path `context.output.prompt`) and blocks the response
when a guardrail trips.

## Enforcement Modes

Each policy carries an enforcement mode that controls whether its decisions take effect:

| Mode       | Behavior                                                                  |
| ---------- | ------------------------------------------------------------------------- |
| `ACTIVE`   | Policy decisions are enforced on requests (default)                       |
| `LOG_ONLY` | Policy is evaluated but decisions are observed only (shadow mode)         |

Use `LOG_ONLY` to validate a policy against real traffic before switching it to `ACTIVE`.

## Validation Modes

When a policy is added, the CLI runs the Cedar analyzer. The validation mode controls how analyzer findings are handled:

| Mode                   | Behavior                                          |
| ---------------------- | ------------------------------------------------- |
| `FAIL_ON_ANY_FINDINGS` | Block policies that fail analyzer validation (default) |
| `IGNORE_ALL_FINDINGS`  | Skip analyzer validation checks                   |

## Removing Policies & Engines

```bash
agentcore remove policy --name BlockHarmfulContent --engine MyPolicyEngine
agentcore remove policy-engine --name MyPolicyEngine
```

## Reference

See the [CLI Commands Reference](commands.md#add-policy-engine) for the full flag listing.
