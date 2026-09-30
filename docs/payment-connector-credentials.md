# Payment connector credential rotation

[Back to README](../README.md)

`agentcore payment connector rotate-credentials` replaces service-managed credentials
for a READY Coinbase CDP connector provisioned through Quick Create (`QUICK_CREATE`).
It uses the caller's control-plane IAM permissions and does not require an application user ID.
For `MANUAL` connectors, rotate credentials with the payment provider directly, then update
the payment credential provider.

## Select Credentials

`--secrets` accepts credential kinds, not secret values:

- `API_KEY`: rotate for routine maintenance or suspected compromise.
- `WALLET_SECRET`: rotate only if lost or compromised. Coinbase CDP allows one wallet secret per
  project, so replacement happens in place and signing can be briefly interrupted.

```bash
agentcore payment connector rotate-credentials \
  --manager-id "$MANAGER_ID" --connector-id "$CONNECTOR_ID" \
  --secrets API_KEY
```

Select both with `--secrets API_KEY WALLET_SECRET` when needed. An optional `--client-token`
identifies retries of the same request.

## Behavior And Scope

The [AWS SDK reference](https://docs.aws.amazon.com/boto3/latest/reference/services/bedrock-agentcore-control/client/rotate_payment_connector_credentials.html)
specifies that rotation finishes before the response is returned, with only one rotation at a time
for a given connector. On success, the new credential is in effect and the connector remains
`READY`. On failure, the API returns an error and leaves the connector and its existing credential
unchanged.

Rotation changes the credential on the connector's credential provider, so **every connector
using that provider is affected**. Replace any copies of the previous credential used outside
AgentCore.
