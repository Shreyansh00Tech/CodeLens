from flask import abort, request


def require_key(view):
    """Reject requests without an API key."""
    if not request.headers.get("X-Key"):
        abort(401)
    return view
