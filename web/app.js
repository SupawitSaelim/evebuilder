"use strict";

const $ = (id) => document.getElementById(id);
const NODE_W = 90, NODE_H = 50;

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "value") e.value = v; else e.setAttribute(k, v);
  }
  children.forEach((c) => e.append(c));
  return e;
}

/* ───────── feedback: toast, log drawer, busy state, dialogs ───────── */

// action = { label, run } adds a button to the toast (e.g. "ย้อนกลับ" after a delete)
function toast(message, kind = "info", action = null) {
  const t = el("div", { class: `toast ${kind}`, role: kind === "error" ? "alert" : "status" }, [el("span", {}, [message])]);
  if (action) {
    t.classList.add("has-action");
    const button = el("button", { class: "toast-action", type: "button" }, [action.label]);
    button.addEventListener("click", () => { action.run(); t.remove(); });
    t.append(button);
  }
  $("toasts").append(t);
  const life = action ? 8000 : kind === "error" ? 7000 : 4000;
  setTimeout(() => t.classList.add("out"), life);
  setTimeout(() => t.remove(), life + 400);
}

const firstLine = (text) => (text.split("\n").find((l) => l.trim()) || "").slice(0, 140);

function log(lines, kind = "info", toastText) {
  const text = (Array.isArray(lines) ? lines : [lines]).join("\n");
  $("log").textContent = text;
  const list = $("logList");
  list.querySelector(".empty")?.remove();
  const time = new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  list.prepend(el("article", { class: `log-entry ${kind}` }, [el("time", {}, [time]), el("pre", {}, [text])]));
  if ($("logDrawer").hidden) $("btnLogs").querySelector(".new-dot").hidden = false;
  toast(toastText ?? firstLine(text), kind);
}

async function run(fn) {
  document.body.classList.add("busy");
  try { await fn(); } catch (e) { log(e.message, "error"); } finally { document.body.classList.remove("busy"); }
}

async function post(path, body) {
  let res;
  try {
    res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    throw new Error("ติดต่อเซิร์ฟเวอร์ web_app.py ไม่ได้ (ยังรันอยู่ใน terminal หรือไม่?)");
  }
  return res.json();
}

function confirmDialog(message, { title = "ยืนยัน", ok = "ตกลง", danger = false, typeToConfirm = "" } = {}) {
  const dialog = $("confirmDialog");
  $("confirmTitle").textContent = title;
  $("confirmMsg").textContent = message;
  const button = $("confirmOk"), input = $("confirmType");
  button.textContent = ok;
  button.className = `btn ${danger ? "danger-soft" : "primary"}`;
  // for destructive actions the user must type a name back before the button unlocks
  $("confirmTypeWrap").hidden = !typeToConfirm;
  input.value = "";
  button.disabled = !!typeToConfirm;
  input.oninput = typeToConfirm ? () => { button.disabled = input.value.trim() !== typeToConfirm; } : null;
  if (typeToConfirm) $("confirmTypeLabel").textContent = `พิมพ์ “${typeToConfirm}” เพื่อยืนยัน`;
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true });
    dialog.showModal();
    if (typeToConfirm) input.focus();
  });
}

$("btnLogs").addEventListener("click", () => {
  const drawer = $("logDrawer");
  drawer.hidden = !drawer.hidden;
  if (!drawer.hidden) $("btnLogs").querySelector(".new-dot").hidden = true;
});
$("btnLogClose").addEventListener("click", () => { $("logDrawer").hidden = true; });
document.addEventListener("keydown", (evt) => { if (evt.key === "Escape") $("logDrawer").hidden = true; });

/* ───────── navigation ───────── */

const VIEWS = ["start", "design", "deploy", "labs", "connect"];

function showView(name) {
  if (!VIEWS.includes(name)) name = "start";
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== name;
  for (const a of document.querySelectorAll("#nav a")) {
    if (a.dataset.view === name) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  }
  window.scrollTo(0, 0);
  if (name === "design") scheduleRedraw();
  if (name === "deploy") { refreshDeploySummary(); checkLabState(); }
}
window.addEventListener("hashchange", () => showView(location.hash.slice(1)));

const segButtons = [...document.querySelectorAll(".segmented button")];
function selectSeg(name, focus = false) {
  for (const b of segButtons) {
    const on = b.dataset.seg === name;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on));
    b.tabIndex = on ? 0 : -1;
    $(`seg-${b.dataset.seg}`).hidden = !on;
    if (on && focus) b.focus();
  }
}
for (const button of segButtons) {
  button.addEventListener("click", () => selectSeg(button.dataset.seg));
  // arrow keys move between tabs (standard tablist keyboard pattern)
  button.addEventListener("keydown", (evt) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[evt.key];
    let i = segButtons.indexOf(button);
    if (step) i = (i + step + segButtons.length) % segButtons.length;
    else if (evt.key === "Home") i = 0;
    else if (evt.key === "End") i = segButtons.length - 1;
    else return;
    evt.preventDefault();
    selectSeg(segButtons[i].dataset.seg, true);
  });
}

/* ───────── connection state ───────── */

let connState = "idle";
function setConn(state, text) {
  connState = state;
  $("statusPill").dataset.state = state;
  $("statusText").textContent = text;
}

const readEve = () => ({ host: $("host").value.trim(), username: $("username").value.trim(), https: $("https").checked });

// "EVE-NG" menu item: opens the EVE-NG web GUI at the host/HTTPS currently set on the connect page
const HOST_OK = /^[A-Za-z0-9.\-]+(:\d{1,5})?$/;
function updateEveLink() {
  const link = $("navEve"), { host, https } = readEve();
  const ok = HOST_OK.test(host);
  link.target = ok ? "_blank" : "_self";
  if (ok) {
    link.href = `${https ? "https" : "http"}://${host}/`;
    link.title = `เปิดหน้าเว็บ EVE-NG: ${link.href}`;
  } else {
    link.href = "#connect";
    link.title = "ตั้งค่า host ในหน้าเชื่อมต่อก่อน";
  }
}

$("navEve").addEventListener("click", (evt) => {
  if (!HOST_OK.test(readEve().host)) {
    evt.preventDefault();
    toast("ใส่ host ของ EVE-NG ในหน้าเชื่อมต่อก่อน", "error");
    location.hash = "#connect";
  }
});

for (const id of ["host", "username", "https"]) {
  $(id).addEventListener("input", () => { setConn("idle", "ยังไม่ได้ทดสอบการเชื่อมต่อ"); updateEveLink(); });
}

async function testConnection() {
  const out = $("testResult");
  out.className = "test-result";
  out.textContent = "กำลังทดสอบ…";
  const res = await post("/api/test", { eve: readEve() });
  if (res.ok) {
    out.className = "test-result ok";
    out.textContent = res.message;
    setConn("ok", `เชื่อมต่อแล้ว · ${$("host").value.trim()}`);
    if (res.images && res.images.length) {
      setImages(res.images);
      $("imageNote").textContent = `พบ IOL image ${res.images.length} รายการ จะแสดงเป็นตัวเลือกในหน้าออกแบบ`;
    }
  } else {
    out.className = "test-result bad";
    out.textContent = `เชื่อมต่อไม่สำเร็จ: ${res.error || "ไม่ทราบสาเหตุ"}`;
    setConn("fail", "เชื่อมต่อไม่ได้");
  }
}

$("btnTest").addEventListener("click", () => run(testConnection));

/* ───────── server load (CPU / MEM) in the nav ───────── */

const STATS_EVERY_MS = 30000;
let statsBusy = false;

function showStat(id, value) {
  const node = $(id), n = Number(value);
  const ok = value !== null && value !== undefined && Number.isFinite(n);
  node.textContent = ok ? `${n}%` : "–";
  node.classList.toggle("warn", ok && n >= 85);
}

async function refreshStats() {
  if (statsBusy || document.hidden || !HOST_OK.test(readEve().host)) return;
  statsBusy = true;
  try {
    const res = await post("/api/stats", { eve: readEve() });
    if (res.busy) return;
    $("navStats").hidden = false;
    showStat("statCpu", res.ok ? res.cpu : null);
    showStat("statMem", res.ok ? res.mem : null);
  } catch (e) {
    showStat("statCpu", null);
    showStat("statMem", null);
  } finally {
    statsBusy = false;
  }
}

setInterval(refreshStats, STATS_EVERY_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshStats(); });

/* ───────── form state ───────── */

// formDirty = the form holds work that is not on EVE-NG yet; such work is also kept as a draft in localStorage
let formDirty = false;
const markDirty = () => { formDirty = true; };

const DRAFT_KEY = "eveBuilder.draft.v1";
let pendingDraft = null; // a draft from an earlier visit the user has not restored or discarded yet

function readDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
    return draft && draft.topology && Array.isArray(draft.topology.nodes) ? draft : null;
  } catch (e) { return null; }
}

function clearDraft() {
  if (pendingDraft) return; // the old draft stays until the user answers the banner
  try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* storage blocked: nothing to clear */ }
}

// Same as readTopology(), but rows still placed automatically are saved without a position so they stay automatic
function formSnapshot() {
  const t = readTopology();
  const strip = (items, rows) => items.map((item, i) => {
    if (rows[i]?.dataset.auto !== "1") return item;
    const { left, top, ...rest } = item;
    return rest;
  });
  return { ...t, nodes: strip(t.nodes, lastRows.nodes), texts: strip(t.texts, lastRows.texts) };
}

