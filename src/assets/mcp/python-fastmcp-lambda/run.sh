#!/bin/bash
exec python -m uvicorn --port=$PORT server:app
