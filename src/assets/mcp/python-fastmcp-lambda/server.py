from fastapi import FastAPI
from handler import mcp

app = FastAPI(lifespan=lambda app: mcp.session_manager.run())
app.mount("/", mcp.streamable_http_app())
