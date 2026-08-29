/** User-facing note included in CLI remove JSON output. */
export const SOURCE_CODE_NOTE =
  'Your agent app source code has not been modified. Deploy with `agentcore deploy` to apply your removal changes to AWS.';

/** Valid passthrough protocol types (mirrors PassthroughProtocolTypeSchema). */
export const PASSTHROUGH_PROTOCOL_TYPES = ['MCP', 'A2A', 'INFERENCE', 'CUSTOM'] as const;

/** Error shown when `--additional-params` is not parseable as a JSON object (lite_llm harness). */
export const ADDITIONAL_PARAMS_JSON_ERROR = '--additional-params must be a valid JSON object';

/**
 * Starter entrypoint vended into a BYO Python agent's code directory so `agentcore dev`
 * works out of the box. Follows the AgentCore runtime contract (BedrockAgentCoreApp /
 * @app.entrypoint / app.run), not a Lambda-style handler.
 */
export const BYO_PYTHON_ENTRYPOINT_STUB = `from bedrock_agentcore.runtime import BedrockAgentCoreApp

app = BedrockAgentCoreApp()


@app.entrypoint
def invoke(payload, context):
    """Replace this with your agent logic."""
    prompt = payload.get("prompt", "")
    return {"result": f"Echo: {prompt}"}


if __name__ == "__main__":
    app.run()
`;

/**
 * Starter entrypoint vended into a BYO TypeScript agent's code directory. Follows the
 * AgentCore runtime contract via the TypeScript SDK's BedrockAgentCoreApp.
 */
export const BYO_TYPESCRIPT_ENTRYPOINT_STUB = `import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    // Replace this with your agent logic.
    async process(payload: any, context: any) {
      const prompt = payload?.prompt ?? '';
      return { result: \`Echo: \${prompt}\` };
    },
  },
});

app.run({ port: parseInt(process.env.PORT ?? '8080') });
`;
