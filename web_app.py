#!/usr/bin/env python3
"""Local web UI for eve_builder (standard library only).

The EVE-NG password is read from the EVE_PASSWORD environment variable and never
sent to or stored by the browser. The server listens on 127.0.0.1 only.
"""

import argparse
import json
import os
import re
import threading
import time
import urllib.request
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import eve_builder as eb
import topology_import as ti

ROOT = Path(__file__).resolve().parent
INDEX = ROOT / "web" / "index.html"
STATIC = {
    "/app.css": ("app.css", "text/css"),
    "/app.js": ("app.js", "application/javascript"),
    "/fonts/Anuphan-VF.ttf": ("fonts/Anuphan-VF.ttf", "font/ttf"),
}
DEFAULT_TOPOLOGY = ROOT / "topology.json"
MAX_BODY = 1_000_000
EVE_LOCK = threading.Lock()


# One logged-in EVE-NG client, reused across requests. Only touched while EVE_LOCK is held.
_cached = {"key": None, "client": None}


def release_cached_session():
    """Log out the cached session (caller holds EVE_LOCK, or the server is stopping)."""
    client, _cached["client"], _cached["key"] = _cached["client"], None, None
    if client is not None:
        client.release()


def connect(eve, fresh=False):
    password = os.environ.get("EVE_PASSWORD")
    if not password:
        raise eb.EveError("Environment variable EVE_PASSWORD is not set; set it and restart the server")
    host = str(eve.get("host", "")).strip()
    if not host:
        raise eb.EveError("EVE-NG host is required")
    key = (host, bool(eve.get("https")))
    if fresh or _cached["key"] != key:
        release_cached_session()
    if _cached["client"] is None:
        client = eb.EveClient(host, use_https=key[1])
        client.login(eb.EVE_USERNAME, password)  # an expired session later logs in again by itself
        _cached["key"], _cached["client"] = key, client
    return _cached["client"]


@contextmanager
def session(eve, fresh=False):
    """Use the shared logged-in client (caller holds EVE_LOCK); close any lab it opened afterwards."""
    client = connect(eve, fresh)
    try:
        yield client
    finally:
        client.close_lab()


def handle_validate(body):
    return {"problems": eb.validate_topology(body["topology"])}


def handle_build(body):
    topology = body["topology"]
    problems = eb.validate_topology(topology)
    if problems:
        return {"ok": False, "problems": problems}
    lines = []
    with EVE_LOCK, session(body.get("eve", {})) as client:
        lab_path = eb.build_lab(client, topology, recreate=bool(body.get("recreate")),
                                start=bool(body.get("start")), log=lines.append)
    return {"ok": True, "lab": lab_path, "log": lines}


def handle_power(body):
    action = body.get("action")
    with EVE_LOCK, session(body.get("eve", {})) as client:
        eb.set_lab_power(client, body["lab"], action)
    return {"ok": True, "log": [f"{action} sent to all nodes in {body['lab']['name']}"]}


def handle_verify(body):
    problems = eb.validate_topology(body["topology"])
    if problems:
        return {"ok": False, "problems": problems}
    with EVE_LOCK, session(body.get("eve", {})) as client:
        results = eb.verify_lab(client, body["topology"])
    return {"ok": True, "all_ok": all(r[0] for r in results),
            "results": [{"ok": ok, "item": item, "detail": detail} for ok, item, detail in results]}


def handle_sync(body):
    topology = body["topology"]
    problems = eb.validate_topology(topology)
    if problems:
        return {"ok": False, "problems": problems}
    lines = []
    with EVE_LOCK, session(body.get("eve", {})) as client:
        eb.sync_lab(client, topology, log=lines.append)
    return {"ok": True, "log": lines}


LAB_PATH_RE = re.compile(r"/[A-Za-z0-9_\- ./]+\.unl")
FOLDER_PATH_RE = re.compile(r"/[A-Za-z0-9_\- .]+(?:/[A-Za-z0-9_\- .]+)*")
FOLDER_NAME_RE = re.compile(r"[A-Za-z0-9_\- .]+")


def _lab_path(value):
    path = str(value or "")
    if not LAB_PATH_RE.fullmatch(path) or ".." in path:
        raise eb.EveError(f"Invalid lab path: {path!r}")
    return path


def _folder_path(value, allow_root=False):
    path = str(value or "")
    if allow_root and path == "/":
        return path
    if not FOLDER_PATH_RE.fullmatch(path) or ".." in path:
        raise eb.EveError(f"Invalid folder path: {path!r}")
    return path


def handle_labs(body):
    with EVE_LOCK, session(body.get("eve", {})) as client:
        labs, folders = eb.list_tree(client)
    return {"ok": True, "labs": labs, "folders": folders}


