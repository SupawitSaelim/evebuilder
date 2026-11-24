#!/usr/bin/env python3
"""Build an EVE-NG Community lab (Cisco IOL) from topology.json using only the standard library."""

import argparse
import base64
import getpass
import html
import http.client
import json
import os
import re
import ssl
import sys
import time
import urllib.parse
from collections import Counter
from pathlib import Path

IFACE_RE = re.compile(r"^(e|et|eth|ethernet)(\d+)/(\d+)$", re.IGNORECASE)
VPCS_RE = re.compile(r"^eth(\d+)$", re.IGNORECASE)

# Startup configs: EVE-NG (tested on 6.2) loads one on first boot for VPCS and for these IOL images only;
# the older i86bi-linux-* images boot into the initial configuration dialog instead.
STARTUP_CONFIG_IOL_PREFIXES = ("x86_64_crb_linux",)
# Lines that only make sense when typing into a console; a startup-config must not contain them
CONSOLE_ONLY_RE = re.compile(
    r"^(en|enable|conf|conf t|configure|configure terminal|end|wr|write|write mem|write memory|"
    r"copy run start|copy running-config startup-config|save)$", re.IGNORECASE)
MAX_STARTUP_CONFIG = 20000


def load_dotenv(path=None):
    """Load KEY=VALUE lines from .env next to this script; real environment variables win."""
    env_file = Path(path) if path else Path(__file__).resolve().parent / ".env"
    if not env_file.is_file():
        return
    for raw in env_file.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)


load_dotenv()


class EveError(Exception):
    pass


# The only EVE-NG account this tool logs in with. EVE-NG Community allows just two usable users
# (pod 0 = admin for the EVE web GUI, pod 1 = this one), so the tool keeps its own account and
# never kicks the GUI session. To change it, edit this line (and EVE_PASSWORD in .env).
EVE_USERNAME = "evebuilder"


LOGIN_ENDPOINT = "/api/auth/login"
# EVE-NG answers 412 (or 401) when the session cookie is missing/expired; the call itself was not executed
AUTH_FAILED = (401, 412)
# A dropped keep-alive connection; the server closed it before reading the request, so resending is safe
STALE_CONNECTION_ERRORS = (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)


class EveClient:
    # Apache closes idle keep-alive connections after KeepAliveTimeout (default 5 s); reconnect before that
    IDLE_RECONNECT = 4.0

    def __init__(self, host, use_https=False, verify_tls=False, timeout=30):
        self.host = host
        self.use_https = use_https
        self.base_url = f"{'https' if use_https else 'http'}://{host}"
        self.timeout = timeout
        self._ctx = None
        if use_https:
            ctx = ssl.create_default_context()
            if not verify_tls:
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
            self._ctx = ctx
        # One persistent connection (keep-alive) instead of a new TCP/TLS handshake per call.
        # http.client never uses HTTP_PROXY/HTTPS_PROXY, which is what we want: EVE-NG is internal.
        self._conn = None
        self._last_used = 0.0
        self._cookies = {}
        self._credentials = None
        self.lab_opened = False

    def _connection(self):
        """Return (connection, reused)."""
        if self._conn is not None and time.monotonic() - self._last_used > self.IDLE_RECONNECT:
            self.close()
        if self._conn is not None:
            return self._conn, True
        if self.use_https:
            self._conn = http.client.HTTPSConnection(self.host, timeout=self.timeout, context=self._ctx)
        else:
            self._conn = http.client.HTTPConnection(self.host, timeout=self.timeout)
        return self._conn, False

    def close(self):
        """Drop the network connection (the EVE-NG session cookie is kept)."""
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    def _store_cookies(self, resp):
        # Only the leading name=value matters. (http.cookies.SimpleCookie silently ignores EVE-NG's
        # cookie, whose expiry is in the year 3600.) The session is all on one host, so domain/path
        # need no handling.
        for header in resp.msg.get_all("Set-Cookie") or []:
            name, sep, value = header.split(";", 1)[0].partition("=")
            name, value = name.strip(), value.strip()
            if not sep or not name:
                continue
            if value in ("", "deleted") or re.search(r"max-age\s*=\s*0\b", header, re.IGNORECASE):
                self._cookies.pop(name, None)
            else:
                self._cookies[name] = value

    def _send(self, method, endpoint, data):
        """One HTTP exchange; returns (status, body text)."""
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        for attempt in (1, 2):
            if self._cookies:
                headers["Cookie"] = "; ".join(f"{k}={v}" for k, v in self._cookies.items())
            conn, reused = self._connection()
            try:
                conn.request(method, endpoint, body=data, headers=headers)
                resp = conn.getresponse()
                body = resp.read()
            except STALE_CONNECTION_ERRORS as exc:
                self.close()
                if reused and attempt == 1:
                    continue  # the server dropped the idle connection; retry once on a fresh one
                raise EveError(f"{method} {endpoint} -> {exc}") from None
            except (OSError, http.client.HTTPException) as exc:
                self.close()
                raise EveError(f"{method} {endpoint} -> {exc}") from None
            self._last_used = time.monotonic()
            self._store_cookies(resp)
            if resp.will_close:
                self.close()
            return resp.status, body.decode("utf-8", errors="replace")

    def request(self, method, endpoint, payload=None):
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        if endpoint.startswith("/api/labs") and endpoint != "/api/labs/close":
            self.lab_opened = True
        status, body = self._send(method, endpoint, data)
        if status in AUTH_FAILED and self._credentials and endpoint != LOGIN_ENDPOINT:
            # Session expired (or was replaced by another login): log in again and resend once
            self._login()
            status, body = self._send(method, endpoint, data)
        if status >= 400:
            raise EveError(f"{method} {endpoint} -> HTTP {status}: {body}")
        try:
            result = json.loads(body) if body else {}
        except ValueError:
            raise EveError(f"{method} {endpoint} -> invalid JSON response: {body[:200]}") from None
        if isinstance(result, dict) and result.get("status") == "fail":
            raise EveError(f"{method} {endpoint} -> {result.get('message')}")
        return result

    def _login(self):
        username, password = self._credentials
        # html5=-1 is required by Community Edition
        self.request("POST", LOGIN_ENDPOINT, {"username": username, "password": password, "html5": "-1"})

    def login(self, username, password):
        self._cookies.clear()
        self._credentials = (username, password)
        try:
            self._login()
        except EveError:
            self._credentials = None
            raise

    def close_lab(self):
        """Close the lab this session opened, so the next web login of this user isn't pointed at it."""
        if not self.lab_opened:
            return
        try:
            self.request("DELETE", "/api/labs/close")
        except EveError:
            pass
        self.lab_opened = False

    def release(self):
        """Close the lab this session opened and log out."""
        self.close_lab()
        self._credentials = None  # an expired session needs no logout; don't log in again just for it
        try:
            self.request("GET", "/api/auth/logout")
        except EveError:
            pass
        self._cookies.clear()
        self.close()