function saveDraft() {
  if (!formDirty || pendingDraft) return; // never overwrite a draft the user has not answered yet
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ savedAt: Date.now(), topology: formSnapshot() })); } catch (e) { /* storage full or blocked */ }
}

// The form now matches EVE-NG (just built, synced or loaded from it): nothing left to protect
function markClean() {
  formDirty = false;
  clearDraft();
}

function offerDraft(draft) {
  pendingDraft = draft;
  const t = draft.topology;
  const when = new Date(draft.savedAt).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" });
  $("draftText").textContent = `พบงานออกแบบ “${t.lab?.name || "ไม่มีชื่อ"}” (${t.nodes.length} อุปกรณ์, ${(t.links || []).length} สาย) ที่ยังไม่ได้สร้างเป็น lab บันทึกไว้เมื่อ ${when}`;
  $("draftBanner").hidden = false;
}

$("btnDraftRestore").addEventListener("click", async () => {
  const draft = pendingDraft;
  if (!draft) return;
  pendingDraft = null;
  $("draftBanner").hidden = true;
  if (!(await confirmReplace("กู้คืนงานที่บันทึกไว้"))) { pendingDraft = draft; $("draftBanner").hidden = false; return; }
  loadTopology({ texts: [], links: [], ...draft.topology, lab: { name: "", ...draft.topology.lab } });
  formDirty = true;
  saveDraft();
  toast("กู้คืนงานที่บันทึกไว้แล้ว", "ok");
  location.hash = "#design";
});

$("btnDraftDiscard").addEventListener("click", () => {
  pendingDraft = null;
  $("draftBanner").hidden = true;
  clearDraft();
  saveDraft(); // keep whatever was edited while the banner was up
});

window.addEventListener("beforeunload", (evt) => {
  if (!formDirty) return;
  saveDraft();
  evt.preventDefault();
  evt.returnValue = "";
});

async function confirmReplace(what) {
  if (!formDirty) return true;
  return confirmDialog(`${what}\nข้อมูลที่แก้ไว้ในหน้าออกแบบตอนนี้จะถูกแทนที่`, { title: "แทนที่ข้อมูลในฟอร์ม?", ok: "แทนที่" });
}

/* ───────── editor rows ───────── */

function nodeNames() {
  return [...$("nodes").rows].map((r) => r.querySelector(".n-name").value.trim()).filter(Boolean);
}

// A name that no longer matches any node stays selected (marked) so validation reports it instead of silently re-wiring
function nodeSelect(value, cls) {
  const sel = el("select", { class: cls });
  const names = nodeNames();
  names.forEach((n) => sel.append(el("option", { value: n }, [n])));
  if (value && !names.includes(value)) sel.append(el("option", { value }, [`${value} (ไม่มีอุปกรณ์นี้)`]));
  sel.value = value || names[0] || "";
  sel.classList.toggle("bad", !!value && !names.includes(value));
  return sel;
}

const linkRowsOf = (name) => [...$("links").rows].filter((r) => r.querySelector(".l-src").value === name || r.querySelector(".l-dst").value === name);

// Deleting a node also deletes its links; a toast offers to put everything back
function delButton(tr, kind) {
  const b = el("button", { class: "del-btn", type: "button", "aria-label": "ลบ", title: "ลบ" }, ["✕"]);
  b.addEventListener("click", () => {
    const name = kind === "node" ? tr.querySelector(".n-name").value.trim() : "";
    const rows = [tr, ...(name ? linkRowsOf(name) : [])];
    const removed = rows.map((row) => ({ row, parent: row.parentNode, next: row.nextSibling }));
    rows.forEach((row) => row.remove());
    markDirty(); refreshLinkSelects(); scheduleRedraw();
    const what = kind === "node" ? `ลบ ${name || "อุปกรณ์"}${rows.length > 1 ? ` และสายที่ต่ออยู่ ${rows.length - 1} เส้น` : ""}`
      : kind === "link" ? "ลบการเชื่อมต่อแล้ว" : "ลบข้อความแล้ว";
    toast(what, "info", {
      label: "ย้อนกลับ",
      run: () => {
        for (const { row, parent, next } of removed.reverse()) {
          if (next && next.parentNode === parent) parent.insertBefore(row, next); else parent.append(row);
        }
        markDirty(); refreshLinkSelects(); scheduleRedraw();
      },
    });
  });
  return b;
}

function addNodeRow(n = {}) {
  const tr = el("tr");
  const cell = (...children) => el("td", {}, children);
  const pc = n.type === "vpcs";
  const typeSelect = el("select", { class: "n-type" }, [
    el("option", { value: "iol" }, ["Router / Switch"]),
    el("option", { value: "vpcs" }, ["PC (VPCS)"]),
  ]);
  typeSelect.value = pc ? "vpcs" : "iol";
  // rows that arrive without a position are placed automatically until the user drags them
  tr.dataset.auto = n.left === undefined || n.top === undefined ? "1" : "0";
  // the node's startup-config: a full-width box under the row, opened with the "Config" button
  const cfgArea = el("textarea", { class: "n-cfg", rows: 8, spellcheck: "false",
    placeholder: pc ? "set pcname PC1\nip 10.1.1.10/24 10.1.1.1" : "hostname R1\nno ip domain-lookup\ninterface e0/0\n ip address 10.1.1.1 255.255.255.0\n no shutdown" });
  cfgArea.value = n.startup_config || "";
  const cfgCell = el("td", { class: "cfg-cell", hidden: "" }, [cfgArea, el("p", { class: "cfg-note" })]);
  const cfgButton = el("button", { class: "cfg-btn", type: "button", "aria-expanded": "false", title: "Config ตั้งต้นของเครื่องนี้" }, ["Config"]);
  const dupButton = el("button", { class: "dup-btn", type: "button", "aria-label": "คัดลอกแถว", title: "คัดลอกเป็นเครื่องใหม่" }, ["⧉"]);
  tr.append(
    cell(el("input", { class: "n-name", value: n.name || uniqueName(pc ? "PC" : "NODE-") }),
      el("input", { class: "n-left", type: "hidden", value: n.left ?? 0 }),
      el("input", { class: "n-top", type: "hidden", value: n.top ?? 0 })),
    cell(typeSelect),
    cell(el("input", { class: "n-image", list: "images", value: n.image || "x86_64_crb_linux-adventerprisek9-ms.bin" })),
    cell(el("input", { class: "n-eth", type: "number", min: 1, max: 16, value: n.ethernet ?? 2 })),
    el("td", { class: "row-actions" }, [cfgButton, dupButton, delButton(tr, "node")]),
    cfgCell,
  );
  cfgButton.addEventListener("click", () => toggleConfig(tr));
  dupButton.addEventListener("click", () => duplicateNode(tr));
  cfgArea.addEventListener("input", () => markConfig(tr));
  markConfig(tr);
  // renaming a node carries its links along to the new name
  const nameInput = tr.querySelector(".n-name");
  nameInput.dataset.prev = nameInput.value.trim();
  nameInput.addEventListener("change", () => {
    const old = nameInput.dataset.prev, now = nameInput.value.trim();
    nameInput.dataset.prev = now;
    if (old && now && old !== now && !nodeNames().includes(old)) {
      for (const r of $("links").rows) {
        for (const cls of [".l-src", ".l-dst"]) {
          const sel = r.querySelector(cls);
          if (sel.value === old) { sel.append(el("option", { value: now }, [now])); sel.value = now; }
        }
      }
    }
    refreshLinkSelects();
  });
  typeSelect.addEventListener("change", () => applyNodeType(tr));
  applyNodeType(tr);
  $("nodes").append(tr);
  refreshLinkSelects();
  scheduleRedraw();
  return tr;
}

/* ───────── startup config, duplicate, bulk add ───────── */

// IOL images that EVE-NG boots with a startup-config (tested on EVE-NG 6.2); PCs always can
const CONFIG_IMAGE_PREFIXES = ["x86_64_crb_linux"];
const configLoads = (tr) => tr.querySelector(".n-type").value === "vpcs"
  || CONFIG_IMAGE_PREFIXES.some((p) => tr.querySelector(".n-image").value.trim().toLowerCase().startsWith(p));

function markConfig(tr) {
  const lines = tr.querySelector(".n-cfg").value.split("\n").filter((l) => l.trim()).length;
  const button = tr.querySelector(".cfg-btn");
  button.classList.toggle("has", lines > 0);
  button.textContent = lines ? `Config · ${lines}` : "Config";
  const note = tr.querySelector(".cfg-note"), loads = configLoads(tr);
  note.classList.toggle("warn", lines > 0 && !loads);
  note.textContent = loads
    ? "ระบบจะโหลดเป็น startup-config ให้ตอนเปิดเครื่องครั้งแรก (ตัดบรรทัด enable, conf t, end, write memory ออกให้เอง)"
    : "image นี้โหลด startup-config ไม่ได้ ระบบจะวาง config เป็นกล่องข้อความในผังให้ copy ไปวางใน console แทน";
}

function toggleConfig(tr, open) {
  const cellEl = tr.querySelector(".cfg-cell"), button = tr.querySelector(".cfg-btn");
  const show = open ?? cellEl.hidden;
  cellEl.hidden = !show;
  button.setAttribute("aria-expanded", String(show));
  if (show) tr.querySelector(".n-cfg").focus({ preventScroll: true });
}

