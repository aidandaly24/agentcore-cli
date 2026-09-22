# Payments

[Back to README](../README.md) | [Command reference](../command.md#payment-commands)

For project-managed credential providers and their cleanup behavior, see
[Project Credentials](configuration.md#project-credentials).

## Inspect AgentCore Payments

The `payment` commands call the Payments control and data planes directly, with
no project involved. This command family currently provides read-only inspection
of existing managers, connectors, sessions, instruments, and payment credential
providers. It does not create IAM roles or change provider credentials.

Choose a manager from `manager list` and use its `paymentManagerId` below:

```bash
agentcore payment manager list --json
MANAGER_ID='<paymentManagerId from manager list>'
agentcore payment manager get --id "$MANAGER_ID"
agentcore payment connector list --manager-id "$MANAGER_ID"
```

`--user-id` is the application user ID used when the session or instrument was
created, not an IAM username or AWS profile. Session and instrument reads require
it with IAM authentication; their lists return that user's resources, not every
user's resources under the manager.

```bash
USER_ID='alice' # Use the application user ID associated with the resources.
agentcore payment session list --manager-id "$MANAGER_ID" --user-id "$USER_ID"
agentcore payment instrument list --manager-id "$MANAGER_ID" --user-id "$USER_ID"

# Use paymentInstrumentId and paymentConnectorId from the same instrument list item.
INSTRUMENT_ID='<paymentInstrumentId>'
CONNECTOR_ID='<paymentConnectorId>'
agentcore payment instrument get --manager-id "$MANAGER_ID" \
  --instrument-id "$INSTRUMENT_ID" --user-id "$USER_ID"
agentcore payment instrument balance --manager-id "$MANAGER_ID" \
  --connector-id "$CONNECTOR_ID" --instrument-id "$INSTRUMENT_ID" \
  --user-id "$USER_ID" --chain BASE_SEPOLIA
```

To inspect connector or credential provider metadata:

```bash
agentcore payment connector get --manager-id "$MANAGER_ID" --connector-id "$CONNECTOR_ID"
agentcore identity payment-credential-provider list --json
agentcore identity payment-credential-provider get --name '<provider name>'
```

The optional `--agent-name` on session and instrument reads labels the request for
observability. It does not select an AgentCore agent or filter the results.

`instrument get` returns instrument metadata without querying balances. `balance`
requires an explicit chain and defaults to `--token USDC`; wallet network families
such as ETHEREUM do not identify whether to query mainnet or a testnet. The JSON
response retains the raw atomic amount string and decimals. A service error is
reported as an error, never converted to a zero balance.

Data-plane commands work against managers that use the `AWS_IAM` authorizer.
The CLI resolves `--manager-id` through `GetPaymentManager` in the configured
region, then supplies the returned ARN to the data-plane API. Callers need
`bedrock-agentcore:GetPaymentManager` as well as the relevant data-plane action.
Region resolution follows the other imperative commands: `--region`, environment
variables, the active AWS profile, then the CLI default.
A `CUSTOM_JWT` manager accepts only bearer tokens on its data plane, which
these commands do not send yet; the CLI reports that limitation before calling
the data plane.
