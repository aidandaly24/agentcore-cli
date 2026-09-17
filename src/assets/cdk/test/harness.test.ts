import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stringify } from 'yaml';
import { HarnessSpecSchema } from '@aws/agentcore-cdk';

const entrypoint = resolve(__dirname, '..', 'dist/bin/cdk.js');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.each([
  { systemPrompt: '' },
  { systemPrompt: ' \r\n\t' },
])('rejects blank system prompts: %j', (overrides) => {
  expect(HarnessSpecSchema.safeParse({
    name: 'assistant',
    model: { provider: 'bedrock', modelId: 'example' },
    ...overrides,
  }).success).toBe(false);
});

test.each([
  { source: 'inline', prompt: '  Inline instructions: # 100%\n' },
  { source: 'file', prompt: '\uFEFFREADME.md\r\n' },
])('generated app deploys the $source prompt without rewriting YAML', ({ source, prompt }) => {
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
  writeFileSync(join(harnessDir, 'system-prompt.md'), source === 'file' ? prompt : 'Conventional prompt loses.');
  const yaml = '# Customer comment stays intact.\n' + stringify({
    name: 'assistant',
    model: {
      provider: 'bedrock',
      modelId: 'global.anthropic.claude-sonnet-4-6',
    },
    systemPrompt: source === 'file' ? undefined : prompt,
    memory: { mode: 'disabled' },
    truncation: {
      strategy: 'summarization',
      config: { summarization: { summaryRatio: 0.3, preserveRecentMessages: 0, summarizationSystemPrompt: summary } },
    },
  });
  writeFileSync(join(harnessDir, 'harness.yaml'), yaml);
  const outdir = join(root, 'cdk.out');
  execFileSync(process.execPath, [entrypoint], {
    cwd: cdkRoot,
    env: { ...process.env, INIT_CWD: root, CDK_OUTDIR: outdir },
    stdio: 'pipe',
    timeout: 30000,
  });
  expect(readFileSync(join(harnessDir, 'harness.yaml'), 'utf8')).toBe(yaml);
  const templateFile = readdirSync(outdir).find((name) => name.endsWith('.template.json'))!;
  const template = JSON.parse(readFileSync(join(outdir, templateFile), 'utf8'));
  const harness = Object.values(template.Resources).find((resource: any) => resource.Type === 'AWS::BedrockAgentCore::Harness') as any;
  expect(harness.Properties.SystemPrompt).toEqual([{ Text: prompt }]);
  expect(harness.Properties.Memory).toEqual({ Disabled: {} });
  expect(JSON.stringify(harness.Properties)).toContain(JSON.stringify(summary).slice(1, -1));
});
