# Updating Generated Python Projects

Updating the CLI does not rewrite an existing project's dependency constraints, lockfile, or
Dockerfile. Update affected entries in the Runtime's `pyproject.toml` dependency list, keeping its
other dependencies and package extras:

```toml
dependencies = [
    "mcp >= 1.28.1, < 2.0.0",
    "bedrock-agentcore >= 1.18.1, < 2.0.0",
]
```

Run this from the Runtime's code directory to refresh the locked versions:

```bash
uv lock --upgrade
```

The Strands container template installs available Debian package updates, uses
`uv sync --frozen --no-dev`, disables uv caching, and removes the globally installed uv after the
final dependency installation. Its entrypoint runs Python directly.

For an older generated Dockerfile, apply the equivalent changes before `USER bedrock_agentcore`.
Set `UV_NO_CACHE=1` before both sync steps. Remove uv only after the final sync, and keep it if your
custom application invokes it at runtime. The Bedrock Managed Agents template uses uv at startup
and is not covered by this cleanup.

Rebuild and redeploy the changed image, test the application, and inspect its package versions and
scan findings. Docker can reuse cached base images and OS-update layers on later builds; when
building manually, use `docker build --pull --no-cache` to refresh them. An unchanged deployment
does not establish that packages were updated.