// "R1" -> "R2", "SW01" -> "SW02" (next free number, same digit count); names without a number get one appended
function uniqueName(base) {
  const names = new Set(nodeNames());
  const match = /^(.*?)(\d+)$/.exec(base);
  const prefix = match ? match[1] : base, digits = match ? match[2].length : 1;
  let n = match ? Number(match[2]) : 1;
  const name = () => `${prefix}${String(n).padStart(digits, "0")}`;
  while (names.has(name())) n++;
  return name();
}

function duplicateNode(tr) {
  const name = tr.querySelector(".n-name").value.trim() || "NODE-1";
  const pc = tr.querySelector(".n-type").value === "vpcs";
  const copy = addNodeRow({
    name: uniqueName(name), type: pc ? "vpcs" : undefined,
    image: tr.querySelector(".n-image").value.trim(), ethernet: Number(tr.querySelector(".n-eth").value) || 2,
  });
  tr.after(copy);
  markDirty(); scheduleRedraw();
  focusRow("node", copy);
  const hasConfig = tr.querySelector(".n-cfg").value.trim();
  toast(`คัดลอก ${name} เป็น ${copy.querySelector(".n-name").value}${hasConfig ? " (ไม่ได้คัดลอก config เพราะ IP จะซ้ำกัน)" : ""}`, "ok");
}

const DEFAULT_IMAGES = { router: "x86_64_crb_linux-adventerprisek9-ms.bin", switch: "x86_64_crb_linux_l2-adventerprisek9-ms.bin" };
const BULK_PREFIX = { router: "R", switch: "SW", vpcs: "PC" };

function bulkNames() {
  const prefix = $("bulkPrefix").value.trim().replace(/[^A-Za-z0-9_\-.]+/g, "");
  const count = Math.min(20, Math.max(1, Math.floor(Number($("bulkCount").value)) || 1));
  const names = new Set(nodeNames()), out = [];
  for (let n = 1; out.length < count && n < 1000; n++) if (!names.has(`${prefix}${n}`)) out.push(`${prefix}${n}`);
  return prefix ? out : [];
}

function updateBulkPreview() {
  const names = bulkNames();
  $("bulkOk").disabled = !names.length;
  $("bulkPreview").textContent = names.length ? `จะเพิ่ม: ${names.join(", ")}` : "ใส่ชื่อขึ้นต้นเป็นตัวอักษรอังกฤษหรือตัวเลข";
}
$("bulkType").addEventListener("change", () => { $("bulkPrefix").value = BULK_PREFIX[$("bulkType").value]; updateBulkPreview(); });
$("bulkPrefix").addEventListener("input", updateBulkPreview);
$("bulkCount").addEventListener("input", updateBulkPreview);

$("addBulk").addEventListener("click", async () => {
  const dialog = $("bulkDialog");
  updateBulkPreview();
  const ok = await new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true });
    dialog.showModal();
  });
  const names = bulkNames();
  if (!ok || !names.length) return;
  const type = $("bulkType").value;
  names.forEach((name) => addNodeRow(type === "vpcs" ? { name, type: "vpcs" }
    : { name, image: DEFAULT_IMAGES[type], ethernet: type === "switch" ? 4 : 2 }));
  markDirty(); scheduleRedraw();
  toast(`เพิ่ม ${names.length} เครื่อง: ${names[0]}–${names[names.length - 1]}`, "ok");
});

// A PC has one fixed port and no image, so those inputs are greyed out for it
function applyNodeType(tr) {
  const pc = tr.querySelector(".n-type").value === "vpcs";
  for (const cls of [".n-image", ".n-eth"]) tr.querySelector(cls).disabled = pc;
}

/* ───────── port dropdowns ───────── */

// IOL: each port group gives 4 ports (group 0 -> e0/0..e0/3, group 1 -> e1/0..e1/3); a PC has only eth0
function portOptions(info) {
  if (!info) return [];
  if (info.kind === "vpcs") return ["eth0"];
  const out = [];
  for (let g = 0; g < info.groups; g++) for (let p = 0; p < 4; p++) out.push(`e${g}/${p}`);
  return out;
}

function nodeInfo() {
  const map = new Map();
  for (const r of $("nodes").rows) {
    const name = r.querySelector(".n-name").value.trim();
    if (!name || map.has(name)) continue;
    const groups = Math.min(16, Math.max(1, Math.floor(Number(r.querySelector(".n-eth").value)) || 2));
    map.set(name, { kind: r.querySelector(".n-type").value, groups });
  }
  return map;
}

// Rebuild every port <select>: only ports the device really has, ports used by another link disabled,
// an empty choice filled with the first free port, and an impossible value kept but flagged (red) for validation
function refreshPorts() {
  const info = nodeInfo();
  const key = (node, port) => `${node}\u0000${port.toLowerCase()}`;
  const ends = [];
  for (const r of $("links").rows) {
    for (const [nodeCls, portCls] of [[".l-src", ".l-sif"], [".l-dst", ".l-dif"]]) {
      const sel = r.querySelector(portCls), node = r.querySelector(nodeCls).value, i = info.get(node);
      let value = (sel.dataset.want ?? sel.value ?? "").trim();
      if (i?.kind === "vpcs") value = "eth0";
      else if (i && /^eth\d*$/i.test(value)) value = ""; // was a PC port, the device is now a router/switch
      ends.push({ sel, node, info: i, value });
    }
  }
  const used = new Map();
  const use = (e) => used.set(key(e.node, e.value), (used.get(key(e.node, e.value)) || 0) + 1);
  ends.filter((e) => e.value).forEach(use);
  for (const e of ends) {
    if (e.value || !e.info) continue;
    const options = portOptions(e.info);
    e.value = options.find((p) => !used.has(key(e.node, p))) || options[0] || "";
    if (e.value) use(e);
  }
  for (const e of ends) {
    const options = portOptions(e.info);
    const list = !e.value || options.includes(e.value) ? options : [...options, e.value];
    const labels = list.map((p) => {
      const others = (used.get(key(e.node, p)) || 0) - (p === e.value ? 1 : 0);
      return { p, missing: !options.includes(p), taken: others > 0 };
    });
    const sig = labels.map((o) => `${o.p}${o.missing ? "!" : ""}${o.taken ? "*" : ""}`).join(",");
    if (e.sel.dataset.sig !== sig) {
      e.sel.replaceChildren(...labels.map((o) => {
        const opt = el("option", { value: o.p }, [o.p + (o.missing ? " (ไม่มีพอร์ตนี้)" : o.taken ? " (ใช้แล้ว)" : "")]);
        opt.disabled = o.taken && o.p !== e.value;
        return opt;
      }));
      e.sel.dataset.sig = sig;
    }
    delete e.sel.dataset.want;
    e.sel.value = e.value;
    const mine = labels.find((o) => o.p === e.value);
    e.sel.classList.toggle("bad", !!mine && (mine.missing || mine.taken));
  }
}

function addLinkRow(l = {}) {
  const tr = el("tr");
  const cell = (child) => el("td", {}, [child]);
  const names = nodeNames();
  const source = l.source ?? names[0];
  const destination = l.destination ?? (names.find((n) => n !== source) || names[0]);
  const port = (cls, value) => { const sel = el("select", { class: cls }); sel.dataset.want = value || ""; return sel; };
  tr.append(
    cell(nodeSelect(source, "l-src")),
    cell(port("l-sif", l.source_interface)),
    cell(nodeSelect(destination, "l-dst")),
    cell(port("l-dif", l.destination_interface)),
    cell(delButton(tr, "link")),
  );
  $("links").append(tr);
  refreshPorts();
  scheduleRedraw();
}

function refreshLinkSelects() {
  for (const r of $("links").rows) {
    for (const cls of [".l-src", ".l-dst"]) {
      const old = r.querySelector(cls);
      old.replaceWith(nodeSelect(old.value, cls.slice(1)));
    }
  }
}

function addTextRow(t = {}) {
  const tr = el("tr");
  const cell = (...children) => el("td", {}, children);
  const area = el("textarea", { class: "t-text", rows: 3, spellcheck: "false" });
  area.value = t.text || "";
  tr.dataset.auto = t.left === undefined || t.top === undefined ? "1" : "0";
  tr.append(
    cell(area,
      el("input", { class: "t-left", type: "hidden", value: t.left ?? 0 }),
      el("input", { class: "t-top", type: "hidden", value: t.top ?? 0 })),
    cell(delButton(tr, "text")),
  );
  $("texts").append(tr);
  scheduleRedraw();
}

/* ───────── automatic layout ───────── */

const GAP_X = 220, GAP_Y = 170, X0 = 100, Y0 = 80;
// Thai vowels and tone marks above/below a letter take no width of their own
const visibleLength = (s) => s.replace(/[ัิ-ฺ็-๎]/g, "").length;
const rowValue = (row, cls) => Number(row.querySelector(cls).value) || 0;

