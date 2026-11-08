#!/usr/bin/env python3
"""Serve the deck viewer with caching switched off.

`python3 -m http.server` sends no Cache-Control and no ETag, so the browser is
free to hold index.html in its memory cache forever. Vite writes a NEW hashed
bundle name on every build, so a stale index.html keeps requesting a filename
that no longer exists: the iframe 404s, the deck never mounts, and the page
keeps showing whatever it rendered last. That reads exactly like "my fix got
reverted" -- it cost a round trip on 2026-07-26, twice, with the verdict line
quoting measurements from a deleted bundle.

Usage (from the repo root):
    python3 src/main/phone-remote/react/deck-viewer/serve.py
    -> http://127.0.0.1:8899/deck-viewer/viewer.html
"""

import functools
import http.server
import os
import socketserver

PORT = 8899
# Serve the react/ dir so ../dist/ resolves from deck-viewer/.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    # Quieter: one line per request is noise when ten iframes boot at once.
    def log_message(self, fmt, *args):
        if '404' in (fmt % args):
            super().log_message(fmt, *args)


if __name__ == '__main__':
    socketserver.TCPServer.allow_reuse_address = True
    handler = functools.partial(NoCacheHandler, directory=ROOT)
    with socketserver.TCPServer(('127.0.0.1', PORT), handler) as httpd:
        print(f'deck viewer  ->  http://127.0.0.1:{PORT}/deck-viewer/viewer.html')
        print('no-store: every reload gets the current bundle. 404s logged below.')
        httpd.serve_forever()