def is_pc(node):
    return node.get("type") == "vpcs"


def iface_index(name, kind="iol"):
    """Interface name -> EVE interface id. IOL: e0/1 -> port * 16 + slot. VPCS: eth0 -> 0."""
    if isinstance(name, int):
        return name
    text = str(name).strip()
    if kind == "vpcs":
        match = VPCS_RE.match(text)
        if not match:
            raise EveError(f"Unsupported PC interface name: {name!r} (a PC has a single port: eth0)")
        return int(match.group(1))
    match = IFACE_RE.match(text)
    if not match:
        raise EveError(f"Unsupported interface name: {name!r} (use e0/0 style; serial is not supported)")
    return int(match.group(3)) * 16 + int(match.group(2))


def iface_name(index, kind="iol"):
    """EVE interface id -> interface name (inverse of iface_index)."""
    return f"eth{index}" if kind == "vpcs" else f"e{index % 16}/{index // 16}"


def node_kinds(topology):
    return {n.get("name"): "vpcs" if is_pc(n) else "iol" for n in topology.get("nodes", [])}


def startup_config_text(node):
    """The node's CLI lines as a startup-config: console-only lines dropped, IOL configs closed with 'end'."""
    text = str(node.get("startup_config") or "").replace("\r\n", "\n").replace("\r", "\n")
    lines = [line.rstrip() for line in text.split("\n")
             if line.strip() and not CONSOLE_ONLY_RE.match(" ".join(line.split()))]
    if not lines:
        return ""
    if not is_pc(node):
        lines.append("end")
    return "\n".join(lines) + "\n"


def supports_startup_config(node):
    return is_pc(node) or str(node.get("image", "")).lower().startswith(STARTUP_CONFIG_IOL_PREFIXES)


def apply_startup_config(client, lab_api, node, node_id, log=print):
    """Store the node's startup-config on EVE-NG. Returns False when its image cannot load one."""
    text = startup_config_text(node)
    if not text:
        return True
    if not supports_startup_config(node):
        log(f"  config {node['name']}: image {node.get('image')} does not load a startup-config on EVE-NG; "
            "added as a text box to paste into the console")
        return False
    client.request("PUT", f"{lab_api}/configs/{node_id}", {"data": text})
    client.request("PUT", f"{lab_api}/nodes/{node_id}", {"id": int(node_id), "config": "1"})
    log(f"  config {node['name']}: loaded as startup-config ({len(text.splitlines())} lines, used on first boot)")
    return True