// Lay nodes out in layers by link distance from the best-connected node; only touches rows still marked auto
function autoPlace() {
  const rows = [...$("nodes").rows];
  const index = new Map();
  rows.forEach((r, i) => { const n = r.querySelector(".n-name").value.trim(); if (n && !index.has(n)) index.set(n, i); });
  const adj = rows.map(() => new Set());
  for (const r of $("links").rows) {
    const a = index.get(r.querySelector(".l-src").value), b = index.get(r.querySelector(".l-dst").value);
    if (a !== undefined && b !== undefined && a !== b) { adj[a].add(b); adj[b].add(a); }
  }

  const layer = rows.map(() => -1);
  let offset = 0;
  for (const start of [...rows.keys()].sort((x, y) => adj[y].size - adj[x].size || x - y)) {
    if (layer[start] !== -1) continue;
    layer[start] = offset;
    let deepest = offset;
    const queue = [start];
    while (queue.length) {
      const u = queue.shift();
      for (const v of adj[u]) if (layer[v] === -1) { layer[v] = layer[u] + 1; deepest = Math.max(deepest, layer[v]); queue.push(v); }
    }
    offset = deepest + 1;
  }

  const levels = [];
  layer.forEach((l, i) => { (levels[l] = levels[l] || []).push(i); });
  const rank = rows.map(() => 0);
  levels.forEach((items, l) => {
    if (l > 0) {
      const key = (i) => {
        const parents = [...adj[i]].filter((v) => layer[v] === l - 1);
        return parents.length ? parents.reduce((s, v) => s + rank[v], 0) / parents.length : i;
      };
      items.sort((a, b) => key(a) - key(b) || a - b);
    }
    items.forEach((i, k) => { rank[i] = k; });
  });

  const centerX = X0 + ((Math.max(1, ...levels.map((l) => l.length)) - 1) * GAP_X) / 2;
  const placed = rows.filter((r) => r.dataset.auto !== "1").map((r) => ({ x: rowValue(r, ".n-left"), y: rowValue(r, ".n-top") }));
  levels.forEach((items, l) => items.forEach((i, k) => {
    const row = rows[i];
    if (row.dataset.auto !== "1") return;
    let x = centerX - ((items.length - 1) * GAP_X) / 2 + k * GAP_X;
    const y = Y0 + l * GAP_Y;
    // slide right past anything already on the canvas (dragged nodes and earlier auto nodes)
    for (let tries = 0; tries < 30 && placed.some((f) => Math.abs(f.x - x) < NODE_W + 40 && Math.abs(f.y - y) < NODE_H + 40); tries++) x += GAP_X;
    placed.push({ x, y });
    row.querySelector(".n-left").value = Math.round(x);
    row.querySelector(".n-top").value = y;
  }));

  // auto texts are laid out in rows below the lowest node, wrapping at the diagram's right edge
  const textTop = Math.max(0, ...rows.map((r) => rowValue(r, ".n-top"))) + 150;
  const rightEdge = Math.max(900, ...rows.map((r) => rowValue(r, ".n-left") + 200));
  let x = 50, y = textTop, rowHeight = 0;
  for (const r of $("texts").rows) {
    const text = r.querySelector(".t-text").value.replace(/\s+$/, "");
    if (r.dataset.auto !== "1" || !text.trim()) continue;
    const lines = text.split("\n");
    const width = Math.max(150, Math.max(...lines.map(visibleLength)) * 9 + 20);
    if (x > 50 && x + width > rightEdge) { x = 50; y += rowHeight + 30; rowHeight = 0; }
    r.querySelector(".t-left").value = x;
    r.querySelector(".t-top").value = y;
    x += width + 30;
    rowHeight = Math.max(rowHeight, lines.length * 24 + 8);
  }
}

/* ───────── topology <-> form ───────── */

// DOM rows behind the arrays returned by readTopology(), used to map preview drags back to the form
let lastRows = { nodes: [], links: [], texts: [] };

function readTopology() {
  refreshPorts();
  autoPlace();
  const nodeRows = [...$("nodes").rows];
  const nodes = nodeRows.map((r) => {
    const node = { name: r.querySelector(".n-name").value.trim(), left: rowValue(r, ".n-left"), top: rowValue(r, ".n-top") };
    const config = r.querySelector(".n-cfg").value.replace(/\s+$/, "");
    if (config.trim()) node.startup_config = config;
    if (r.querySelector(".n-type").value === "vpcs") return { ...node, type: "vpcs" };
    return { ...node, image: r.querySelector(".n-image").value.trim(), ethernet: Number(r.querySelector(".n-eth").value) || 2 };
  });
  const linkRows = [...$("links").rows];
  const links = linkRows.map((r) => ({
    source: r.querySelector(".l-src").value,
    source_interface: r.querySelector(".l-sif").value.trim(),
    destination: r.querySelector(".l-dst").value,
    destination_interface: r.querySelector(".l-dif").value.trim(),
  }));
  const textRows = [...$("texts").rows].filter((r) => r.querySelector(".t-text").value.trim());
  const texts = textRows.map((r) => ({
    text: r.querySelector(".t-text").value.replace(/\s+$/, ""),
    left: rowValue(r, ".t-left"),
    top: rowValue(r, ".t-top"),
  }));
  lastRows = { nodes: nodeRows, links: linkRows, texts: textRows };
  return {
    lab: { name: $("labName").value.trim(), description: $("labDesc").value.trim(), path: $("labDir").value.trim() || "/" },
    nodes, links, texts,
  };
}

function loadTopology(t) {
  $("labName").value = t.lab.name;
  if (t.lab.path) $("labDir").value = t.lab.path;
  $("labDesc").value = t.lab.description || "";
  for (const id of ["nodes", "links", "texts"]) $(id).replaceChildren();
  t.nodes.forEach(addNodeRow);
  t.links.forEach(addLinkRow);
  t.texts.forEach(addTextRow);
  markClean();
  showVerify({});
  resetZoom();
  scheduleRedraw();
}

function showNotice(title, lines) {
  $("notice").hidden = !lines.length;
  if (!lines.length) return;
  $("noticeTitle").textContent = title;
  $("noticeList").replaceChildren(...lines.map((l) => el("li", {}, [l])));
}
$("noticeClose").addEventListener("click", () => { $("notice").hidden = true; });

// Show an imported topology in the design view, with anything the importer changed or skipped.
// fromEve = loaded from a lab on EVE-NG (nothing to lose); otherwise (AI import) it is kept as a draft
function applyImported(t, warnings, title, fromEve = false) {
  loadTopology(t);
  if (!fromEve) { markDirty(); saveDraft(); }
  showNotice("สิ่งที่ระบบปรับหรือข้ามให้ (ตรวจดูว่าตรงกับโจทย์)", warnings);
  log([`${title}: ${t.nodes.length} อุปกรณ์, ${t.links.length} การเชื่อมต่อ, ${t.texts.length} ข้อความ`,
    ...(warnings.length ? ["", ...warnings] : [])], "ok", `${title} (${t.nodes.length} อุปกรณ์, ${t.links.length} สาย)`);
  location.hash = "#design";
}

/* ───────── image list from EVE-NG ───────── */

let knownImages = null;
function setImages(list) {
  knownImages = new Set(list);
  $("images").replaceChildren(...list.map((v) => el("option", { value: v })));
  markImages();
}

const unknownImageRows = () => [...$("nodes").rows].filter((r) => knownImages
  && r.querySelector(".n-type").value !== "vpcs" && !knownImages.has(r.querySelector(".n-image").value.trim()));

function markImages() {
  const bad = new Set(unknownImageRows());
  for (const r of $("nodes").rows) {
    const input = r.querySelector(".n-image");
    input.classList.toggle("bad", bad.has(r));
    input.title = bad.has(r) ? "ไม่พบ image นี้บน EVE-NG" : "";
  }
}

/* ───────── diagram ───────── */

let frozenBox = null;
// zoomBox is the view the user zoomed/panned to; null means "fit everything"
let zoomBox = null, fitBox = null;
const ZOOM_MIN_FACTOR = 1 / 8, ZOOM_MAX_FACTOR = 3;

const boxToString = (b) => `${b.x} ${b.y} ${b.w} ${b.h}`;
function currentBox() {
  const [x, y, w, h] = $("diagram").getAttribute("viewBox").split(/\s+/).map(Number);
  return { x, y, w, h };
}

function updateZoomLabel(box) {
  $("zoomLabel").textContent = `${Math.round(((fitBox ? fitBox.w : box.w) / box.w) * 100)}%`;
}

function applyBox(box) {
  zoomBox = box;
  $("diagram").setAttribute("viewBox", boxToString(box));
  updateZoomLabel(box);
}

// Scale the visible area by 1/factor around point p (in diagram units) so p stays under the cursor
function zoomAt(p, factor) {
  const box = currentBox();
  let k = 1 / factor;
  const width = box.w * k;
  if (fitBox && (width < fitBox.w * ZOOM_MIN_FACTOR || width > fitBox.w * ZOOM_MAX_FACTOR)) {
    k = Math.min(Math.max(width, fitBox.w * ZOOM_MIN_FACTOR), fitBox.w * ZOOM_MAX_FACTOR) / box.w;
  }
  applyBox({ x: p.x - (p.x - box.x) * k, y: p.y - (p.y - box.y) * k, w: box.w * k, h: box.h * k });
}

function resetZoom() {
  zoomBox = null;
  if (fitBox) { $("diagram").setAttribute("viewBox", boxToString(fitBox)); updateZoomLabel(fitBox); }
}

