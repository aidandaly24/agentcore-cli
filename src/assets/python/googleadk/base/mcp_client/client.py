import os
import logging
from google.adk.tools.mcp_tool.mcp_toolset import MCPToolset
from google.adk.tools.mcp_tool.mcp_session_manager import StreamableHTTPConnectionParams

logger = logging.getLogger(__name__)

{{#if hasGateway}}
{{#if (eq gatewayProviders.[0].authType "AWS_IAM")}}
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


def get_streamable_http_mcp_client() -> MCPToolset | None:
    """Returns an MCP Toolset connected to the {{gatewayProviders.[0].name}} gateway."""
    url = os.environ.get("{{gatewayProviders.[0].envVarName}}")
    if not url:
        logger.warning("{{gatewayProviders.[0].envVarName}} not set — gateway tools unavailable")
        return None

    return MCPToolset(
        connection_params=StreamableHTTPConnectionParams(url=url)
    )
{{else}}
# ExaAI provides information about code through web searches, crawling and code context searches through their platform. Requires no authentication
EXAMPLE_MCP_ENDPOINT = "https://mcp.exa.ai/mcp"


def get_streamable_http_mcp_client() -> MCPToolset:
    """Returns an MCP Toolset compatible with Google ADK."""
    # to use an MCP server that supports bearer authentication, add headers={"Authorization": f"Bearer {access_token}"}
    return MCPToolset(
        connection_params=StreamableHTTPConnectionParams(url=EXAMPLE_MCP_ENDPOINT)
    )
{{/if}}