def config_text_boxes(nodes, topology):
    """Text boxes holding the console config of nodes whose image cannot load a startup-config."""
    tops = [_as_int(n.get("top")) for n in topology.get("nodes", [])] + \
           [_as_int(t.get("top")) for t in topology.get("texts", [])]
    top = max(tops, default=0) + 200
    return [{"text": "\n".join([node["name"], *[line for line in str(node["startup_config"]).splitlines() if line.strip()]]),
             "left": 50 + k * 320, "top": top} for k, node in enumerate(nodes)]


def node_defaults(node):
    node = {k: v for k, v in node.items() if k != "startup_config"}  # not an EVE node field
    if is_pc(node):
        defaults = {
            "type": "vpcs", "template": "vpcs", "image": "", "icon": "Desktop.png", "config": "Unconfigured",
            "ethernet": 1, "console": "telnet", "delay": 0, "count": 1, "left": 100, "top": 100,
        }
        defaults.update(node)
        return defaults
    is_l2 = "l2" in node["image"].lower()
    defaults = {
        "type": "iol",
        "template": "iol",
        "icon": "Switch.png" if is_l2 else "Router.png",
        "config": "Unconfigured",
        "ethernet": 2,
        "serial": 0,
        "nvram": 1024,
        "ram": 1024,
        "console": "telnet",
        "delay": 0,
        "count": 1,
        "left": 100,
        "top": 100,
    }
    defaults.update(node)
    return defaults


def lab_api_path(lab):
    lab_dir = lab.get("path", "/")
    lab_path = lab_dir.rstrip("/") + "/" + lab["name"] + ".unl"
    return lab_path, "/api/labs" + urllib.parse.quote(lab_path)


def validate_topology(topology):
    """Return a list of problems (empty list = OK) so errors surface before anything is created."""
    problems = []
    lab = topology.get("lab", {})
    if not re.fullmatch(r"[A-Za-z0-9_\-][A-Za-z0-9_\- ]*", lab.get("name", "")):
        problems.append("Lab name must contain only letters, digits, space, - or _")
    lab_dir = lab.get("path", "/")
    if not re.fullmatch(r"/([A-Za-z0-9_\- .]+/?)*", lab_dir) or ".." in lab_dir:
        problems.append(f"Invalid lab folder: {lab_dir!r} (use / or /Folder)")
    nodes = topology.get("nodes", [])
    if not nodes:
        problems.append("At least one node is required")
    names = [n.get("name", "") for n in nodes]
    for name in names:
        if not re.fullmatch(r"[A-Za-z0-9_\-.]+", name):
            problems.append(f"Invalid node name: {name!r}")
    for name, count in Counter(names).items():
        if count > 1:
            problems.append(f"Duplicate node name: {name}")
    by_name = {n.get("name"): node_defaults(n) for n in nodes if is_pc(n) or n.get("image")}
    for n in nodes:
        if not is_pc(n) and not n.get("image"):
            problems.append(f"Node {n.get('name')!r} has no image")
        config = n.get("startup_config", "")
        if not isinstance(config, str):
            problems.append(f"Node {n.get('name')!r}: startup_config must be text")
        elif len(config) > MAX_STARTUP_CONFIG:
            problems.append(f"Node {n.get('name')!r}: config is too long (max {MAX_STARTUP_CONFIG} characters)")
    kinds = node_kinds(topology)
    used = set()
    for number, link in enumerate(topology.get("links", []), start=1):
        for side, key in (("source", "source_interface"), ("destination", "destination_interface")):
            node_name = link.get(side)
            if node_name not in by_name:
                problems.append(f"Link {number}: unknown node {node_name!r}")
                continue
            try:
                idx = iface_index(link.get(key, ""), kinds[node_name])
            except EveError as exc:
                problems.append(f"Link {number}: {exc}")
                continue
            node = by_name[node_name]
            if kinds[node_name] == "vpcs":
                if idx != 0:
                    problems.append(f"Link {number}: {node_name} has only one port (eth0)")
            elif idx % 16 >= int(node["ethernet"]):
                problems.append(f"Link {number}: {node_name} has no interface {link[key]} "
                                f"(ethernet groups={node['ethernet']})")
            if (node_name, idx) in used:
                problems.append(f"Link {number}: {node_name} {link[key]} is already used")
            used.add((node_name, idx))
    for number, text in enumerate(topology.get("texts", []), start=1):
        if "raw_payload" in text:
            continue
        if not str(text.get("text", "")).strip():
            problems.append(f"Text {number} is empty")
        elif len(text["text"]) > 2000:
            problems.append(f"Text {number} is too long (max 2000 characters)")
        for key in ("left", "top"):
            try:
                int(text.get(key, 0))
            except (TypeError, ValueError):
                problems.append(f"Text {number}: {key} must be a number")
    return problems


