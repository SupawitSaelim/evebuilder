"""Turn AI-generated (or hand-written) JSON into the topology format used by the form.

The importer is deliberately forgiving: it strips code fences and surrounding prose, accepts a few
alternative key names, converts Gi0/1-style port names to IOL names and fills in missing details.
Anything it changes or drops is reported as a warning instead of failing the whole import.
"""

import json
import re

from eve_builder import EveError

ROUTER_IMAGE = "x86_64_crb_linux-adventerprisek9-ms.bin"
SWITCH_IMAGE = "x86_64_crb_linux_l2-adventerprisek9-ms.bin"
MAX_TEXT = 500_000
PC_KINDS = {"pc", "vpc", "vpcs", "host", "laptop", "desktop", "workstation"}
UNSUPPORTED_KINDS = {"server", "cloud", "internet", "phone", "ap", "firewall"}

PORT_RE = re.compile(
    r"^(?:e|et|eth|ethernet|fa|fastethernet|gi|gig|gigabitethernet|te|tengigabitethernet)\s*(\d+)\s*/\s*(\d+)$",
    re.IGNORECASE)
LINK_TEXT_RE = re.compile(r"^\s*(\S+?)\s*[:\s]\s*(\S+)\s*(?:<->|<-->|-->|->|--|-)\s*(\S+?)\s*[:\s]\s*(\S+)\s*$")

IMPORT_SAMPLE = {
    "lab": {"name": "branch_lab", "description": "Branch network"},
    "nodes": [
        {"name": "CORE-R01", "type": "router", "config": [
            "enable", "configure terminal", "hostname CORE-R01", "no ip domain-lookup",
            "interface e0/0", "ip address 192.168.1.1 255.255.255.252", "no shutdown", "exit",
            "end", "write memory"]},
        {"name": "BRANCH-R01", "type": "router", "config": [
            "enable", "configure terminal", "hostname BRANCH-R01", "no ip domain-lookup",
            "interface e0/0", "ip address 192.168.1.2 255.255.255.252", "no shutdown", "exit",
            "interface e0/1", "ip address 10.1.1.1 255.255.255.0", "no shutdown", "exit",
            "end", "write memory"]},
        {"name": "BRANCH-SW01", "type": "switch", "config": [
            "enable", "configure terminal", "hostname BRANCH-SW01", "no ip domain-lookup",
            "end", "write memory"]},
        {"name": "PC1", "type": "pc", "config": ["set pcname PC1", "ip 10.1.1.10/24 10.1.1.1", "save"]},
    ],
    "links": [
        {"source": "CORE-R01", "source_interface": "e0/0", "destination": "BRANCH-R01", "destination_interface": "e0/0"},
        {"source": "BRANCH-R01", "source_interface": "e0/1", "destination": "BRANCH-SW01", "destination_interface": "e0/0"},
        {"source": "BRANCH-SW01", "source_interface": "e0/1", "destination": "PC1", "destination_interface": "eth0"},
    ],
    "texts": [{"text": "WAN Connection"}],
    "assumptions": ["Example only: describe anything you were unsure about here."],
}

IMPORT_PROMPT = """You are helping me build a network lab in EVE-NG using Cisco IOL devices.
I will give you a lab exercise (screenshot or text). Read it and output ONE JSON object that follows the
format below. Output only the JSON (in a single ```json code block). No explanation outside the JSON.

Rules:
- lab.name: letters, digits, "-" or "_" only (example: "ospf_lab_1").
- Every device is an entry in "nodes": {"name": ..., "type": "router" | "switch" | "pc"}.
  "switch" is a layer-2 switch; "pc" is any end host or PC. Node names use letters, digits, "-", "_" or "."
  only (no spaces).
- Servers, clouds, firewalls, phones and other devices are not supported: leave them out and mention them in
  "assumptions".
- Router and switch interfaces use IOL names: e0/0, e0/1, e0/2, e0/3, e1/0, e1/1, ... (4 ports per group, so
  e1/0 is the 5th port). If the exercise uses names like Gi0/1 or Fa0/1, convert them to the same slot/port in
  e-style (Gi0/1 -> e0/1). A PC has exactly one port, always named "eth0".
- Each interface can be used by only ONE link, and each link joins two different nodes.
- Do not invent devices or links that are not in the exercise. When something is unclear, choose the simplest
  option and write it in "assumptions".
- Do NOT include positions (left/top). The program arranges the diagram by itself.

Starter config (every node gets "config": a list of CLI lines, loaded as the device's startup-config):
- Router and switch: exactly this order: "enable", "configure terminal", "hostname <node name>",
  "no ip domain-lookup", then one block per interface that has an IP address:
  "interface <name>", "ip address <address> <dotted subnet mask>", "no shutdown", "exit"
  (use the same e-style interface names as in "links"; add "interface Loopback0" blocks if the exercise shows
  loopbacks), and finally "end", "write memory". A switch without IP addresses only gets the lines up to
  "no ip domain-lookup" plus "end", "write memory".
- IP ADDRESSING ONLY: do not configure routing protocols, redistribution, route-maps, ACLs, VLANs, NAT or
  anything else. Those are the exercise itself.
- Use the IP addresses shown in the exercise. If a link only shows its subnet (for example 12.12.12.0/24),
  give each router on that link the host address equal to the number in its name (R2 -> .2, R3 -> .3). If the
  name has no number, use .1 for the first device listed on the link and .2 for the second. If that host
  address collides with a PC or another device, pick the nearest free one.
- PC (VPCS): "config" is exactly: "set pcname <node name>", "ip <address>/<prefix> <default gateway>", "save".
  The gateway is the IP of the router interface the PC is connected to (or the gateway shown in the
  exercise). If the PC is connected to a router, give that router interface an address in the PC's subnet
  using the rule above.
- List every address you had to choose yourself in "assumptions" (for example "R2 e0/3 = 10.2.2.2/24 chosen as
  PC2 gateway").
- "notes" is optional and only for short remarks that are not CLI (for example "redistribution router"); do not
  repeat IP addresses there. Put general remarks that are not tied to one device in "texts".

JSON format (example):
""" + json.dumps(IMPORT_SAMPLE, indent=2, ensure_ascii=False) + """
"""


