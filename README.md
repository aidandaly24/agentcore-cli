# AgentCore CLI

`agentcore` is a command-line tool and interactive terminal UI (TUI) for managing
**[AWS Bedrock AgentCore](https://aws.amazon.com/bedrock/agentcore/)**. AgentCore is Amazon's
platform for building and running production AI agents.

**[Amazon Bedrock AgentCore documentation](https://docs.aws.amazon.com/bedrock-agentcore/)**

It gives you two ways to work, from the same package:

- **A scriptable CLI** — composed of flag-driven commands with JSON output (`--json`) for
  coding agents, scripts, CI, and automation.
- **An interactive TUI** — guided workflows for creating projects, browsing
  resources, and chatting with agents.

```bash
agentcore                      # launch the interactive TUI
agentcore harness list --json  # scriptable, machine-readable output
```

## What problem does it solve?

Using the AgentCore APIs directly means making calls across several services,
setting up execution roles, and handling streamed responses. `agentcore` handles
those details so you can create, deploy, and invoke agents from your terminal.

## Quick Start

Create a managed Harness project, deploy it, and send a prompt:

```bash
agentcore project create --name MyAssistant
cd MyAssistant
agentcore project deploy
agentcore project invoke harness --prompt "Hey, what can you do for me?"
```

To start with code you own instead, create a Runtime project from a template.
Run this alternative from outside an existing project:

```bash
agentcore project create --name MyAgent --template agent-python-strands
```

## Command Surface

`project` commands manage local project specifications and their deployments.
Resource commands operate on deployed resources without requiring a local project.

| Command    | Purpose                                                                       |
| ---------- | ----------------------------------------------------------------------------- |
| `project`  | Create, develop, build, deploy, invoke, and inspect a project                 |
| `harness`  | Manage Harnesses, versions, and endpoints; invoke and inspect them            |
| `identity` | Manage credential providers                                                   |
| `runtime`  | Inspect, invoke, and open a shell in deployed Runtimes                        |
| `memory`   | Inspect Memories, actors, sessions, events, and records                       |
| `gateway`  | Inspect and invoke Gateways, inspect targets and rules, and generate policies |
| `payment`  | Inspect payment managers, connectors, sessions, instruments, and balances     |
| `eval`     | Evaluate agents, manage datasets and configurations, and run experiments      |
| `feedback` | Submit feedback                                                               |
| `config`   | Read and write global CLI settings                                            |
| `update`   | Check for and install CLI updates                                             |

Use `--help` for subcommands and flags, or browse the [command reference](command.md):

```bash
agentcore --help
agentcore project --help
agentcore runtime invoke --help
```

Supported bare commands open their interactive flows in a terminal. Operation
flags select headless behavior for most commands, but invoke commands can use
selectors such as `--id` and `--session-id` to seed an interactive console.
Run `agentcore project create` for guided setup. To create a default project
without the wizard, run `agentcore project create --name MyAssistant`.

Global flags (declared at the root, available on every command):

| Flag       | Purpose                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------- |
| `--region` | AWS region: flag, `AWS_REGION`, `AWS_DEFAULT_REGION`, active AWS profile, then `us-east-1`. |
| `--json`   | Emit machine-readable JSON instead of launching the TUI.                                    |
| `--debug`  | Debug logging.                                                                              |

Run `agentcore --version` to check the installed CLI version.

## Extending the CDK app

`agentcore/cdk/` has two source files. `bin/cdk.ts` reads the project once
(`readAgentCoreProject`), makes one stack per deployment target
(`resolveTargetStacks`) and turns `agentcore.json` into the application's props
(`transformAgentCoreJson`). All three come from `@aws/agentcore-cdk`, so that
logic is updated through the library rather than changes to your CDK app.

`lib/cdk-stack.ts` instantiates one `AgentCoreApplication`. This is the file you
edit to add your own resources. Runtimes and harnesses implement `iam.IGrantable`,
so you can pass them to a resource's CDK grant methods to give your agents access.
Use `addEnvironmentVariable` to pass resource names, ARNs, or endpoints to your agent.

This example gives the generated runtime named `agent` access to a table:

```ts
import { AgentCoreApplication, type AgentCoreApplicationProps } from "@aws/agentcore-cdk";
import { Stack, type StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

export interface AgentCoreStackProps extends StackProps {
  application: AgentCoreApplicationProps;
}

export class AgentCoreStack extends Stack {
  public readonly application: AgentCoreApplication;

  constructor(scope: Construct, id: string, props: AgentCoreStackProps) {
    super(scope, id, props);
    this.application = new AgentCoreApplication(this, "Application", props.application);

    const orders = new dynamodb.Table(this, "Orders", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
    });
    const agent = this.application.runtime("agent");
    orders.grantReadWriteData(agent);
    agent.addEnvironmentVariable("ORDERS_TABLE", orders.tableName);
  }
}
```

For a Harness, use `this.application.harness("<name>")` instead.

Run `agentcore project deploy` to apply your changes. The names passed to
`runtime()` or `harness()` must match the names in your project.

If you use an existing execution role through `executionRoleArn`, CDK cannot
change its permissions. You'll need to add the required permissions to that role
yourself.

Note that `agentcore project status` reports only the resources `agentcore.json`
declares, not the ones you add in the stack.

## Documentation

- [Amazon Bedrock AgentCore documentation](https://docs.aws.amazon.com/bedrock-agentcore/): service guides and API references.
- [Harness project configuration](docs/harness-project-configuration.md): Harness YAML, prompts, tools, skills, and environment settings.
- [Contributing](CONTRIBUTING.md): development, builds, architecture, and testing.