// Measure text with the font the diagram uses, so Thai (and any proportional fallback) gets a box that fits
let measureCtx = null;
function textWidth(line) {
  if (!measureCtx) {
    measureCtx = document.createElement("canvas").getContext("2d");
    measureCtx.font = `12px ${getComputedStyle(document.documentElement).getPropertyValue("--mono")}`;
  }
  return measureCtx ? measureCtx.measureText(line).width : visibleLength(line) * 7.2;
}
document.fonts?.ready.then(() => { measureCtx = null; scheduleRedraw(); });

const textBox = (t) => {
  const lines = t.text.split("\n");
  return { lines, width: Math.ceil(Math.max(...lines.map(textWidth))) + 16, height: lines.length * 16 + 8 };
};

// What the pointer is over in the form, mirrored in the diagram: { kind: "node" | "link" | "text", i }
let highlight = null;
function applyHighlight() {
  for (const g of $("diagram").querySelectorAll(".hl")) g.classList.remove("hl");
  if (highlight) $("diagram").querySelector(`[data-kind="${highlight.kind}"][data-i="${highlight.i}"]`)?.classList.add("hl");
}

function drawDiagram(topology) {
  const svg = $("diagram");
  svg.replaceChildren();
  const ns = "http://www.w3.org/2000/svg";
  const mk = (tag, attrs, text) => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const texts = topology.texts || [];
  const right = Math.max(500, ...topology.nodes.map((n) => n.left + NODE_W), ...texts.map((t) => t.left + textBox(t).width));
  const bottom = Math.max(300, ...topology.nodes.map((n) => n.top + NODE_H), ...texts.map((t) => t.top + textBox(t).height));
  fitBox = { x: -20, y: -20, w: right + 60, h: bottom + 60 };
  const box = zoomBox || fitBox;
  svg.setAttribute("viewBox", frozenBox || boxToString(box));
  updateZoomLabel(frozenBox ? currentBox() : box);
  const pos = {};
  topology.nodes.forEach((n) => { pos[n.name] = { x: n.left + NODE_W / 2, y: n.top + NODE_H / 2 }; });
  // links between the same two nodes are spread side by side instead of drawn on top of each other
  const pairKey = (l) => [l.source, l.destination].sort().join("\u0000");
  const pairTotal = new Map(), pairSeen = new Map();
  topology.links.forEach((l) => pairTotal.set(pairKey(l), (pairTotal.get(pairKey(l)) || 0) + 1));
  const SPREAD = 18;
  topology.links.forEach((l, i) => {
    const k = pairKey(l);
    const nth = pairSeen.get(k) || 0;
    pairSeen.set(k, nth + 1);
    const a0 = pos[l.source], b0 = pos[l.destination];
    if (!a0 || !b0 || l.source === l.destination) return;
    // offset perpendicular to the line, measured in a fixed direction so A->B and B->A links share one fan
    const [p, q] = l.source < l.destination ? [a0, b0] : [b0, a0];
    const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
    const off = (nth - (pairTotal.get(k) - 1) / 2) * SPREAD;
    const ox = (-(q.y - p.y) / len) * off, oy = ((q.x - p.x) / len) * off;
    const a = { x: a0.x + ox, y: a0.y + oy }, b = { x: b0.x + ox, y: b0.y + oy };
    const g = mk("g", { class: "dg-linkg", "data-kind": "link", "data-i": i });
    const ends = { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    g.append(mk("line", { class: "dg-hit", ...ends }), mk("line", { class: "dg-link", ...ends }));
    const label = (from, to, text) => g.append(mk("text", {
      class: "dg-port", x: from.x + (to.x - from.x) * 0.25, y: from.y + (to.y - from.y) * 0.25 - 4,
    }, text));
    label(a, b, l.source_interface);
    label(b, a, l.destination_interface);
    svg.append(g);
  });
  topology.nodes.forEach((n, i) => {
    const pc = n.type === "vpcs";
    const kind = pc ? "pc" : (n.image || "").toLowerCase().includes("l2") ? "l2" : "l3";
    const g = mk("g", { class: `dg-node ${kind}`, "data-kind": "node", "data-i": i });
    g.append(
      mk("rect", { x: n.left, y: n.top, width: NODE_W, height: NODE_H, rx: pc ? 22 : 10 }),
      mk("text", { x: n.left + NODE_W / 2, y: n.top + NODE_H / 2 + 4 }, n.name));
    svg.append(g);
  });
  texts.forEach((t, i) => {
    const { lines, width, height } = textBox(t);
    const g = mk("g", { class: "dg-text", "data-kind": "text", "data-i": i });
    g.append(mk("rect", { x: t.left, y: t.top, width, height, rx: 6 }));
    lines.forEach((line, k) => g.append(mk("text", { x: t.left + 8, y: t.top + 18 + k * 16 }, line)));
    svg.append(g);
  });
  applyHighlight();
}

// Jump from the diagram to the matching row in the form
function focusRow(kind, row) {
  if (!row) return;
  selectSeg({ node: "nodes", link: "links", text: "texts" }[kind]);
  row.classList.remove("flash");
  void row.offsetWidth; // restart the animation
  row.classList.add("flash");
  row.scrollIntoView({ block: "nearest", behavior: "smooth" });
  row.querySelector("input:not([type=hidden]), select, textarea")?.focus({ preventScroll: true });
}

// Hovering a row in the form highlights it in the diagram
for (const [tbodyId, kind] of [["nodes", "node"], ["links", "link"], ["texts", "text"]]) {
  $(tbodyId).addEventListener("mouseover", (evt) => {
    const tr = evt.target.closest("tr");
    const i = tr ? lastRows[tbodyId].indexOf(tr) : -1;
    highlight = i >= 0 ? { kind, i } : null;
    tr?.classList.add("hl");
    applyHighlight();
  });
  $(tbodyId).addEventListener("mouseout", (evt) => {
    const tr = evt.target.closest("tr");
    if (tr && !tr.contains(evt.relatedTarget)) { tr.classList.remove("hl"); highlight = null; applyHighlight(); }
  });
}

let drag = null, pan = null;
function svgPoint(evt) {
  const svg = $("diagram");
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX;
  pt.y = evt.clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}

$("diagram").addEventListener("pointerdown", (evt) => {
  const svg = $("diagram");
  const g = evt.target.closest("[data-kind]");
  if (!g) {
    // empty background: drag to pan the view
    pan = { x: evt.clientX, y: evt.clientY, box: currentBox() };
    svg.classList.add("panning");
    svg.setPointerCapture(evt.pointerId);
    evt.preventDefault();
    return;
  }
  const kind = g.dataset.kind;
  if (kind === "link") {
    // links are not draggable: a click just jumps to the row
    focusRow("link", lastRows.links[Number(g.dataset.i)]);
    evt.preventDefault();
    return;
  }
  const isNode = kind === "node";
  const row = (isNode ? lastRows.nodes : lastRows.texts)[Number(g.dataset.i)];
  if (!row) return;
  const left = row.querySelector(isNode ? ".n-left" : ".t-left"), top = row.querySelector(isNode ? ".n-top" : ".t-top");
  const p = svgPoint(evt);
  drag = { row, kind, left, top, dx: p.x - Number(left.value), dy: p.y - Number(top.value), startX: evt.clientX, startY: evt.clientY, moved: false };
  frozenBox = svg.getAttribute("viewBox");
  svg.setPointerCapture(evt.pointerId);
  evt.preventDefault();
});

$("diagram").addEventListener("pointermove", (evt) => {
  if (pan) {
    const rect = $("diagram").getBoundingClientRect();
    const unitsPerPixel = Math.max(pan.box.w / rect.width, pan.box.h / rect.height);
    applyBox({ ...pan.box, x: pan.box.x - (evt.clientX - pan.x) * unitsPerPixel, y: pan.box.y - (evt.clientY - pan.y) * unitsPerPixel });
    return;
  }
  if (!drag) return;
  // ignore jitter so a click does not count as a drag (which would pin the box in place)
  if (!drag.moved) {
    if (Math.hypot(evt.clientX - drag.startX, evt.clientY - drag.startY) < 4) return;
    pushLayout();
    drag.moved = true;
  }
  const p = svgPoint(evt);
  drag.left.value = Math.max(0, Math.round((p.x - drag.dx) / 10) * 10);
  drag.top.value = Math.max(0, Math.round((p.y - drag.dy) / 10) * 10);
  drag.row.dataset.auto = "0";
  markDirty();
  drawDiagram(readTopology());
});

for (const type of ["pointerup", "pointercancel"]) {
  $("diagram").addEventListener(type, () => {
    if (pan) { pan = null; $("diagram").classList.remove("panning"); return; }
    if (!drag) return;
    const { moved, kind, row } = drag;
    drag = null;
    frozenBox = null;
    if (!moved) { if (type === "pointerup") focusRow(kind, row); return; }
    drawDiagram(readTopology());
    saveDraft();
  });
}

// Wheel over the diagram zooms around the cursor (and stops the page from scrolling while it does)
$("diagram").addEventListener("wheel", (evt) => {
  evt.preventDefault();
  if (drag || pan) return;
  zoomAt(svgPoint(evt), Math.exp(-evt.deltaY * (evt.ctrlKey ? 0.01 : 0.0015)));
}, { passive: false });

const zoomFromCenter = (factor) => {
  const box = currentBox();
  zoomAt({ x: box.x + box.w / 2, y: box.y + box.h / 2 }, factor);
};
$("btnZoomIn").addEventListener("click", () => zoomFromCenter(1.3));
$("btnZoomOut").addEventListener("click", () => zoomFromCenter(1 / 1.3));
$("btnZoomFit").addEventListener("click", resetZoom);
$("diagram").addEventListener("dblclick", (evt) => { if (!evt.target.closest("[data-kind]")) resetZoom(); });

$("btnRelayout").addEventListener("click", () => {
  pushLayout();
  for (const row of [...$("nodes").rows, ...$("texts").rows]) row.dataset.auto = "1";
  resetZoom();
  drawDiagram(readTopology());
  saveDraft();
});

/* ───────── layout undo (Ctrl+Z) ───────── */

// Snapshots of every box position taken before a drag or "จัดตำแหน่งใหม่"; Ctrl+Z restores the last one
const layoutHistory = [];
const LAYOUT_HISTORY_MAX = 50;

function pushLayout() {
  const snap = [...$("nodes").rows, ...$("texts").rows].map((row) => {
    const node = !!row.querySelector(".n-left");
    return { row, auto: row.dataset.auto, left: row.querySelector(node ? ".n-left" : ".t-left").value, top: row.querySelector(node ? ".n-top" : ".t-top").value };
  });
  layoutHistory.push(snap);
  if (layoutHistory.length > LAYOUT_HISTORY_MAX) layoutHistory.shift();
}

function undoLayout() {
  const snap = layoutHistory.pop();
  if (!snap) { toast("ไม่มีการย้ายตำแหน่งให้ย้อนกลับ"); return; }
  for (const { row, auto, left, top } of snap) {
    if (!row.isConnected) continue; // row deleted since then
    const node = !!row.querySelector(".n-left");
    row.dataset.auto = auto;
    row.querySelector(node ? ".n-left" : ".t-left").value = left;
    row.querySelector(node ? ".n-top" : ".t-top").value = top;
  }
  markDirty();
  drawDiagram(readTopology());
  saveDraft();
  toast("ย้อนตำแหน่งในผังแล้ว");
}

document.addEventListener("keydown", (evt) => {
  if (!(evt.ctrlKey || evt.metaKey) || evt.shiftKey || evt.altKey || evt.key.toLowerCase() !== "z") return;
  if ($("view-design").hidden || document.querySelector("dialog[open]")) return;
  // inside a text field Ctrl+Z keeps its normal meaning (undo typing)
  if (evt.target.closest("input, textarea, select, [contenteditable]")) return;
  evt.preventDefault();
  undoLayout();
});

/* ───────── save diagram as PNG ───────── */

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const fileBase = () => ($("labName").value.trim() || "topology").replace(/[^A-Za-z0-9_\-]+/g, "_");

// The SVG gets its look from CSS variables, which a standalone image cannot see, so the computed styles are
// copied onto a clone, the whole diagram (not just the zoomed view) is drawn at 2x and saved as PNG
async function exportPng() {
  const saved = highlight;
  highlight = null;
  drawDiagram(readTopology());
  const svg = $("diagram"), clone = svg.cloneNode(true);
  const props = ["fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-linejoin", "paint-order", "font-family",
    "font-size", "font-weight", "text-anchor", "opacity"];
  const live = svg.querySelectorAll("*"), copies = clone.querySelectorAll("*");
  live.forEach((node, i) => {
    if (node.classList.contains("dg-hit")) { copies[i].remove(); return; } // invisible click targets
    const cs = getComputedStyle(node);
    copies[i].removeAttribute("class");
    copies[i].setAttribute("style", props.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(";"));
  });
  const box = fitBox;
  const scale = Math.min(2, 8000 / Math.max(box.w, box.h));
  const width = Math.round(box.w * scale), height = Math.round(box.h * scale);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("viewBox", boxToString(box));
  clone.setAttribute("width", width);
  clone.setAttribute("height", height);
  clone.removeAttribute("style");
  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  for (const [k, v] of Object.entries({ x: box.x, y: box.y, width: box.w, height: box.h, fill: getComputedStyle(svg).backgroundColor })) bg.setAttribute(k, v);
  clone.prepend(bg);
  highlight = saved;
  applyHighlight();

  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("แปลงผังเป็นรูปไม่สำเร็จ"));
      img.src = url;
    });
    const canvas = el("canvas", { width, height });
    canvas.getContext("2d").drawImage(img, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("แปลงผังเป็นรูปไม่สำเร็จ");
    downloadBlob(blob, `${fileBase()}.png`);
    toast(`บันทึก ${fileBase()}.png แล้ว`, "ok");
  } finally {
    URL.revokeObjectURL(url);
  }
}
$("btnPng").addEventListener("click", () => run(exportPng));

