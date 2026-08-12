import { allow, type GeneratedPolicyStatement } from "./executionRolePolicy";

export class AgentCorePolicyGrants {
  static invokeLambda(functionArn: string): GeneratedPolicyStatement {
    return allow(["lambda:InvokeFunction"], [functionArn]);
  }

  static evaluateWithLambda(functionArn: string): GeneratedPolicyStatement {
    return allow(["lambda:GetFunction", "lambda:InvokeFunction"], [functionArn]);
  }

  static getPolicyEngine(policyEngineArn: string): GeneratedPolicyStatement {
    return allow(["bedrock-agentcore:GetPolicyEngine"], [policyEngineArn]);
  }

  static authorizeGateway(policyEngineArn: string, gatewayArn: string): GeneratedPolicyStatement {
    return allow(
      ["bedrock-agentcore:AuthorizeAction", "bedrock-agentcore:PartiallyAuthorizeActions"],
      [policyEngineArn, gatewayArn],
    );
  }

  static invokeWebSearch(webSearchArns: readonly string[]): GeneratedPolicyStatement {
    return allow(["bedrock-agentcore:InvokeWebSearch"], webSearchArns);
  }

  static invokeGateway(gatewayArn: string): GeneratedPolicyStatement {
    return allow(["bedrock-agentcore:InvokeGateway"], [gatewayArn]);
  }

  static getWorkloadAccessToken(workloadArns: readonly string[]): GeneratedPolicyStatement {
    return allow(["bedrock-agentcore:GetWorkloadAccessToken"], workloadArns);
  }

  static getResourceApiKey(providerArn: string): GeneratedPolicyStatement {
    return allow(["bedrock-agentcore:GetResourceApiKey"], [providerArn]);
  }

  static getResourceOauth2Token(providerArn: string): GeneratedPolicyStatement {
    return allow(["bedrock-agentcore:GetResourceOauth2Token"], [providerArn]);
  }

  static readSecret(secretArn: string): GeneratedPolicyStatement {
    return allow(["secretsmanager:GetSecretValue"], [secretArn]);
  }

  static invokeRuntime(runtimeArns: readonly string[]): GeneratedPolicyStatement {
    return allow(["bedrock-agentcore:InvokeAgentRuntime"], runtimeArns);
  }

  static useMemory(memoryArn: string): GeneratedPolicyStatement {
    return allow(
      [
        "bedrock-agentcore:CreateEvent",
        "bedrock-agentcore:DeleteEvent",
        "bedrock-agentcore:GetEvent",
        "bedrock-agentcore:ListEvents",
        "bedrock-agentcore:RetrieveMemoryRecords",
      ],
      [memoryArn],
    );
  }

  static useBrowser(browserArn: string): GeneratedPolicyStatement {
    return allow(
      [
        "bedrock-agentcore:StartBrowserSession",
        "bedrock-agentcore:StopBrowserSession",
        "bedrock-agentcore:GetBrowserSession",
        "bedrock-agentcore:ListBrowserSessions",
        "bedrock-agentcore:UpdateBrowserStream",
        "bedrock-agentcore:ConnectBrowserAutomationStream",
        "bedrock-agentcore:ConnectBrowserLiveViewStream",
      ],
      [browserArn],
    );
  }

  static useCodeInterpreter(codeInterpreterArn: string): GeneratedPolicyStatement {
    return allow(
      [
        "bedrock-agentcore:StartCodeInterpreterSession",
        "bedrock-agentcore:StopCodeInterpreterSession",
        "bedrock-agentcore:GetCodeInterpreterSession",
        "bedrock-agentcore:ListCodeInterpreterSessions",
        "bedrock-agentcore:InvokeCodeInterpreter",
      ],
      [codeInterpreterArn],
    );
  }

  static readS3Object(objectArn: string): GeneratedPolicyStatement {
    return allow(["s3:GetObject"], [objectArn]);
  }

  static invokeApiGateway(apiArn: string): GeneratedPolicyStatement {
    return allow(["execute-api:Invoke"], [apiArn]);
  }

  static retrieveKnowledgeBase(knowledgeBaseArn: string): GeneratedPolicyStatement {
    return allow(["bedrock:GetKnowledgeBase", "bedrock:Retrieve"], [knowledgeBaseArn]);
  }

  static getKnowledgeBases(knowledgeBaseArns: readonly string[]): GeneratedPolicyStatement {
    return allow(["bedrock:GetKnowledgeBase"], knowledgeBaseArns);
  }

  static retrieveKnowledgeBases(knowledgeBaseArns: readonly string[]): GeneratedPolicyStatement {
    return allow(["bedrock:Retrieve"], knowledgeBaseArns);
  }

  static agenticRetrieveKnowledgeBases(): GeneratedPolicyStatement {
    return allow(["bedrock:AgenticRetrieveStream"], ["*"]);
  }

  static createMantleInference(projectArns: readonly string[]): GeneratedPolicyStatement {
    return allow(["bedrock-mantle:CreateInference"], projectArns);
  }

  static listMantleModels(projectArn: string): GeneratedPolicyStatement {
    return allow(["bedrock-mantle:ListModels"], [projectArn]);
  }

  static callMantleWithBearerToken(): GeneratedPolicyStatement {
    return allow(["bedrock-mantle:CallWithBearerToken"], ["*"]);
  }

  static decryptKmsKey(keyArn: string): GeneratedPolicyStatement {
    return allow(["kms:Decrypt", "kms:DescribeKey"], [keyArn]);
  }

  static invokeModel(modelArns: readonly string[]): GeneratedPolicyStatement {
    return allow(["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], modelArns);
  }

  static queryLogs(logGroupArns: readonly string[]): GeneratedPolicyStatement {
    return allow(
      [
        "logs:DescribeLogStreams",
        "logs:FilterLogEvents",
        "logs:GetLogEvents",
        "logs:GetQueryResults",
        "logs:StartQuery",
      ],
      logGroupArns,
    );
  }
}