def handle_lab_exists(body):
    # Called when the deploy page opens; skip instead of queueing behind a running build/sync
    lab = body.get("lab") or {}
    folder = _folder_path(str(lab.get("path") or "/").rstrip("/") or "/", allow_root=True)
    lab_path = folder.rstrip("/") + "/" + str(lab.get("name", "")) + ".unl"
    if not EVE_LOCK.acquire(blocking=False):
        return {"ok": True, "busy": True}
    try:
        with session(body.get("eve", {})) as client:
            try:
                labs, _ = eb.list_tree(client, folder, depth=0)
            except eb.EveError:
                return {"ok": True, "exists": False, "folder_exists": False, "lab": lab_path}
    finally:
        EVE_LOCK.release()
    return {"ok": True, "exists": lab_path in labs,
            "folder_exists": True, "lab": lab_path}


def handle_lab_delete(body):
    path = _lab_path(body.get("lab_path"))
    with EVE_LOCK, session(body.get("eve", {})) as client:
        eb.delete_lab(client, path)
    return {"ok": True, "message": f"ลบ lab {path} แล้ว"}


def handle_folder_create(body):
    parent = _folder_path(body.get("parent", "/"), allow_root=True)
    name = str(body.get("name", "")).strip()
    if not FOLDER_NAME_RE.fullmatch(name) or ".." in name or name.strip(".") == "":
        raise eb.EveError("ชื่อโฟลเดอร์ใช้ได้เฉพาะตัวอักษรอังกฤษ ตัวเลข ช่องว่าง - _ และ .")
    with EVE_LOCK, session(body.get("eve", {})) as client:
        eb.create_folder(client, parent, name)
    return {"ok": True, "message": f"สร้างโฟลเดอร์ {parent.rstrip('/')}/{name} แล้ว"}


def handle_folder_delete(body):
    path = _folder_path(body.get("path"))
    with EVE_LOCK, session(body.get("eve", {})) as client:
        labs, subfolders = eb.list_tree(client, path)
        # Deleting a folder removes everything inside it, so a non-empty folder needs its name typed back
        if (labs or subfolders) and body.get("confirm_name") != path.rsplit("/", 1)[-1]:
            raise eb.EveError("โฟลเดอร์นี้ไม่ว่าง ต้องพิมพ์ชื่อโฟลเดอร์ยืนยันก่อนลบ")
        removed_labs, removed_folders = eb.delete_folder(client, path)
    return {"ok": True, "message": f"ลบโฟลเดอร์ {path} แล้ว (lab {removed_labs} รายการ, โฟลเดอร์ย่อย {removed_folders})"}


def handle_import(body):
    lab_path = _lab_path(body.get("lab_path"))
    with EVE_LOCK, session(body.get("eve", {})) as client:
        topology, warnings = eb.import_lab(client, lab_path)
    return {"ok": True, "topology": topology, "warnings": warnings}


def handle_parse(body):
    topology, warnings = ti.parse_import(str(body.get("text", "")))
    return {"ok": True, "topology": topology, "warnings": warnings,
            "problems": eb.validate_topology(topology)}


def handle_test(body):
    # fresh=True: really log in again, so "login ผ่าน" reflects the current password and server
    with EVE_LOCK, session(body.get("eve", {}), fresh=True) as client:
        status = client.request("GET", "/api/status")["data"]
        try:
            images = eb.list_images(client)
        except eb.EveError:
            images = []
    return {"ok": True, "images": images,
            "message": f"เชื่อมต่อสำเร็จ: login ผ่าน, EVE-NG เวอร์ชัน {status.get('version', '?')}, พบ IOL image {len(images)} รายการ"}


def handle_stats(body):
    # Polled by the browser; skip instead of queueing behind a running build/sync
    if not EVE_LOCK.acquire(blocking=False):
        return {"ok": True, "busy": True}
    try:
        with session(body.get("eve", {})) as client:
            status = client.request("GET", "/api/status")["data"]
    finally:
        EVE_LOCK.release()
    return {"ok": True, "cpu": status.get("cpu"), "mem": status.get("mem")}


ROUTES = {
    "/api/stats": handle_stats,
    "/api/parse": handle_parse,
    "/api/test": handle_test,
    "/api/sync": handle_sync,
    "/api/labs": handle_labs,
    "/api/lab-exists": handle_lab_exists,
    "/api/lab-delete": handle_lab_delete,
    "/api/folder-create": handle_folder_create,
    "/api/folder-delete": handle_folder_delete,
    "/api/import": handle_import,
    "/api/validate": handle_validate,
    "/api/build": handle_build,
    "/api/power": handle_power,
    "/api/verify": handle_verify,
}


class Server(ThreadingHTTPServer):
    # On Windows SO_REUSEADDR lets two programs listen on the same port, which would hide a stale instance
    allow_reuse_address = os.name != "nt"


