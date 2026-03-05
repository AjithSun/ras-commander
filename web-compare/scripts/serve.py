"""Simple HTTP server for data/ directory with CORS headers."""

import http.server
import os
from pathlib import Path

PORT = 8081
DATA_DIR = Path(__file__).resolve().parent.parent / "data"


class CORSHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DATA_DIR), **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    print(f"Serving {DATA_DIR} on http://localhost:{PORT}")
    server = http.server.HTTPServer(("", PORT), CORSHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