def extract_json(text):
    """Pull a JSON value out of text that may contain code fences or surrounding prose."""
    text = (text or "").strip()
    if not text:
        raise EveError("ไม่มีข้อความให้นำเข้า")
    if len(text) > MAX_TEXT:
        raise EveError("ข้อความใหญ่เกินไป")
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL | re.IGNORECASE)
    if fence:
        text = fence.group(1).strip()
    try:
        return json.loads(text)
    except ValueError:
        pass
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except ValueError as exc:
            raise EveError(f"JSON ไม่ถูกต้อง: {exc}") from None
    raise EveError("ไม่พบ JSON ในข้อความ")


def _int(value):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _clean_name(value):
    return re.sub(r"[^A-Za-z0-9_\-.]+", "_", re.sub(r"\s+", "-", str(value).strip()))


def _port(value, kind, node_name, warnings):
    """Normalise a port name for the device kind; unknown shapes are returned unchanged for validation to report."""
    text = str(value).strip()
    if kind == "vpcs":
        if text.lower() != "eth0":
            warnings.add(f"{node_name}: PC มีพอร์ตเดียว ใช้ eth0 แทน '{text}'")
        return "eth0"
    match = PORT_RE.match(text)
    if not match:
        return text
    port = f"e{match.group(1)}/{match.group(2)}"
    if port.lower() != text.lower():
        warnings.add(f"แปลงชื่อพอร์ต {text} เป็น {port} (IOL ใช้ชื่อแบบ eX/Y)")
    return port


def _parse_link(raw):
    """Return (node, port, node, port) from a dict or a 'R1:e0/0 <-> SW1:e0/1' string, or None."""
    if isinstance(raw, str):
        match = LINK_TEXT_RE.match(raw)
        if not match:
            return None
        a, ap, b, bp = match.groups()
    elif isinstance(raw, dict):
        def pick(*keys):
            return next((raw[k] for k in keys if raw.get(k) not in (None, "")), None)
        a, b = pick("source", "from", "a", "node_a"), pick("destination", "to", "b", "node_b", "target")
        ap = pick("source_interface", "from_interface", "a_interface", "source_port", "from_port", "interface_a")
        bp = pick("destination_interface", "to_interface", "b_interface", "destination_port", "to_port", "interface_b")
        if None in (a, b, ap, bp):
            return None
    else:
        return None
    return _clean_name(a), str(ap), _clean_name(b), str(bp)


def _lines(value):
    if value in (None, ""):
        return []
    items = value if isinstance(value, list) else str(value).splitlines()
    return [str(item).strip() for item in items if str(item).strip()]


