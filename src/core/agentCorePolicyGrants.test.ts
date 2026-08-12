import { describe, expect, test } from "bun:test";
import { AgentCorePolicyGrants } from "./agentCorePolicyGrants";

describe("AgentCorePolicyGrants", () => {
  test("maps reusable AgentCore capabilities to structured Allow statements", () => {
    expect(AgentCorePolicyGrants.invokeLambda("lambda")).toEqual({
      effect: "Allow",
      actions: ["lambda:InvokeFunction"],
      resources: ["lambda"],
    });
    expect(AgentCorePolicyGrants.evaluateWithLambda("lambda")).toEqual({
      effect: "Allow",
      actions: ["lambda:GetFunction", "lambda:InvokeFunction"],
      resources: ["lambda"],
    });
    expect(AgentCorePolicyGrants.getPolicyEngine("engine")).toEqual({
      effect: "Allow",
      actions: ["bedrock-agentcore:GetPolicyEngine"],
      resources: ["engine"],
    });
    expect(AgentCorePolicyGrants.authorizeGateway("engine", "gateway")).toEqual({
      effect: "Allow",
      actions: ["bedrock-agentcore:AuthorizeAction", "bedrock-agentcore:PartiallyAuthorizeActions"],
      resources: ["engine", "gateway"],
    });
    expect(
      AgentCorePolicyGrants.invokeWebSearch(["global-web-search", "regional-web-search"]),
    ).toEqual({
      effect: "Allow",
      actions: ["bedrock-agentcore:InvokeWebSearch"],
      resources: ["global-web-search", "regional-web-search"],
    });
    expect(AgentCorePolicyGrants.invokeGateway("gateway")).toEqual({
      effect: "Allow",
      actions: ["bedrock-agentcore:InvokeGateway"],
      resources: ["gateway"],
    });
    expect(AgentCorePolicyGrants.invokeRuntime(["runtime", "endpoint"])).toEqual({
      effect: "Allow",
      actions: ["bedrock-agentcore:InvokeAgentRuntime"],
      resources: ["runtime", "endpoint"],
    });
    expect(AgentCorePolicyGrants.useMemory("memory")).toEqual({
      effect: "Allow",
      actions: [
        "bedrock-agentcore:CreateEvent",
        "bedrock-agentcore:DeleteEvent",
        "bedrock-agentcore:GetEvent",
        "bedrock-agentcore:ListEvents",
        "bedrock-agentcore:RetrieveMemoryRecords",
      ],
      resources: ["memory"],
    });
    expect(AgentCorePolicyGrants.useBrowser("browser")).toEqual({
      effect: "Allow",
      actions: [
        "bedrock-agentcore:StartBrowserSession",
        "bedrock-agentcore:StopBrowserSession",
        "bedrock-agentcore:GetBrowserSession",
        "bedrock-agentcore:ListBrowserSessions",
        "bedrock-agentcore:UpdateBrowserStream",
        "bedrock-agentcore:ConnectBrowserAutomationStream",
        "bedrock-agentcore:ConnectBrowserLiveViewStream",
      ],
      resources: ["browser"],
    });
    expect(AgentCorePolicyGrants.useCodeInterpreter("code-interpreter")).toEqual({
      effect: "Allow",
      actions: [
        "bedrock-agentcore:StartCodeInterpreterSession",
        "bedrock-agentcore:StopCodeInterpreterSession",
        "bedrock-agentcore:GetCodeInterpreterSession",
        "bedrock-agentcore:ListCodeInterpreterSessions",
        "bedrock-agentcore:InvokeCodeInterpreter",
      ],
      resources: ["code-interpreter"],
    });
    expect(AgentCorePolicyGrants.readS3Object("object")).toEqual({
      effect: "Allow",
      actions: ["s3:GetObject"],
      resources: ["object"],
    });
    expect(AgentCorePolicyGrants.invokeApiGateway("api")).toEqual({
      effect: "Allow",
      actions: ["execute-api:Invoke"],
      resources: ["api"],
    });
    expect(AgentCorePolicyGrants.retrieveKnowledgeBase("knowledge-base")).toEqual({
      effect: "Allow",
      actions: ["bedrock:GetKnowledgeBase", "bedrock:Retrieve"],
      resources: ["knowledge-base"],
    });
    expect(AgentCorePolicyGrants.decryptKmsKey("key")).toEqual({
      effect: "Allow",
      actions: ["kms:Decrypt", "kms:DescribeKey"],
      resources: ["key"],
    });
    expect(AgentCorePolicyGrants.invokeModel(["model", "profile"])).toEqual({
      effect: "Allow",
      actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      resources: ["model", "profile"],
    });
    expect(AgentCorePolicyGrants.queryLogs(["logs"])).toEqual({
      effect: "Allow",
      actions: [
        "logs:DescribeLogStreams",
        "logs:FilterLogEvents",
        "logs:GetLogEvents",
        "logs:GetQueryResults",
        "logs:StartQuery",
      ],
      resources: ["logs"],
    });
  });
});
