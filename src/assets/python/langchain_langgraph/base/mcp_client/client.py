import os
import logging
from langchain_mcp_adapters.client import MultiServerMCPClient

logger = logging.getLogger(__name__)

{{#if hasGateway}}
{{#if (includes gatewayAuthTypes "AWS_IAM")}}
import boto3
import httpx
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest


class SigV4HTTPXAuth(httpx.Auth):
    """Signs HTTP requests with AWS SigV4 for Lambda function URL authentication."""

    def __init__(self):
        session = boto3.Session()
        credentials = session.get_credentials().get_frozen_credentials()
        region = session.region_name or os.environ.get("AWS_REGION", "us-east-1")
        self.signer = SigV4Auth(credentials, "lambda", region)

    def auth_flow(self, request):
        headers = dict(request.headers)
        headers.pop("connection", None)
        aws_request = AWSRequest(
            method=request.method,
            url=str(request.url),
            data=request.content,
            headers=headers,
        )
        self.signer.add_auth(aws_request)
        request.headers.update(dict(aws_request.headers))
        yield request
{{/if}}


def get_all_gateway_mcp_client() -> MultiServerMCPClient | None:
    """Returns an MCP Client connected to all configured gateways."""
    servers = {}
    {{#each gatewayProviders}}
    url = os.environ.get("{{envVarName}}")
    if url:
        {{#if (eq authType "AWS_IAM")}}
        servers["{{name}}"] = {"transport": "streamable_http", "url": url, "http_client": httpx.AsyncClient(auth=SigV4HTTPXAuth())}
        {{else}}
        servers["{{name}}"] = {"transport": "streamable_http", "url": url}
        {{/if}}
    else:
        logger.warning("{{envVarName}} not set — {{name}} gateway tools unavailable")
    {{/each}}
    if not servers:
        return None
    return MultiServerMCPClient(servers)
{{else}}
# ExaAI provides information about code through web searches, crawling and code context searches through their platform. Requires no authentication
EXAMPLE_MCP_ENDPOINT = "https://mcp.exa.ai/mcp"


def get_streamable_http_mcp_client() -> MultiServerMCPClient:
    """Returns an MCP Client compatible with LangChain/LangGraph."""
    # to use an MCP server that supports bearer authentication, add headers={"Authorization": f"Bearer {access_token}"}
    return MultiServerMCPClient(
        {
            "agentcore_gateway": {
                "transport": "streamable_http",
                "url": EXAMPLE_MCP_ENDPOINT,
            }
        }
    )
{{/if}}