class Handler(BaseHTTPRequestHandler):
    server_version = "EveBuilder"

    def log_message(self, fmt, *args):
        pass

    def _send(self, status, payload, content_type="application/json"):
        data = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
        is_font = content_type.startswith("font/")
        self.send_response(status)
        self.send_header("Content-Type", content_type if is_font else content_type + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "max-age=86400" if is_font else "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        # img-src blob: lets the page render the diagram into a PNG for "save as image"
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; "
                         "script-src 'self' 'unsafe-inline'; img-src 'self' blob:")
        self.end_headers()
        self.wfile.write(data)

    def _host_ok(self):
        # Reject DNS-rebinding: only accept requests addressed to the loopback name we serve on
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]")
        return host in ("127.0.0.1", "localhost")

    def _shutdown_when_idle(self):
        with EVE_LOCK:
            release_cached_session()
            self.server.shutdown()

    def do_GET(self):
        if not self._host_ok():
            return self._send(403, {"error": "forbidden host"})
        if self.path == "/api/ping":
            return self._send(200, {"app": "eve-builder"})
        if self.path in ("/", "/index.html"):
            return self._send(200, INDEX.read_bytes(), "text/html")
        if self.path in STATIC:
            name, content_type = STATIC[self.path]
            return self._send(200, (INDEX.parent / name).read_bytes(), content_type)
        if self.path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        if self.path == "/api/import-help":
            return self._send(200, {"prompt": ti.IMPORT_PROMPT, "sample": json.dumps(ti.IMPORT_SAMPLE, indent=2, ensure_ascii=False)})
        if self.path == "/api/config":
            topology = {}
            if DEFAULT_TOPOLOGY.exists():
                topology = json.loads(DEFAULT_TOPOLOGY.read_text(encoding="utf-8"))
            return self._send(200, {"passwordSet": bool(os.environ.get("EVE_PASSWORD")),
                                    "username": eb.EVE_USERNAME,
                                    "topology": topology})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._host_ok():
            return self._send(403, {"error": "forbidden host"})
        origin = self.headers.get("Origin")
        if origin and origin.split("://", 1)[-1].rsplit(":", 1)[0] not in ("127.0.0.1", "localhost"):
            return self._send(403, {"error": "forbidden origin"})
        if not (self.headers.get("Content-Type") or "").startswith("application/json"):
            return self._send(415, {"error": "application/json required"})
        route = ROUTES.get(self.path)
        if self.path == "/api/shutdown":
            self._send(200, {"ok": True})
            # wait for any running EVE operation, then stop accepting requests
            threading.Thread(target=self._shutdown_when_idle, daemon=True).start()
            return
        if route is None:
            return self._send(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                return self._send(413, {"error": "body too large"})
            body = json.loads(self.rfile.read(length) or b"{}")
            self._send(200, route(body))
        except eb.EveError as exc:
            self._send(200, {"ok": False, "error": str(exc)})
        except (ValueError, KeyError, TypeError) as exc:
            self._send(400, {"ok": False, "error": f"Bad request: {exc!r}"})


def _ping(port):
    """True when the program on this port is another EVE Builder instance."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(f"http://127.0.0.1:{port}/api/ping", timeout=2) as resp:
            return json.load(resp).get("app") == "eve-builder"
    except (OSError, ValueError):
        return False


def _ask_old_instance_to_stop(port):
    request = urllib.request.Request(f"http://127.0.0.1:{port}/api/shutdown", data=b"{}", method="POST",
                                     headers={"Content-Type": "application/json"})
    try:
        urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=5).close()
    except OSError:
        pass


def start_server(port):
    """Bind the port, first stopping an older EVE Builder that is still running there."""
    try:
        return Server(("127.0.0.1", port), Handler)
    except OSError as exc:
        if not _ping(port):
            raise SystemExit(f"พอร์ต {port} ถูกใช้อยู่แล้ว ({exc})\n"
                             f"ถ้าเป็น EVE Builder เวอร์ชันเก่า ให้ปิดหน้าต่าง terminal เดิมก่อน หรือใช้พอร์ตอื่น: "
                             f"python web_app.py --port {port + 1}") from None
    print(f"พบ EVE Builder ตัวเก่าที่พอร์ต {port} กำลังปิดให้ ...")
    _ask_old_instance_to_stop(port)
    for attempt in range(600):  # up to 60 s, so a build that is still running can finish
        time.sleep(0.1)
        try:
            return Server(("127.0.0.1", port), Handler)
        except OSError:
            if attempt == 30:
                print("รอให้งานที่ค้างอยู่ในตัวเก่าทำงานเสร็จก่อน ...")
    raise SystemExit(f"ปิดตัวเก่าที่พอร์ต {port} ไม่สำเร็จ ลองปิดหน้าต่าง terminal เดิมเอง")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = start_server(args.port)
    print(f"EVE Builder UI: http://127.0.0.1:{args.port}/  (Ctrl+C to stop)")
    if not os.environ.get("EVE_PASSWORD"):
        print("WARNING: EVE_PASSWORD is not set; build/start/stop will fail until it is.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        # log out of EVE-NG, unless a request is still running (then just exit)
        if EVE_LOCK.acquire(timeout=5):
            try:
                release_cached_session()
            finally:
                EVE_LOCK.release()


if __name__ == "__main__":
    main()