/* ───────── live validation ───────── */

function showProblems(list) {
  $("problems").replaceChildren(...list.map((p) => el("li", {}, [p])));
}

let designProblems = [];
function setChip(count, checking = false) {
  const chip = $("stateChip");
  if (checking) { chip.dataset.state = "busy"; chip.textContent = "กำลังตรวจ…"; return; }
  chip.dataset.state = count ? "warn" : "ok";
  chip.textContent = count ? `มี ${count} ปัญหา` : "พร้อมสร้าง";
}

let validateToken = 0;
async function validateNow() {
  const token = ++validateToken;
  const topology = readTopology();
  let problems;
  try {
    const res = await post("/api/validate", { topology });
    problems = res.problems || [res.error || "ตรวจสอบไม่สำเร็จ"];
  } catch (e) {
    problems = [e.message];
  }
  problems = [...problems, ...unknownImageRows().map((r) => `${r.querySelector(".n-name").value}: ไม่พบ image '${r.querySelector(".n-image").value}' บน EVE-NG`)];
  if (token === validateToken) {
    designProblems = problems;
    showProblems(problems);
    setChip(problems.length);
  }
  return problems;
}

function updateCounts() {
  $("countNodes").textContent = $("nodes").rows.length;
  $("countLinks").textContent = $("links").rows.length;
  $("countTexts").textContent = [...$("texts").rows].filter((r) => r.querySelector(".t-text").value.trim()).length;
}

let redrawTimer = null, validateTimer = null;
function scheduleRedraw() {
  clearTimeout(redrawTimer);
  redrawTimer = setTimeout(() => {
    markImages();
    for (const r of $("nodes").rows) markConfig(r);
    drawDiagram(readTopology());
    saveDraft();
    updateCounts();
    setChip(0, true);
    clearTimeout(validateTimer);
    validateTimer = setTimeout(validateNow, 450);
  }, 150);
}

const designView = $("view-design");
designView.addEventListener("input", () => { markDirty(); scheduleRedraw(); });
designView.addEventListener("change", () => { markDirty(); scheduleRedraw(); });
// a link moved to another node gets that node's first free port
$("links").addEventListener("change", (evt) => {
  if (!evt.target.matches(".l-src, .l-dst")) return;
  const port = evt.target.closest("tr").querySelector(evt.target.matches(".l-src") ? ".l-sif" : ".l-dif");
  port.dataset.want = "";
  evt.target.classList.remove("bad");
  refreshPorts();
});
$("addNode").addEventListener("click", () => { markDirty(); addNodeRow(); });
$("addLink").addEventListener("click", () => { markDirty(); addLinkRow(); });
$("addText").addEventListener("click", () => { markDirty(); addTextRow(); });

/* ───────── deploy ───────── */

function refreshDeploySummary() {
  const t = readTopology();
  const eve = readEve();
  $("deployTitle").textContent = `สร้าง “${t.lab.name || "ไม่มีชื่อ"}”`;
  $("deploySummary").textContent = `${t.nodes.length} อุปกรณ์ · ${t.links.length} การเชื่อมต่อ · ${t.texts.length} ข้อความ · ${eve.host || "ยังไม่ระบุ host"} · โฟลเดอร์ ${t.lab.path}`;
  const warn = [];
  if (designProblems.length) warn.push(`ฟอร์มยังมี ${designProblems.length} ปัญหา <a href="#design">กลับไปแก้ในหน้าออกแบบ</a>`);
  if (connState === "idle") warn.push(`ยังไม่ได้ทดสอบการเชื่อมต่อ EVE-NG <a href="#connect">ไปทดสอบ</a>`);
  if (connState === "fail") warn.push(`เชื่อมต่อ EVE-NG ไม่ได้ <a href="#connect">ตรวจการตั้งค่า</a>`);
  $("deployWarn").hidden = !warn.length;
  $("deployWarnText").innerHTML = warn.join("<br>");
  $("designSummary").textContent = `${t.nodes.length} อุปกรณ์ · ${t.links.length} การเชื่อมต่อ`;
}

// Does a lab with this name already exist on EVE-NG? Recommend "create" or "add to existing" accordingly
let labStateToken = 0, labExists = null, passwordSet = false;

function setLabState(state, text) {
  $("labState").hidden = !text;
  $("labState").dataset.state = state;
  $("labStateText").textContent = text || "";
}