def set_lab_power(client, lab, action):
    if action not in ("start", "stop"):
        raise EveError(f"Unknown action {action!r}")
    _, lab_api = lab_api_path(lab)
    # EVE only accepts node power actions for a lab that is loaded into the session,
    # and its bulk /nodes/start endpoint is rejected, so act on each node individually.
    client.request("GET", lab_api)
    nodes = client.request("GET", f"{lab_api}/nodes")["data"] or {}
    failures = []
    for node_id, node in nodes.items():
        try:
            client.request("GET", f"{lab_api}/nodes/{node_id}/{action}")
        except EveError as exc:
            failures.append(f"{node.get('name', node_id)}: {exc}")
    if failures:
        raise EveError("; ".join(failures))


STATUS_NAMES = {0: "stopped", 2: "running"}


def read_attachments(client, lab_api, node_ids):
    """For {node name: id} return ({network id: {(node, iface id)}}, {(node, iface id)} that exist)."""
    attached, existing = {}, set()
    for name, node_id in node_ids.items():
        data = client.request("GET", f"{lab_api}/nodes/{node_id}/interfaces")["data"]
        ifaces = data.get("ethernet")
        if isinstance(ifaces, list):  # VPCS reports its ports as a list; the position is the interface id
            ifaces = dict(enumerate(ifaces))
        if not isinstance(ifaces, dict):
            continue
        for idx, info in ifaces.items():
            existing.add((name, int(idx)))
            if info.get("network_id"):
                attached.setdefault(info["network_id"], set()).add((name, int(idx)))
    return attached, existing


def verify_lab(client, topology):
    """Compare the lab as it exists on EVE-NG with the topology; returns [(ok, item, detail)]."""
    lab = topology["lab"]
    lab_path, lab_api = lab_api_path(lab)
    try:
        client.request("GET", lab_api)
    except EveError as exc:
        return [(False, f"Lab {lab_path}", f"not found on EVE-NG ({exc})")]

    results = [(True, f"Lab {lab_path}", "exists")]
    actual = client.request("GET", f"{lab_api}/nodes")["data"] or {}
    by_name = {n["name"]: (node_id, n) for node_id, n in actual.items()}
    attached, _ = read_attachments(client, lab_api, {name: nid for name, (nid, _) in by_name.items()})

    expected_names = set()
    for node in topology["nodes"]:
        expected_names.add(node["name"])
        item = f"Node {node['name']}"
        if node["name"] not in by_name:
            results.append((False, item, "missing on EVE-NG"))
            continue
        wanted = node_defaults(node)
        _, real = by_name[node["name"]]
        problems = []
        if real.get("type") != wanted["type"]:
            problems.append(f"type is {real.get('type')}, expected {wanted['type']}")
        elif not is_pc(node):
            if real.get("image") != wanted["image"]:
                problems.append(f"image is {real.get('image')}")
            if int(real.get("ethernet", 0)) != int(wanted["ethernet"]):
                problems.append(f"ethernet groups is {real.get('ethernet')}")
        status = STATUS_NAMES.get(real.get("status"), f"status {real.get('status')}")
        label = "PC (VPCS)" if is_pc(node) else real.get("image")
        results.append((not problems, item, f"{label} ({status})" if not problems else "; ".join(problems)))

    for name in sorted(set(by_name) - expected_names):
        results.append((False, f"Node {name}", "exists on EVE-NG but is not in the form"))

    kinds = node_kinds(topology)
    connected = {frozenset(members) for members in attached.values()}
    for number, link in enumerate(topology.get("links", []), start=1):
        item = (f"Link {link['source']} {link['source_interface']} <-> "
                f"{link['destination']} {link['destination_interface']}")
        ends = frozenset({(link["source"], iface_index(link["source_interface"], kinds.get(link["source"], "iol"))),
                          (link["destination"], iface_index(link["destination_interface"],
                                                            kinds.get(link["destination"], "iol")))})
        if ends in connected:
            results.append((True, item, "connected"))
        else:
            results.append((False, item, "not connected as expected"))

    wanted_texts = len(topology.get("texts", []))
    try:
        actual_texts = len(client.request("GET", f"{lab_api}/textobjects")["data"] or {})
    except EveError:
        actual_texts = 0
    if wanted_texts or actual_texts:
        results.append((actual_texts == wanted_texts, "Texts",
                        f"{actual_texts} on EVE-NG, {wanted_texts} in the form"))
    return results


