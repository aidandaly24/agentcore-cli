import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stringify } from 'yaml';
import { HarnessSpecSchema } from '../lib/harness-schema';

const entrypoint = resolve(__dirname, '..', 'dist/bin/cdk.js');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.each([
  { provider: 'bedrock', modelId: 'example', apiFormat: 'converse_stream', temperature: 0, topP: 0, maxTokens: 512 },
  { provider: 'open_ai', modelId: 'example', apiKeyArn: 'arn:key', apiFormat: 'responses' },
  { provider: 'gemini', modelId: 'example', apiKeyArn: 'arn:key', topK: 40 },
  { provider: 'lite_llm', modelId: 'example', apiBase: 'https://example.com', additionalParams: { maxToken: 512, model: { maxIteration: 3 } } },
])('preserves provider fields and free-form maps: %j', (model) => {
  const map = { maxToken: '512', maxIteration: '3', model: 'custom' };
  const input = {
    name: 'assistant',
    model,
    maxIterations: 3,
    maxTokens: 1024,
    timeoutSeconds: 60,
    tags: map,
    environmentVariables: map,
    tools: [
      { type: 'remote_mcp', name: 'mcp', config: { remoteMcp: { url: 'https://example.com', headers: map } } },
      { type: 'inline_function', name: 'fn', config: { inlineFunction: { description: 'Custom schema', inputSchema: { maxToken: 512, properties: { maxIteration: { type: 'number' } } } } } },
      { type: 'agentcore_gateway', name: 'gateway', config: { agentCoreGateway: { gatewayArn: 'arn:gateway', maxIteration: 3 } } },
    ],
  };
  expect(HarnessSpecSchema.parse(input)).toEqual({ ...input, skills: [] });
});

test.each([
  { model: { provider: 'bedrock', modelId: 'example', topK: 40 } },
  { model: { provider: 'open_ai', modelId: 'example' } },
  { model: { provider: 'open_ai', modelId: 'example', apiKeyArn: 'arn:key', apiFormat: 'converse_stream' } },
  { model: { provider: 'gemini', modelId: 'example', apiKeyArn: 'arn:key', apiBase: 'https://example.com' } },
  { model: { provider: 'bedrock', modelId: 'example', additionalParams: { maxToken: 512 } } },
  { networkMode: 'VPC' },
  { authorizerType: 'CUSTOM_JWT' },
  { containerUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/repo:tag', dockerfile: 'Dockerfile' },
  { tools: [{ type: 'agentcore_browser', name: 'same' }, { type: 'agentcore_browser', name: 'same' }] },
  { systemPrompt: '' },
  { systemPrompt: ' \r\n\t' },
])('retains published refinements for %j', (overrides) => {
  expect(HarnessSpecSchema.safeParse({
    name: 'assistant',
    model: { provider: 'bedrock', modelId: 'example' },
    ...overrides,
  }).success).toBe(false);
});

test.each([
  ...['literal', 'file', 'fallback', 'maxIteration', 'model.maxToken'].map(source => ({
    source, prompt: '  Selected prompt: # 100%\n',
  })),
  ...['README.md\n', './instructions.md', 'https://example.com/prompt.md\n', 'file://./not-a-recursive-include.md'].map(prompt => ({
    source: 'file', prompt,
  })),
  { source: 'literal', prompt: './instructions.md' },
  { source: 'fallback', prompt: 'README.md\n' },
])('generated app validates $source prompt $prompt without rewriting it', ({ source, prompt }) => {
  const root = mkdtempSync(join(tmpdir(), 'harness-yaml-synth-'));
  roots.push(root);
  const configRoot = join(root, 'agentcore');
  const cdkRoot = join(configRoot, 'cdk');
  const harnessDir = join(root, 'app', 'assistant');
  mkdirSync(cdkRoot, { recursive: true });
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(join(configRoot, 'agentcore.json'), JSON.stringify({
    name: 'YamlProject',
    version: 1,
    managedBy: 'CDK',
    harnesses: [{ name: 'assistant', path: 'app/assistant' }],
  }));
  writeFileSync(join(configRoot, 'aws-targets.json'), '[]');
  const summary = 'Keep decisions and open questions.\n';
  writeFileSync(join(harnessDir, 'chosen #100%.md'), prompt);
  writeFileSync(join(harnessDir, 'system-prompt.md'), source === 'fallback' ? prompt : 'Conventional prompt loses.');
  writeFileSync(join(harnessDir, 'summary.md'), summary);
  const yaml = '# Customer comment stays intact.\n' + stringify({
    name: 'assistant',
    model: {
      provider: 'bedrock',
      modelId: 'global.anthropic.claude-sonnet-4-6',
      ...(source === 'model.maxToken' ? { maxToken: 512 } : {}),
    },
    ...(source === 'maxIteration' ? { maxIteration: 3 } : {}),
    systemPrompt: source === 'fallback' ? undefined : source === 'literal' ? prompt : 'file://./chosen #100%.md',
    memory: { mode: 'disabled' },
    truncation: {
      strategy: 'summarization',
      config: { summarization: { summaryRatio: 0.3, preserveRecentMessages: 0, summarizationSystemPrompt: 'file://./summary.md' } },
    },
  });
  writeFileSync(join(harnessDir, 'harness.yaml'), yaml);
  const outdir = join(root, 'cdk.out');
  const result = spawnSync(process.execPath, [entrypoint], {
    cwd: cdkRoot,
    env: { ...process.env, INIT_CWD: root, CDK_OUTDIR: outdir },
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: 30000,
  });
  expect(result.error).toBeUndefined();
  expect(readFileSync(join(harnessDir, 'harness.yaml'), 'utf8')).toBe(yaml);
  if (source === 'maxIteration' || source === 'model.maxToken') {
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(join(harnessDir, 'harness.yaml'));
    for (const key of source.split('.')) expect(result.stderr).toContain(key);
    return;
  }
  expect(result.status).toBe(0);
  const templateFile = readdirSync(outdir).find((name) => name.endsWith('.template.json'))!;
  const template = JSON.parse(readFileSync(join(outdir, templateFile), 'utf8'));
  const harness = Object.values(template.Resources).find((resource: any) => resource.Type === 'AWS::BedrockAgentCore::Harness') as any;
  expect(harness.Properties.SystemPrompt).toEqual([{ Text: prompt }]);
  expect(harness.Properties.Memory).toEqual({ Disabled: {} });
  expect(JSON.stringify(harness.Properties)).toContain(JSON.stringify(summary).slice(1, -1));
  expect(JSON.stringify(harness.Properties)).not.toContain('file://./chosen #100%.md');
  expect(JSON.stringify(harness.Properties)).not.toContain('file://./summary.md');
  expect(readFileSync(join(harnessDir, 'chosen #100%.md'), 'utf8')).toBe(prompt);
  expect(readFileSync(join(harnessDir, 'harness.yaml'), 'utf8')).toBe(yaml);
});
