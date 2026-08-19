#!/usr/bin/env python3
"""
Serves this folder locally while aliasing /callback/ to the site root, so the
app can be reached at exactly http://127.0.0.1:<port>/callback/ — matching a
callback URL an existing APS app may already have registered (e.g. one used
by a Traditional Web App type app you want to reuse), without needing to add
a new callback URL to that app's configuration.

Usage: python serve-legacy-callback.py [port]   (default port 8765)
"""
import http.server
import sys

ALIAS_PREFIX = "/callback"


class CallbackAliasHandler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        if path == ALIAS_PREFIX:
            path = "/"
        elif path.startswith(ALIAS_PREFIX + "/"):
            path = path[len(ALIAS_PREFIX):]
        return super().translate_path(path)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    server = http.server.HTTPServer(("127.0.0.1", port), CallbackAliasHandler)
    print(f"Serving this folder at http://127.0.0.1:{port}/callback/")
    server.serve_forever()
