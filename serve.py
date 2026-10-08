"""Dev server for web/: static files with HTTP Range support (needed for point
forecasts) and no-cache JSON. Production should be nginx/Apache, which do both.

    python serve.py [port] [--bind ADDRESS]    (binds to 127.0.0.1 unless told otherwise)
"""
import argparse
import os
import re
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript", ".mjs": "text/javascript",
                      ".pack": "application/octet-stream", ".u16": "application/octet-stream"}
    _remaining = None

    def log_message(self, *a):
        if os.environ.get("QUIET") != "1":
            super().log_message(*a)

    def send_head(self):
        rng = self.headers.get("Range")
        path = self.translate_path(self.path)
        if not rng or not os.path.isfile(path):
            return super().send_head()
        m = re.fullmatch(r"bytes=(\d+)-(\d*)", rng.strip())
        size = os.path.getsize(path)
        if not m or int(m[1]) >= size:
            self.send_error(416)
            return None
        start, end = int(m[1]), min(int(m[2] or size - 1), size - 1)
        f = open(path, "rb")
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        self._remaining = end - start + 1
        return f

    def copyfile(self, src, dst):
        n = self._remaining
        if n is None:
            return super().copyfile(src, dst)
        while n > 0:
            chunk = src.read(min(65536, n))
            if not chunk:
                break
            dst.write(chunk)
            n -= len(chunk)
        self._remaining = None

    def end_headers(self):
        # Dev server: never let the browser reuse stale code or data.
        if self.path.split("?")[0].endswith((".json", ".js", ".css", ".html", "/")):
            self.send_header("Cache-Control", "no-store")
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()


def make_server(port: int = 8000, bind: str = "127.0.0.1", root: str | None = None) -> ThreadingHTTPServer:
    root = root or os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
    return ThreadingHTTPServer((bind, port), partial(Handler, directory=root))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("port", nargs="?", type=int, default=8000)
    ap.add_argument("--bind", default="127.0.0.1")
    a = ap.parse_args()
    print(f"serving web/ on http://{a.bind}:{a.port}")
    make_server(a.port, a.bind).serve_forever()
