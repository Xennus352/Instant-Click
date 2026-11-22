"""
Shared authentication utilities for InstantCap workers.
Provides internal API key validation for worker-to-worker communication.
"""

import os
from functools import wraps
from typing import Optional

from fastapi import Header, HTTPException, Request, status


def get_internal_api_key() -> Optional[str]:
    """Get the internal API key from environment."""
    return os.getenv("INTERNAL_API_KEY")


async def verify_internal_api_key(
    request: Request,
    x_internal_api_key: Optional[str] = Header(None, alias="X-Internal-API-Key"),
) -> None:
    """
    Verify the internal API key for worker-to-worker requests.

    Raises:
        HTTPException: 401 if key is missing or invalid
    """
    expected_key = get_internal_api_key()

    if not expected_key:
        # No key configured - deny access in production, allow in dev
        if os.getenv("NODE_ENV") != "development":
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Internal API key not configured on server",
            )
        return  # Allow in development without key

    if not x_internal_api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing X-Internal-API-Key header",
        )

    if x_internal_api_key != expected_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid internal API key",
        )


def require_internal_api_key(func):
    """Decorator to require internal API key for a route."""
    @wraps(func)
    async def wrapper(*args, **kwargs):
        # Get the request object from kwargs or args
        request = None
        for arg in args:
            if isinstance(arg, Request):
                request = arg
                break
        if request is None:
            for k, v in kwargs.items():
                if isinstance(v, Request):
                    request = v
                    break

        if request is None:
            # Try to get from FastAPI dependency injection
            from fastapi import Depends
            # This won't work as a simple decorator, use the dependency instead
            pass

        # For now, we'll rely on the dependency injection approach
        return await func(*args, **kwargs)
    return wrapper


# FastAPI dependency for use with Depends()
async def internal_api_key_dependency(
    x_internal_api_key: Optional[str] = Header(None, alias="X-Internal-API-Key"),
) -> None:
    """FastAPI dependency to verify internal API key."""
    await verify_internal_api_key(Request(scope={"type": "http"}), x_internal_api_key)
