import os
import logging
from google.adk.tools.mcp_tool.mcp_toolset import MCPToolset
from google.adk.tools.mcp_tool.mcp_session_manager import StreamableHTTPConnectionParams

logger = logging.getLogger(__name__)

{{#if hasGateway}}
def get_all_gateway_mcp_toolsets() -> list[MCPToolset]:
    """Returns MCP Toolsets for all configured gateways."""
    toolsets = []
    {{#each gatewayProviders}}
    url = os.environ.get("{{envVarName}}")
    if url:
        toolsets.append(MCPToolset(connection_params=StreamableHTTPConnectionParams(url=url)))
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