def _as_int(value, default=0):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def parse_text_object(encoded):
    """Decode an EVE text object (base64 HTML) into (plain text, left, top)."""
    raw = base64.b64decode(encoded).decode("utf-8", errors="replace")
    left = re.search(r"(?<![-\w])left:\s*(-?[\d.]+)px", raw)
    top = re.search(r"(?<![-\w])top:\s*(-?[\d.]+)px", raw)
    body = re.sub(r'<div[^>]*ui-resizable-handle[^>]*></div>', "", raw)
    body = re.sub(r"<br\s*/?>|</?p[^>]*>|</?div[^>]*>", "\n", body)
    body = re.sub(r"<[^>]+>", "", body)
    text = html.unescape(body).replace("\xa0", " ")
    text = "\n".join(line.rstrip() for line in text.split("\n"))
    text = re.sub(r"\n{2,}", "\n", text).strip("\n")
    return text, _as_int(left.group(1) if left else 0), _as_int(top.group(1) if top else 0)


def _normalize_text(text):
    return " ".join(text.split())


def read_texts(client, lab_api):
    """Return [(id, text, left, top)] for the text objects of a lab (shapes are ignored)."""
    listing = client.request("GET", f"{lab_api}/textobjects")["data"] or {}
    texts = []
    for text_id in sorted(listing, key=int):
        entry = listing[text_id]
        kind = entry.get("type") if isinstance(entry, dict) else None
        if kind not in (None, "text"):
            continue  # a shape: skip without fetching its details
        detail =client.request("GET", f"{lab_api}/textobjects/{text_id}")["data"]
        if detail.get("type") != "text" or not detail.get("data"):
            continue
        text, left, top = parse_text_object(detail["data"])
        texts.append((int(text_id), text, left, top))
    return texts


def list_images(client):
    """Return the IOL image file names installed on the EVE-NG server."""
    options = client.request("GET", "/api/list/templates/iol")["data"].get("options", {})
    return sorted(options.get("image", {}).get("list", {}), key=str.lower)


def list_tree(client, folder="/", depth=8):
    """Return (lab paths, folder paths) under a folder, e.g. (['/A/x.unl'], ['/A', '/A/sub'])."""
    data = client.request("GET", "/api/folders" + urllib.parse.quote(folder))["data"]
    labs = [lab["path"] for lab in data.get("labs", [])]
    folders = []
    if depth > 0:
        for sub in data.get("folders", []):
            if sub["name"] == "..":
                continue
            folders.append(sub["path"])
            try:
                sub_labs, sub_folders = list_tree(client, sub["path"], depth - 1)
            except EveError:
                continue
            labs += sub_labs
            folders += sub_folders
    return sorted(set(labs), key=str.lower), sorted(set(folders), key=str.lower)


def list_labs(client, folder="/", depth=8):
    """Return sorted lab paths (e.g. /ENTERPRISE/x.unl) found under a folder."""
    return list_tree(client, folder, depth)[0]


RUNNING_KEYS = ("iol", "vpcs", "qemu", "dynamips", "docker")


def anything_running(client):
    """True when any node is running on the server. Slow (~1.5 s on EVE-NG 6.2: it samples CPU), so use
    it only to skip many per-lab lookups (~0.1 s each)."""
    status = client.request("GET", "/api/status")["data"]
    return any(_as_int(status.get(key)) for key in RUNNING_KEYS)


def lab_from_path(lab_path):
    lab_dir, _, file_name = lab_path.rpartition("/")
    return {"name": file_name[:-4] if file_name.endswith(".unl") else file_name, "path": lab_dir or "/"}


def running_nodes(client, lab_path):
    """Names of nodes in a lab that are not stopped."""
    _, lab_api = lab_api_path(lab_from_path(lab_path))
    client.request("GET", lab_api)
    nodes = client.request("GET", f"{lab_api}/nodes")["data"] or {}
    return [n["name"] for n in nodes.values() if _as_int(n.get("status")) != 0]


def delete_lab(client, lab_path):
    """Delete one lab. EVE-NG would delete a lab even with running nodes (leaving them orphaned), so refuse."""
    # one lab: reading its nodes directly is faster than the server-wide anything_running() check
    active = running_nodes(client, lab_path)  # also loads the lab into the session, as DELETE needs
    if active:
        raise EveError(f"ลบไม่ได้: ยังมีอุปกรณ์ทำงานอยู่ ({', '.join(active[:5])}) ให้ปิดอุปกรณ์ก่อน "
                       "(EVE-NG อาจแสดงว่าทำงานอยู่ ถ้ามี lab อื่นที่ node หมายเลขเดียวกันกำลังรัน)")
    _, lab_api = lab_api_path(lab_from_path(lab_path))
    client.request("DELETE", lab_api)


def create_folder(client, parent, name):
    client.request("POST", "/api/folders", {"path": parent, "name": name})


