import os
import logging
from google.adk.tools.mcp_tool.mcp_toolset import MCPToolset
from google.adk.tools.mcp_tool.mcp_session_manager import StreamableHTTPConnectionParams

logger = logging.getLogger(__name__)

{{#if hasGateway}}
{{#if (includes gatewayAuthTypes "AWS_IAM")}}
import httpx
from mcp_proxy_for_aws.sigv4_helper import SigV4HTTPXAuth, create_aws_session
{{/if}}
{{#if (includes gatewayAuthTypes "CUSTOM_JWT")}}
{{#unless (includes gatewayAuthTypes "AWS_IAM")}}import httpx
{{/unless}}import time as _time
{{/if}}

{{#each gatewayProviders}}
{{#if (eq authType "CUSTOM_JWT")}}
_token_cache_{{snakeCase name}} = {"token": None, "expires_at": 0}

def _get_bearer_token_{{snakeCase name}}():
    """Obtain OAuth access token via client_credentials grant for {{name}}."""
    cache = _token_cache_{{snakeCase name}}
    if cache["token"] and _time.time() < cache["expires_at"]:
        return cache["token"]
    client_id = os.environ.get("{{credentialEnvVarBase}}_CLIENT_ID")
    client_secret = os.environ.get("{{credentialEnvVarBase}}_CLIENT_SECRET")
    if not client_id or not client_secret:
        logger.warning("Agent OAuth credentials not set — {{name}} CUSTOM_JWT auth unavailable")
        return None
    with httpx.Client() as c:
        disc = c.get("{{discoveryUrl}}")
        token_ep = disc.json()["token_endpoint"]
        resp = c.post(token_ep, data={
            "grant_type": "client_credentials",
            "client_id": client_id,
            "client_secret": client_secret,
            {{#if scopes}}"scope": "{{scopes}}",{{/if}}
        })
        data = resp.json()
        cache["token"] = data["access_token"]
        cache["expires_at"] = _time.time() + data.get("expires_in", 3600) - 60
        return cache["token"]

{{/if}}
{{/each}}

def get_all_gateway_mcp_toolsets() -> list[MCPToolset]:
    """Returns MCP Toolsets for all configured gateways."""
    toolsets = []
    {{#each gatewayProviders}}
    url = os.environ.get("{{envVarName}}")
    if url:
        {{#if (eq authType "AWS_IAM")}}
        session = create_aws_session()
        auth = SigV4HTTPXAuth(session.get_credentials(), "bedrock-agentcore", session.region_name)
        toolsets.append(MCPToolset(connection_params=StreamableHTTPConnectionParams(
            url=url,
            httpx_client_factory=lambda **kwargs: httpx.AsyncClient(auth=auth, **kwargs)
        )))
        {{else if (eq authType "CUSTOM_JWT")}}
        token = _get_bearer_token_{{snakeCase name}}()
        headers = {"Authorization": f"Bearer {token}"} if token else None
        toolsets.append(MCPToolset(connection_params=StreamableHTTPConnectionParams(url=url, headers=headers)))
        {{else}}
        toolsets.append(MCPToolset(connection_params=StreamableHTTPConnectionParams(url=url)))
        {{/if}}
    else:
        logger.warning("{{envVarName}} not set — {{name}} gateway tools unavailable")
    {{/each}}
    return toolsets
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