function updateDeployCards() {
  $("cardBuild").classList.toggle("recommended", labExists === false);
  $("cardSync").classList.toggle("recommended", labExists === true);
  const notes = {
    cardBuild: labExists === true && !$("recreate").checked ? "lab ชื่อนี้มีอยู่แล้ว ต้องติ๊ก “ลบ lab ชื่อเดิมก่อน” ไม่อย่างนั้นจะสร้างไม่ได้" : "",
    cardSync: labExists === false ? "ยังไม่มี lab ชื่อนี้บน EVE-NG ใช้ “สร้างใหม่” แทน" : "",
  };
  for (const [id, text] of Object.entries(notes)) {
    const card = $(id);
    let note = card.querySelector(".card-note");
    if (!text) { note?.remove(); continue; }
    if (!note) { note = el("p", { class: "card-note" }); card.querySelector(".btn, .btn-row").before(note); }
    note.textContent = text;
  }
}
$("recreate").addEventListener("change", updateDeployCards);

async function checkLabState() {
  const lab = readTopology().lab, eve = readEve();
  const token = ++labStateToken;
  labExists = null;
  updateDeployCards();
  if (!passwordSet || !HOST_OK.test(eve.host) || !lab.name) { setLabState("idle", ""); return; }
  setLabState("idle", "กำลังตรวจว่ามี lab นี้บน EVE-NG หรือยัง…");
  let res;
  try { res = await post("/api/lab-exists", { eve, lab }); } catch (e) { res = { ok: false, error: e.message }; }
  if (token !== labStateToken) return;
  if (res.busy) { setLabState("idle", ""); return; }
  if (!res.ok) { setLabState("warn", `ตรวจไม่ได้ว่ามี lab นี้หรือยัง: ${res.error || "ไม่ทราบสาเหตุ"}`); return; }
  if (!res.folder_exists) {
    setLabState("warn", `ยังไม่มีโฟลเดอร์ “${lab.path}” บน EVE-NG สร้างได้ที่หน้า Lab ที่มีอยู่ หรือเปลี่ยนโฟลเดอร์ในหน้าออกแบบ`);
    return;
  }
  labExists = !!res.exists;
  setLabState(labExists ? "exists" : "new", labExists
    ? `มี lab “${res.lab}” อยู่แล้วบน EVE-NG แนะนำ “เพิ่มลง lab เดิม” หรือติ๊กลบของเดิมถ้าจะสร้างใหม่ทั้งหมด`
    : `ยังไม่มี lab “${res.lab}” บน EVE-NG แนะนำ “สร้างใหม่”`);
  updateDeployCards();
}

async function guard() {
  const problems = await validateNow();
  if (!problems.length) return true;
  toast("ฟอร์มยังมีปัญหา แก้ในหน้าออกแบบก่อน", "error");
  location.hash = "#design";
  return false;
}

function showVerify(res) {
  const summary = $("verifySummary"), table = $("verifyTable");
  if (!res.results) {
    summary.textContent = "";
    summary.className = "verify-summary";
    table.hidden = true;
    return;
  }
  summary.textContent = res.all_ok ? "ครบถ้วน: อุปกรณ์และสายบน EVE-NG ตรงกับฟอร์ม" : "ยังไม่ครบหรือไม่ตรง ดูรายการด้านล่าง";
  summary.className = `verify-summary ${res.all_ok ? "ok" : "bad"}`;
  $("verifyBody").replaceChildren(...res.results.map((r) => el("tr", {}, [
    el("td", {}, [r.ok ? "✅" : "❌"]),
    el("td", {}, [r.item]),
    el("td", {}, [r.detail]),
  ])));
  table.hidden = false;
}

$("btnBuild").addEventListener("click", () => run(async () => {
  if (!(await guard())) return;
  const topology = readTopology();
  const recreate = $("recreate").checked;
  if (recreate && !(await confirmDialog(`ถ้ามี lab ชื่อ “${topology.lab.name}” อยู่แล้ว จะถูกลบทิ้งแล้วสร้างใหม่ (config ที่พิมพ์ไว้ในอุปกรณ์จะหาย)`, { title: "ลบ lab เดิมแล้วสร้างใหม่?", ok: "ลบและสร้างใหม่", danger: true }))) return;
  const res = await post("/api/build", { eve: readEve(), topology, recreate, start: $("startAfter").checked });
  if (res.ok) { showVerify({}); markClean(); log(res.log, "ok", `สร้าง lab “${topology.lab.name}” สำเร็จ`); checkLabState(); }
  else log(res.error || (res.problems || []).join("\n") || "สร้าง lab ไม่สำเร็จ", "error");
}));

$("btnSync").addEventListener("click", () => run(async () => {
  if (!(await guard())) return;
  const topology = readTopology();
  if (!(await confirmDialog(`จะเพิ่มอุปกรณ์ สาย และข้อความที่ยังไม่มีเข้า lab “${topology.lab.name}” ไม่ลบและไม่แก้ของเดิม`, { title: "เพิ่มลง lab เดิม?", ok: "เพิ่ม" }))) return;
  const res = await post("/api/sync", { eve: readEve(), topology });
  if (res.ok) { markClean(); log(res.log, "ok", "เพิ่มลง lab เดิมเรียบร้อย"); }
  else log(res.error || "เพิ่มลง lab เดิมไม่สำเร็จ", "error");
}));

$("btnVerify").addEventListener("click", () => run(async () => {
  if (!(await guard())) return;
  const res = await post("/api/verify", { eve: readEve(), topology: readTopology() });
  if (!res.ok) { showVerify({}); return log(res.error || "ตรวจสอบไม่สำเร็จ", "error"); }
  showVerify(res);
  toast(res.all_ok ? "ครบถ้วน ตรงกับฟอร์ม" : "พบรายการที่ไม่ตรง", res.all_ok ? "ok" : "error");
}));

for (const [id, action, label] of [["btnStart", "start", "เปิด"], ["btnStop", "stop", "ปิด"]]) {
  $(id).addEventListener("click", () => run(async () => {
    const lab = readTopology().lab;
    if (!(await confirmDialog(`${label}ทุกอุปกรณ์ใน lab “${lab.name}”`, { title: `${label}ทั้งหมด?`, ok: label, danger: action === "stop" }))) return;
    const res = await post("/api/power", { eve: readEve(), lab, action });
    if (res.ok) log(res.log, "ok", `${label}ทุกอุปกรณ์แล้ว`);
    else log(res.error || "สั่งงานไม่สำเร็จ", "error");
  }));
}

/* ───────── existing labs ───────── */

let labData = { labs: [], folders: [] }, selectedLab = null, labsLoaded = false;

const dirOf = (path) => path.slice(0, path.lastIndexOf("/")) || "/";
const baseName = (path) => path.slice(path.lastIndexOf("/") + 1);
const countInside = (dir, list) => list.filter((p) => p.startsWith(`${dir}/`)).length;

function renderLabs() {
  const q = $("labSearch").value.trim().toLowerCase();
  const list = $("labList");
  const rows = [];
  for (const dir of ["/", ...labData.folders]) {
    const here = labData.labs.filter((p) => dirOf(p) === dir);
    const folderMatch = q && dir !== "/" && dir.toLowerCase().includes(q);
    const shown = q && !folderMatch ? here.filter((p) => p.toLowerCase().includes(q)) : here;
    if (q && !shown.length && !folderMatch) continue;

    const depth = dir === "/" ? 0 : dir.split("/").length - 2;
    const head = el("li", { class: "folder-head", style: `padding-left: ${18 + depth * 18}px` }, [
      el("span", { class: "folder-name" }, [dir === "/" ? "📂 โฟลเดอร์หลัก  /" : `📁 ${baseName(dir)}`]),
      el("span", { class: "folder-path" }, [dir === "/" ? "" : dir]),
      el("span", { class: "count" }, [String(dir === "/" ? here.length : countInside(dir, labData.labs))]),
    ]);
    if (dir !== "/") {
      const del = el("button", { class: "btn ghost sm danger-text", type: "button", title: `ลบโฟลเดอร์ ${dir} ทั้งหมด` }, ["ลบโฟลเดอร์"]);
      del.addEventListener("click", () => deleteFolder(dir));
      head.append(del);
    }
    rows.push(head);

    if (!here.length && dir !== "/") rows.push(el("li", { class: "empty-row", style: `padding-left: ${36 + depth * 18}px` }, ["ว่าง"]));
    for (const path of shown) {
      const button = el("button", { class: "lab-item", type: "button", style: `padding-left: ${36 + depth * 18}px`, "aria-pressed": String(path === selectedLab) },
        [el("span", {}, [baseName(path).replace(/\.unl$/, "")])]);
      button.addEventListener("click", () => selectLab(path));
      button.addEventListener("dblclick", () => run(importLab));
      rows.push(el("li", {}, [button]));
    }
  }
  if (!labsLoaded) { list.replaceChildren(el("li", { class: "empty" }, ["กด “ดึงรายการ” เพื่อดู lab ทั้งหมดบน EVE-NG"])); return; }
  list.replaceChildren(...(rows.length ? rows : [el("li", { class: "empty" }, ["ไม่พบที่ค้นหา"])]));
}

function updateSelection() {
  $("labSelected").textContent = selectedLab || "ยังไม่ได้เลือก lab";
  $("btnImport").disabled = $("btnDeleteLab").disabled = !selectedLab;
}

function selectLab(path) {
  selectedLab = path;
  updateSelection();
  renderLabs();
}

$("labSearch").addEventListener("input", renderLabs);

