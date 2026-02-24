import os
import logging
from typing import List
from autogen_ext.tools.mcp import (
    StreamableHttpMcpToolAdapter,
    StreamableHttpServerParams,
    mcp_server_tools,
)

logger = logging.getLogger(__name__)

{{#if hasGateway}}
async def get_all_gateway_mcp_tools() -> List[StreamableHttpMcpToolAdapter]:
    """Returns MCP Tools from all configured gateways."""
    tools = []
    {{#each gatewayProviders}}
    url = os.environ.get("{{envVarName}}")
    if url:
        server_params = StreamableHttpServerParams(url=url)
        tools.extend(await mcp_server_tools(server_params))
    else:
        logger.warning("{{envVarName}} not set — {{name}} gateway tools unavailable")
    {{/each}}
    return tools
{{else}}
# ExaAI provides information about code through web searches, crawling and code context searches through their platform. Requires no authentication
EXAMPLE_MCP_ENDPOINT = "https://mcp.exa.ai/mcp"


async def get_streamable_http_mcp_tools() -> List[StreamableHttpMcpToolAdapter]:
    """Returns MCP Tools compatible with AutoGen."""
    # to use an MCP server that supports bearer authentication, add headers={"Authorization": f"Bearer {access_token}"}
    server_params = StreamableHttpServerParams(url=EXAMPLE_MCP_ENDPOINT)
    return await mcp_server_tools(server_params)
{{/if}}