def delete_folder(client, folder):
    """Delete a folder with everything inside it. Returns (labs removed, subfolders removed)."""
    labs, subfolders = list_tree(client, folder)
    # many labs: one server-wide check first; a few labs: checking each directly is faster
    if labs and (len(labs) <= 10 or anything_running(client)):
        busy = {lab: running_nodes(client, lab) for lab in labs}
        busy = {lab: nodes for lab, nodes in busy.items() if nodes}
        if busy:
            first = next(iter(busy))
            raise EveError(f"ลบโฟลเดอร์ไม่ได้: ยังมีอุปกรณ์ทำงานอยู่ใน {len(busy)} lab (เช่น {first}) ให้ปิดอุปกรณ์ก่อน "
                           "(EVE-NG อาจแสดงว่าทำงานอยู่ ถ้ามี lab อื่นที่ node หมายเลขเดียวกันกำลังรัน)")
    client.request("DELETE", "/api/folders" + urllib.parse.quote(folder))
    return len(labs), len(subfolders)


def import_lab(client, lab_path):
    """Read an existing lab into the topology format; returns (topology, warnings)."""
    lab = lab_from_path(lab_path)
    _, lab_api = lab_api_path(lab)
    info = client.request("GET", lab_api)["data"]
    lab["description"] = info.get("description", "")
    warnings = []

    raw_nodes = client.request("GET", f"{lab_api}/nodes")["data"] or {}
    id_to_name, id_to_kind, nodes = {}, {}, []
    for node_id in sorted(raw_nodes, key=int):
        node = raw_nodes[node_id]
        if node.get("type") not in ("iol", "vpcs"):
            warnings.append(f"Skipped node {node.get('name')} (type {node.get('type')}; the form supports IOL and VPCS only)")
            continue
        id_to_name[int(node_id)] = node["name"]
        position = {"left": _as_int(node.get("left")), "top": _as_int(node.get("top"))}
        if node["type"] == "vpcs":
            id_to_kind[int(node_id)] = "vpcs"
            nodes.append({"name": node["name"], "type": "vpcs", **position})
            continue
        id_to_kind[int(node_id)] = "iol"
        nodes.append({"name": node["name"], "image": node.get("image", ""),
                      "ethernet": _as_int(node.get("ethernet"), 2), **position})

    # startup-configs that are switched on come back into the form's config box
    by_id = {node_id: n for node_id, n in zip((i for i in sorted(raw_nodes, key=int) if int(i) in id_to_name), nodes)}
    try:
        config_list = client.request("GET", f"{lab_api}/configs")["data"] or {}
    except EveError:
        config_list = {}
    for node_id, meta in config_list.items():
        if node_id in by_id and str(meta.get("config")) == "1" and meta.get("len"):
            try:
                data = client.request("GET", f"{lab_api}/configs/{node_id}")["data"].get("data") or ""
            except EveError as exc:
                warnings.append(f"Could not read the startup-config of {by_id[node_id]['name']}: {exc}")
                continue
            if data.strip():
                by_id[node_id]["startup_config"] = data.strip()

    links, seen = [], set()
    port_re = {"iol": IFACE_RE, "vpcs": VPCS_RE}
    for entry in client.request("GET", f"{lab_api}/topology")["data"] or []:
        src_id = re.fullmatch(r"node(\d+)", str(entry.get("source", "")))
        dst_id = re.fullmatch(r"node(\d+)", str(entry.get("destination", "")))
        label = f"{entry.get('source')} -> {entry.get('destination')}"
        if entry.get("type") != "ethernet" or not (src_id and dst_id):
            warnings.append(f"Skipped link {label} (only node-to-node ethernet links are supported)")
            continue
        src_n, dst_n = int(src_id.group(1)), int(dst_id.group(1))
        ifaces = (entry.get("source_label", ""), entry.get("destination_label", ""))
        supported = (src_n in id_to_name and dst_n in id_to_name
                     and port_re[id_to_kind[src_n]].match(ifaces[0]) and port_re[id_to_kind[dst_n]].match(ifaces[1]))
        if not supported:
            warnings.append(f"Skipped link {label} (unsupported node or interface)")
            continue
        src, dst = id_to_name[src_n], id_to_name[dst_n]
        key = frozenset({(src, ifaces[0]), (dst, ifaces[1])})
        if key in seen:
            continue
        seen.add(key)
        links.append({"source": src, "source_interface": ifaces[0],
                      "destination": dst, "destination_interface": ifaces[1]})

    texts = [{"text": text, "left": left, "top": top}
             for _, text, left, top in read_texts(client, lab_api) if text]
    return {"lab": lab, "nodes": nodes, "links": links, "texts": texts}, warnings


