import http.client
import threading

import pytest

import serve


@pytest.fixture()
def server(tmp_path):
    (tmp_path / "blob.bin").write_bytes(bytes(range(256)) * 4)
    (tmp_path / "x.json").write_text("{}")
    srv = serve.make_server(0, "127.0.0.1", str(tmp_path))  # port 0: OS picks a free port
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield srv.server_address[1]
    srv.shutdown()


def get(port, path, headers=None):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    c.request("GET", path, headers=headers or {})
    r = c.getresponse()
    return r.status, dict(r.getheaders()), r.read()


def test_range_returns_exact_bytes(server):
    st, h, body = get(server, "/blob.bin", {"Range": "bytes=10-19"})
    assert st == 206 and body == bytes(range(10, 20))
    assert h["Content-Range"] == "bytes 10-19/1024" and h["Content-Length"] == "10"


def test_open_ended_and_out_of_range(server):
    st, _, body = get(server, "/blob.bin", {"Range": "bytes=1020-"})
    assert st == 206 and len(body) == 4
    assert get(server, "/blob.bin", {"Range": "bytes=5000-"})[0] == 416


def test_plain_get_and_json_no_store(server):
    st, h, body = get(server, "/blob.bin")
    assert st == 200 and len(body) == 1024 and h["Accept-Ranges"] == "bytes"
    assert get(server, "/x.json")[1]["Cache-Control"] == "no-store"