def normalize_topology(data):
    """Return (topology, warnings). Raises EveError only when nothing usable is present."""
    if not isinstance(data, dict):
        raise EveError("JSON ต้องเป็น object รูปแบบ { \"nodes\": [...], \"links\": [...] }")
    warnings = []
    port_notes = set()

    lab_in = data.get("lab") if isinstance(data.get("lab"), dict) else {}
    raw_name = str(lab_in.get("name") or data.get("name") or "imported_lab").strip()
    lab_name = re.sub(r"[^A-Za-z0-9_\- ]+", "_", raw_name).strip() or "imported_lab"
    if lab_name != raw_name:
        warnings.append(f"ปรับชื่อ lab '{raw_name}' เป็น '{lab_name}'")
    lab = {"name": lab_name, "description": str(lab_in.get("description") or data.get("description") or "")}

    nodes, texts, kinds = [], [], {}
    for i, raw in enumerate(data.get("nodes") or [], start=1):
        if isinstance(raw, str):
            raw = {"name": raw}
        if not isinstance(raw, dict):
            warnings.append(f"ข้าม node ลำดับที่ {i}: รูปแบบไม่ถูกต้อง")
            continue
        name = _clean_name(raw.get("name") or f"NODE-{i}")
        kind = str(raw.get("type") or raw.get("role") or raw.get("kind") or "").strip().lower()
        image = str(raw.get("image") or "").strip()
        if kind in UNSUPPORTED_KINDS:
            warnings.append(f"ข้าม {name} (type {kind}): ฟอร์มรองรับเฉพาะ router, switch และ PC")
            continue
        left, top = _int(raw.get("left")), _int(raw.get("top"))
        position = {"left": left, "top": top} if left is not None and top is not None else {}
        if kind in PC_KINDS:
            nodes.append({"name": name, "type": "vpcs", **position})
            kinds[name] = "vpcs"
        else:
            if kind:
                is_switch = "sw" in kind or "l2" in kind
            elif image:
                is_switch = "l2" in image.lower()
            else:
                is_switch = name.lower().startswith("sw") or "switch" in name.lower()
                warnings.append(f"{name}: ไม่ระบุ type เดาว่าเป็น {'switch' if is_switch else 'router'} จากชื่อ")
            if not image.lower().endswith(".bin"):
                image = SWITCH_IMAGE if is_switch else ROUTER_IMAGE
            nodes.append({"name": name, "image": image, "_default_groups": 4 if is_switch else 2,
                          "_given_groups": _int(raw.get("ethernet")), **position})
            kinds[name] = "iol"
        notes = _lines(raw.get("notes") or raw.get("note") or raw.get("ip"))
        if notes:
            texts.append({"text": "\n".join([name, *notes])})
        # the CLI lines become the node's startup-config (loaded by EVE-NG on first boot)
        config = _lines(raw.get("config") or raw.get("commands") or raw.get("cli") or raw.get("startup_config"))
        if config:
            nodes[-1]["startup_config"] = "\n".join(config)

    links, needed = [], {}
    for i, raw in enumerate(data.get("links") or [], start=1):
        parsed = _parse_link(raw)
        if parsed is None:
            warnings.append(f"ข้าม link ลำดับที่ {i}: อ่านรูปแบบไม่ได้ ({raw!r})")
            continue
        a, ap, b, bp = parsed
        missing = [n for n in (a, b) if n not in kinds]
        if missing:
            warnings.append(f"ข้าม link {a}:{ap} <-> {b}:{bp}: ไม่มี node {', '.join(missing)}")
            continue
        ap, bp = _port(ap, kinds[a], a, port_notes), _port(bp, kinds[b], b, port_notes)
        links.append({"source": a, "source_interface": ap, "destination": b, "destination_interface": bp})
        for node_name, port in ((a, ap), (b, bp)):
            match = PORT_RE.match(port) if kinds[node_name] == "iol" else None
            if match:
                needed[node_name] = max(needed.get(node_name, 0), int(match.group(1)) + 1)
    warnings.extend(sorted(port_notes))

    for node in nodes:
        if node.get("type") == "vpcs":
            continue
        default, given = node.pop("_default_groups"), node.pop("_given_groups")
        groups = given if given and given > 0 else default
        if groups < needed.get(node["name"], 0):
            warnings.append(f"{node['name']}: เพิ่มจำนวนกลุ่มพอร์ตเป็น {needed[node['name']]} ให้พอกับ link")
            groups = needed[node["name"]]
        node["ethernet"] = min(groups, 16)

    for raw in data.get("texts") or []:
        if isinstance(raw, str):
            raw = {"text": raw}
        if not isinstance(raw, dict) or not str(raw.get("text", "")).strip():
            continue
        item = {"text": str(raw["text"]).strip()}
        left, top = _int(raw.get("left")), _int(raw.get("top"))
        if left is not None and top is not None:
            item["left"], item["top"] = left, top
        texts.append(item)

    for note in _lines(data.get("assumptions")):
        warnings.append(f"AI ระบุไว้: {note}")
    if not nodes:
        raise EveError("ไม่พบ node ที่ใช้ได้ใน JSON (ต้องมี \"nodes\" อย่างน้อย 1 รายการ)")
    return {"lab": lab, "nodes": nodes, "links": links, "texts": texts}, warnings


def parse_import(text):
    return normalize_topology(extract_json(text))