def sync_lab(client, topology, log=print):
    """Add nodes, links and texts missing from an existing lab. Never deletes or edits anything."""
    lab = topology["lab"]
    lab_path, lab_api = lab_api_path(lab)
    try:
        client.request("GET", lab_api)
    except EveError as exc:
        raise EveError(f"Lab {lab_path} does not exist on EVE-NG; use Build to create it ({exc})") from None

    actual = client.request("GET", f"{lab_api}/nodes")["data"] or {}
    node_ids = {n["name"]: node_id for node_id, n in actual.items()}
    added = skipped = 0
    console_only = []

    for node in topology["nodes"]:
        name = node["name"]
        if name in node_ids:
            real, wanted = actual[node_ids[name]], node_defaults(node)
            differs = []
            if real.get("type") != wanted["type"]:
                differs.append(f"type is {real.get('type')}")
            elif not is_pc(node):
                if real.get("image") != wanted["image"]:
                    differs.append(f"image is {real.get('image')}")
                if _as_int(real.get("ethernet")) != _as_int(wanted["ethernet"]):
                    differs.append(f"ethernet groups is {real.get('ethernet')}")
            log(f"  node {name}: kept" + (f" (differs: {'; '.join(differs)}; not modified)" if differs else ""))
            continue
        result = client.request("POST", lab_api + "/nodes", node_defaults(node))
        node_ids[name] = str(result["data"]["id"])
        added += 1
        log(f"  node {name}: ADDED (id {node_ids[name]})")
        # only new nodes get a startup-config; existing nodes (and their configs) are never touched
        if not apply_startup_config(client, lab_api, node, node_ids[name], log):
            console_only.append(node)

    kinds = node_kinds(topology)
    attached, existing = read_attachments(client, lab_api, node_ids)
    connected = {frozenset(members) for members in attached.values()}
    used = {end for members in attached.values() for end in members}
    new_links = []
    for link in topology.get("links", []):
        label = (f"{link['source']}:{link['source_interface']} <-> "
                 f"{link['destination']}:{link['destination_interface']}")
        ends = {(link["source"], iface_index(link["source_interface"], kinds[link["source"]])),
                (link["destination"], iface_index(link["destination_interface"], kinds[link["destination"]]))}
        if frozenset(ends) in connected:
            log(f"  link {label}: kept")
            continue
        missing = sorted(f"{n} {iface_name(i, kinds[n])}" for n, i in ends if (n, i) not in existing)
        busy = sorted(f"{n} {iface_name(i, kinds[n])}" for n, i in ends if (n, i) in used)
        if missing or busy:
            skipped += 1
            reason = ("does not exist: " + ", ".join(missing)) if missing else ("already in use: " + ", ".join(busy))
            log(f"  link {label}: SKIPPED ({reason})")
            continue
        new_links.append((label, sorted(ends)))
        connected.add(frozenset(ends))
        used.update(ends)
    if new_links:
        connect_links(client, lab_api, node_ids, [ends for _, ends in new_links], len(attached) + 1)
        for label, _ in new_links:
            added += 1
            log(f"  link {label}: ADDED")

    try:
        current = read_texts(client, lab_api)
    except EveError:
        current = []
    known = {_normalize_text(text) for _, text, _, _ in current}
    next_number = max([text_id for text_id, *_ in current], default=0) + 1
    for text in list(topology.get("texts", [])) + config_text_boxes(console_only, topology):
        preview = text["text"].splitlines()[0][:40] if text.get("text") else ""
        if _normalize_text(text.get("text", "")) in known:
            log(f"  text {preview!r}: kept")
            continue
        client.request("POST", lab_api + "/textobjects", text_payload(text, next_number))
        next_number += 1
        added += 1
        log(f"  text {preview!r}: ADDED")

    log(f"Sync done: {added} added, {skipped} skipped. Existing objects were not changed.")
    return {"added": added, "skipped": skipped}


def connect_links(client, lab_api, node_ids, links, first_number=1):
    """Make each link ([(node name, iface id), (node name, iface id)]) a plain node-to-node connection.

    A hidden network is discarded by EVE while it has no connections (and cannot be attached to),
    so the networks are created visible, attached, then hidden. All interfaces of a node are set in
    a single request: 2 requests per link + 1 per node, instead of 4 per link.
    """
    per_node, net_ids = {}, []
    for number, ends in enumerate(links, start=first_number):
        net_id = client.request("POST", lab_api + "/networks", {
            "count": 1,
            "name": f"link{number}",
            "type": "bridge",
            "left": 0,
            "top": 0,
            "visibility": 1,
        })["data"]["id"]
        net_ids.append(net_id)
        for node_name, idx in ends:
            per_node.setdefault(node_name, {})[str(idx)] = str(net_id)
    for node_name, mapping in per_node.items():
        client.request("PUT", f"{lab_api}/nodes/{node_ids[node_name]}/interfaces", mapping)
    for net_id in net_ids:
        client.request("PUT", f"{lab_api}/networks/{net_id}", {"visibility": 0})
    return net_ids


