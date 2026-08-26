import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AgentCoreStack } from '../lib/cdk-stack';

const testConfigDir = join(process.cwd(), 'agentcore');

beforeAll(() => {
  mkdirSync(testConfigDir, { recursive: true });
  writeFileSync(join(testConfigDir, 'agentcore.json'), '{}');
});

afterAll(() => {
  rmSync(testConfigDir, { recursive: true, force: true });
});

test('AgentCoreStack synthesizes with empty spec', () => {
  const app = new cdk.App();
  const stack = new AgentCoreStack(app, 'TestStack', {
    spec: {
      name: 'testproject',
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      configBundles: [],
      policyEngines: [],
      payments: [],
      agentCoreGateways: [],
      mcpRuntimeTools: [],
      unassignedTargets: [],
      datasets: [],
      knowledgeBases: [],
    },
  });
  const template = Template.fromStack(stack);
  template.hasOutput('StackNameOutput', {
    Description: 'Name of the CloudFormation Stack',
  });
});

test('AgentCoreStack synthesizes manual and Quick Create payment connectors', () => {
  const app = new cdk.App();
  const stack = new AgentCoreStack(app, 'TestStack', {
    spec: {
      name: 'testproject',
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      configBundles: [],
      policyEngines: [],
      payments: [],
      agentCoreGateways: [],
      mcpRuntimeTools: [],
      unassignedTargets: [],
      datasets: [],
      knowledgeBases: [],
    },
    paymentSpec: [
      {
        name: 'Payments',
        authorizerType: 'AWS_IAM',
        connectors: [
          {
            name: 'Manual',
            provider: 'CoinbaseCDP',
            credentialName: 'coinbase',
            credentialProviderArn:
              'arn:aws:bedrock-agentcore:us-east-1:123456789012:token-vault/default/paymentcredentialprovider/coinbase',
          },
          {
            name: 'Quick',
            provider: 'CoinbaseCDP',
            provisionMode: 'QUICK_CREATE',
          },
        ],
      },
    ],
  });
  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::BedrockAgentCore::PaymentConnector', 2);
  template.hasResourceProperties('AWS::BedrockAgentCore::PaymentConnector', {
    ConnectorName: 'Manual',
    ProvisionMode: Match.absent(),
  });
  template.hasResourceProperties('AWS::BedrockAgentCore::PaymentConnector', {
    ConnectorName: 'Quick',
    ConnectorType: 'CoinbaseCDP',
    ProvisionMode: 'QUICK_CREATE',
    CredentialProviderConfigurations: [],
  });
  template.hasOutput('PaymentPaymentsQuickAuthorizationUrl', {});
});