async function refreshLabs() {
  const res = await post("/api/labs", { eve: readEve() });
  if (!res.ok) { log(res.error || "ดึงรายการไม่สำเร็จ", "error"); return false; }
  labData = { labs: res.labs, folders: res.folders };
  labsLoaded = true;
  if (selectedLab && !labData.labs.includes(selectedLab)) selectedLab = null;
  updateSelection();
  renderLabs();
  return true;
}

$("btnListLabs").addEventListener("click", () => run(async () => {
  if (await refreshLabs()) toast(`พบ ${labData.labs.length} lab, ${labData.folders.length} โฟลเดอร์`, "ok");
}));

async function importLab() {
  if (!selectedLab) return;
  if (!(await confirmReplace(`โหลด “${selectedLab}” เข้าฟอร์ม`))) return;
  const res = await post("/api/import", { eve: readEve(), lab_path: selectedLab });
  if (!res.ok) return log(res.error || "โหลดไม่สำเร็จ", "error");
  applyImported(res.topology, res.warnings, `โหลด ${selectedLab} แล้ว`, true);
}
$("btnImport").addEventListener("click", () => run(importLab));

// Destructive actions: ask first (outside the busy state so the dialog stays usable), then call the server
$("btnDeleteLab").addEventListener("click", async () => {
  const path = selectedLab;
  if (!path) return;
  const ok = await confirmDialog(`ลบ lab “${path}” ถาวร กู้คืนไม่ได้\nระบบจะไม่ลบถ้ายังมีอุปกรณ์ใน lab นี้ทำงานอยู่`,
    { title: "ลบ lab?", ok: "ลบ lab", danger: true });
  if (!ok) return;
  run(async () => {
    const res = await post("/api/lab-delete", { eve: readEve(), lab_path: path });
    if (!res.ok) return log(res.error || "ลบไม่สำเร็จ", "error");
    log(res.message, "ok");
    await refreshLabs();
  });
});

async function deleteFolder(dir) {
  const labsInside = countInside(dir, labData.labs), foldersInside = countInside(dir, labData.folders);
  const empty = !labsInside && !foldersInside;
  const name = baseName(dir);
  const message = empty
    ? `ลบโฟลเดอร์ว่าง “${dir}”`
    : `ลบโฟลเดอร์ “${dir}” พร้อมทุกอย่างข้างใน\nlab ${labsInside} รายการ และโฟลเดอร์ย่อย ${foldersInside} โฟลเดอร์ จะหายถาวร กู้คืนไม่ได้\nระบบจะไม่ลบถ้ายังมีอุปกรณ์ทำงานอยู่ในนั้น`;
  const ok = await confirmDialog(message, { title: "ลบทั้งโฟลเดอร์?", ok: "ลบทั้งโฟลเดอร์", danger: true, typeToConfirm: empty ? "" : name });
  if (!ok) return;
  run(async () => {
    const res = await post("/api/folder-delete", { eve: readEve(), path: dir, confirm_name: empty ? "" : name });
    if (!res.ok) return log(res.error || "ลบโฟลเดอร์ไม่สำเร็จ", "error");
    log(res.message, "ok");
    await refreshLabs();
  });
}

const FOLDER_NAME_OK = /^[A-Za-z0-9_\- .]+$/;
$("folderName").addEventListener("input", () => {
  const name = $("folderName").value.trim();
  $("folderOk").disabled = !(FOLDER_NAME_OK.test(name) && !name.includes("..") && name.replace(/\./g, "") !== "");
});

$("btnNewFolder").addEventListener("click", async () => {
  const dialog = $("folderDialog");
  $("folderParent").replaceChildren(el("option", { value: "/" }, ["โฟลเดอร์หลัก (/)"]),
    ...labData.folders.map((f) => el("option", { value: f }, [f])));
  $("folderName").value = "";
  $("folderOk").disabled = true;
  const parent = await new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok" ? $("folderParent").value : null), { once: true });
    dialog.showModal();
    $("folderName").focus();
  });
  if (parent === null) return;
  const name = $("folderName").value.trim();
  run(async () => {
    const res = await post("/api/folder-create", { eve: readEve(), parent, name });
    if (!res.ok) return log(res.error || "สร้างโฟลเดอร์ไม่สำเร็จ", "error");
    log(res.message, "ok");
    await refreshLabs();
  });
});

/* ───────── start: AI import ───────── */

let importHelp = null;
async function getImportHelp() {
  if (!importHelp) importHelp = await (await fetch("/api/import-help")).json();
  return importHelp;
}

let promptCopied = false;
function updateSteps() {
  const filled = $("importText").value.trim().length > 0;
  $("btnParse").disabled = !filled;
  $("step1").classList.toggle("done", promptCopied);
  $("step2").classList.toggle("done", filled);
  $("step1").classList.toggle("active", !promptCopied && !filled);
  $("step2").classList.toggle("active", promptCopied && !filled);
  $("step3").classList.toggle("active", filled);
}
$("importText").addEventListener("input", updateSteps);

async function copyPrompt() {
  const help = await getImportHelp();
  try {
    await navigator.clipboard.writeText(help.prompt);
    promptCopied = true;
    toast("คัดลอก prompt แล้ว นำไปวางให้ AI พร้อมรูปโจทย์", "ok");
  } catch (e) {
    await showPrompt();
    toast("คัดลอกอัตโนมัติไม่ได้ กดปุ่ม “คัดลอก” หรือ Ctrl+C ในหน้าต่างที่เปิดให้", "error");
  }
  updateSteps();
}

async function showPrompt() {
  $("promptView").textContent = (await getImportHelp()).prompt;
  $("promptDialog").showModal();
}

$("btnCopyPrompt").addEventListener("click", () => run(copyPrompt));
$("btnShowPrompt").addEventListener("click", () => run(showPrompt));
$("btnPromptCopy").addEventListener("click", () => run(copyPrompt));

$("btnSample").addEventListener("click", () => run(async () => {
  $("importText").value = (await getImportHelp()).sample;
  updateSteps();
}));

async function importFromText() {
  const text = $("importText").value.trim();
  if (!text) return toast("วางคำตอบจาก AI ก่อน", "error");
  const res = await post("/api/parse", { text });
  if (!res.ok) return log(res.error || "นำเข้าไม่สำเร็จ", "error");
  const t = res.topology;
  if (!(await confirmReplace(`นำเข้า ${t.nodes.length} อุปกรณ์ ${t.links.length} การเชื่อมต่อ`))) return;
  applyImported(t, [...res.problems.map((p) => `ต้องแก้: ${p}`), ...res.warnings], "นำเข้าแล้ว");
}

$("btnParse").addEventListener("click", () => run(importFromText));
$("importText").addEventListener("keydown", (evt) => {
  if (evt.key === "Enter" && (evt.ctrlKey || evt.metaKey) && !$("btnParse").disabled) {
    evt.preventDefault();
    run(importFromText);
  }
});

/* ───────── export topology.json ───────── */

// Same format as topology.json: works with `python eve_builder.py <file>` and can be imported again on the start page
$("btnExport").addEventListener("click", () => {
  const t = readTopology();
  const { host, https } = readEve();
  const data = { eve: { host, username: $("username").value.trim(), https }, ...t };
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: "application/json" }));
  const name = `${(t.lab.name || "topology").replace(/[^A-Za-z0-9_\-]+/g, "_")}.json`;
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(designProblems.length ? `ส่งออก ${name} แล้ว (ฟอร์มยังมี ${designProblems.length} ปัญหา)` : `ส่งออก ${name} แล้ว`, "ok");
});

$("importFile").addEventListener("change", (evt) => run(async () => {
  const file = evt.target.files[0];
  evt.target.value = "";
  if (!file) return;
  if (file.size > 500000) return toast("ไฟล์ใหญ่เกินไป (สูงสุด 500 KB)", "error");
  if (/\.xlsx?$/i.test(file.name)) return toast("ยังไม่รองรับไฟล์ Excel ให้ AI ตอบเป็น JSON แล้วคัดลอกมาวางแทน", "error");
  $("importText").value = await file.text();
  updateSteps();
  await importFromText();
}));

/* ───────── init ───────── */

(async function init() {
  let cfg = {};
  try {
    cfg = await (await fetch("/api/config")).json();
  } catch (e) {
    toast("ติดต่อเซิร์ฟเวอร์ web_app.py ไม่ได้", "error");
  }
  $("pwBanner").hidden = cfg.passwordSet !== false;
  passwordSet = !!cfg.passwordSet;
  const draft = readDraft();
  const topo = cfg.topology || {};
  const eve = topo.eve || {};
  $("host").value = eve.host || "10.0.53.34";
  $("username").value = cfg.username || "evebuilder";
  $("https").checked = !!eve.https;
  updateEveLink();
  const lab = topo.lab || {};
  $("labName").value = lab.name || "my_lab";
  $("labDir").value = lab.path || "/";
  $("labDesc").value = lab.description || "";
  (topo.nodes || []).forEach(addNodeRow);
  if (!$("nodes").rows.length) { addNodeRow(); addNodeRow(); }
  (topo.links || []).forEach(addLinkRow);
  (topo.texts || []).forEach(addTextRow);
  formDirty = false;
  if (draft) offerDraft(draft);
  updateSteps();
  showView(location.hash.slice(1));
  scheduleRedraw();
  if (cfg.passwordSet) refreshStats();
})();