def build_lab(client, topology, recreate=False, skip_texts=False, start=False, log=print):
    lab = topology["lab"]
    lab_dir = lab.get("path", "/")
    file_name = lab["name"] + ".unl"
    lab_path = lab_dir.rstrip("/") + "/" + file_name
    lab_api = "/api/labs" + urllib.parse.quote(lab_path)

    if recreate:
        try:
            client.request("DELETE", lab_api)
            log(f"Deleted existing lab {lab_path}")
        except EveError:
            pass

    client.request("POST", "/api/labs", {
        "path": lab_dir,
        "name": lab["name"],
        "version": "1",
        "author": lab.get("author", ""),
        "description": lab.get("description", ""),
        "body": "",
    })
    log(f"Created lab {lab_path}")

    node_ids = {}
    kinds = node_kinds(topology)
    console_only = []
    for node in topology["nodes"]:
        payload = node_defaults(node)
        result = client.request("POST", lab_api + "/nodes", payload)
        node_ids[node["name"]] = result["data"]["id"]
        log(f"  node {node['name']} -> id {node_ids[node['name']]}")
        if not apply_startup_config(client, lab_api, node, node_ids[node["name"]], log):
            console_only.append(node)

    links = topology.get("links", [])
    for number, link in enumerate(links, start=1):
        for name in (link["source"], link["destination"]):
            if name not in node_ids:
                raise EveError(f"Link {number} references unknown node {name!r}")
    connect_links(client, lab_api, node_ids, [
        [(link["source"], iface_index(link["source_interface"], kinds[link["source"]])),
         (link["destination"], iface_index(link["destination_interface"], kinds[link["destination"]]))]
        for link in links])
    for link in links:
        log(f"  link {link['source']}:{link['source_interface']} <-> "
            f"{link['destination']}:{link['destination_interface']}")

    if not skip_texts:
        texts = list(topology.get("texts", [])) + config_text_boxes(console_only, topology)
        for number, text in enumerate(texts, start=1):
            try:
                client.request("POST", lab_api + "/textobjects", text_payload(text, number))
                log(f"  text {text.get('text', '')!r}")
            except EveError as exc:
                log(f"  WARNING text not created (capture the real payload with F12): {exc}")

    if start:
        set_lab_power(client, lab, "start")
        log("Started all nodes")
    return lab_path


def text_payload(text, number=1):
    """Use 'raw_payload' as-is if given; otherwise build the same HTML block the EVE web UI stores."""
    if "raw_payload" in text:
        return text["raw_payload"]
    lines = text["text"].replace("\r\n", "\n").replace("\r", "\n").split("\n")
    label = "<br>".join(html.escape(line) for line in lines)
    width = max(150, max(len(line) for line in lines) * 9 + 20)
    height = len(lines) * 24 + 8
    block = (
        f'<div id="customText{number}" class="customShape customText context-menu" data-path="{number}" '
        f'style="display: inline; position: absolute; left: {int(text.get("left", 0))}px; '
        f'top: {int(text.get("top", 0))}px; cursor: move; z-index: 1001; width: {width}px; height: {height}px;">'
        '<p align="left" style="vertical-align: top; color: rgb(0, 0, 0); '
        'background-color: rgb(255, 255, 255); font-size: 15px; font-weight: normal;">'
        f"{label}</p></div>"
    )
    return {
        "name": f"txt {number}",
        "type": "text",
        "data": base64.b64encode(block.encode("utf-8")).decode("ascii"),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("topology", nargs="?", default="topology.json")
    parser.add_argument("--host")
    parser.add_argument("--https", action="store_true")
    parser.add_argument("--recreate", action="store_true", help="delete a lab with the same name first")
    parser.add_argument("--skip-texts", action="store_true")
    parser.add_argument("--start", action="store_true", help="start all nodes after building")
    args = parser.parse_args()

    with open(args.topology, "r", encoding="utf-8") as fh:
        topology = json.load(fh)

    eve = topology.get("eve", {})
    host = args.host or eve.get("host")
    username = EVE_USERNAME
    if not host:
        parser.error("EVE-NG host not set (--host or topology 'eve.host')")
    password = os.environ.get("EVE_PASSWORD") or getpass.getpass(f"EVE-NG password for {username}: ")

    client = EveClient(host, use_https=args.https or eve.get("https", False))
    problems = validate_topology(topology)
    if problems:
        sys.exit("Invalid topology:\n  " + "\n  ".join(problems))
    try:
        client.login(username, password)
        build_lab(client, topology, args.recreate, args.skip_texts, args.start)
    except EveError as exc:
        sys.exit(f"ERROR: {exc}")
    finally:
        client.release()


if __name__ == "__main__":
    main()

