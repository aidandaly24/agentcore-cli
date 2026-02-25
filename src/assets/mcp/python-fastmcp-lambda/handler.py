"""
FastMCP Server for AWS Lambda with Function URL.

This template shows:
- FastMCP server running on Lambda via Lambda Web Adapter + uvicorn
- HTTP tool patterns with proper error handling
- Retry logic and response validation

Deploy with: agentcore deploy
"""

import logging
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP

logging.basicConfig(level=logging.INFO, format="%(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

mcp = FastMCP("{{ Name }}", stateless_http=True, host="0.0.0.0")

HTTP_TIMEOUT = 10.0
MAX_RETRIES = 2


async def fetch_json(url: str, headers: dict[str, str] | None = None) -> dict[str, Any] | None:
    """Make an HTTP GET request with retry logic."""
    async with httpx.AsyncClient() as client:
        for attempt in range(MAX_RETRIES):
            try:
                response = await client.get(url, headers=headers, timeout=HTTP_TIMEOUT)
                response.raise_for_status()
                return response.json()
            except httpx.TimeoutException:
                logger.warning(f"Timeout on attempt {attempt + 1} for {url}")
            except httpx.HTTPStatusError as e:
                logger.error(f"HTTP {e.response.status_code} for {url}")
                return None
            except httpx.RequestError as e:
                logger.error(f"Request failed: {e}")
                return None
    return None


@mcp.tool()
async def lookup_ip(ip_address: str) -> str:
    """Look up geolocation and network info for an IP address.

    Args:
        ip_address: IPv4 or IPv6 address to look up
    """
    data = await fetch_json(f"http://ip-api.com/json/{ip_address}")

    if not data:
        return f"Failed to look up IP: {ip_address}"

    if data.get("status") == "fail":
        return f"Lookup failed: {data.get('message', 'unknown error')}"

    return (
        f"IP: {data['query']}\n"
        f"Location: {data['city']}, {data['regionName']}, {data['country']}\n"
        f"ISP: {data['isp']}\n"
        f"Organization: {data['org']}\n"
        f"Timezone: {data['timezone']}"
    )


@mcp.tool()
async def get_random_user() -> str:
    """Generate a random user profile for testing or mock data."""
    data = await fetch_json("https://randomuser.me/api/")

    if not data or "results" not in data:
        return "Failed to generate random user."

    user = data["results"][0]
    name = user["name"]
    location = user["location"]

    return (
        f"Name: {name['first']} {name['last']}\n"
        f"Email: {user['email']}\n"
        f"Location: {location['city']}, {location['country']}\n"
        f"Phone: {user['phone']}"
    )


@mcp.tool()
async def fetch_post(post_id: int) -> str:
    """Fetch a post by ID from JSONPlaceholder API.

    Args:
        post_id: The post ID (1-100)
    """
    if not 1 <= post_id <= 100:
        return "Post ID must be between 1 and 100."

    data = await fetch_json(f"https://jsonplaceholder.typicode.com/posts/{post_id}")

    if not data:
        return f"Failed to fetch post {post_id}."

    return (
        f"Post #{data['id']}\n"
        f"Title: {data['title']}\n\n"
        f"{data['body']}"
    )
