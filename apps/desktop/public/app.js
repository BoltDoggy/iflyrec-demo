const $ = (sel) => document.querySelector(sel);

const state = {
  settings: { folders: [], exts: [] },
  entries: [],
  selected: new Set(),
  filter: "all",
  busy: false,
};

init();

async function init() {
  try {
    state.settings = await api("/api/settings");
  } catch (e) {
    toast(`读取配置失败: ${e.message}`, true);
  }
  renderSettings();
  bind();
  if (state.settings.folders.length) await scan();
}

function bind() {
  $("#add-folder").onclick = addFolder;
  $("#new-folder").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addFolder();
  });
  $("#save-exts").onclick = saveExts;
  $("#scan").onclick = () => scan();
  $("#process").onclick = processSelected;
  $("#select-all").onchange = (e) => {
    if (e.target.checked) visibleEntries().forEach((en) => state.selected.add(en.id));
    else state.selected.clear();
    renderRows();
    updateToolbar();
  };
  $("#filters").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-filter]");
    if (!btn) return;
    state.filter = btn.dataset.filter;
    document.querySelectorAll("#filters button").forEach((b) =>
      b.classList.toggle("on", b === btn)
    );
    renderRows();
    updateToolbar();
  });
  $("#tbody").addEventListener("change", (e) => {
    const cb = e.target.closest("input[type=checkbox]");
    if (!cb) return;
    const id = cb.dataset.id;
    if (cb.checked) state.selected.add(id);
    else state.selected.delete(id);
    updateToolbar();
  });
  $("#tbody").addEventListener("click", (e) => {
    const dup = e.target.closest(".copies");
    if (!dup) return;
    const paths = document.getElementById(`paths-${dup.dataset.id}`);
    if (paths) paths.hidden = !paths.hidden;
  });
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  return res.json();
}

// ---------- 配置 ----------

async function addFolder() {
  const input = $("#new-folder");
  const path = input.value.trim().replace(/\/+$/, "");
  if (!path) return;
  if (state.settings.folders.includes(path)) return toast("该目录已在列表中", true);
  state.settings.folders = [...state.settings.folders, path];
  await saveSettings();
  input.value = "";
}

async function removeFolder(path) {
  state.settings.folders = state.settings.folders.filter((f) => f !== path);
  await saveSettings();
}

async function saveExts() {
  state.settings.exts = $("#exts").value
    .split(",")
    .map((s) => s.trim().replace(/^\.+/, ""))
    .filter(Boolean);
  await saveSettings();
  toast("后缀已保存, 点「扫描」生效");
}

async function saveSettings() {
  try {
    state.settings = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify(state.settings),
    });
  } catch (e) {
    toast(`保存失败: ${e.message}`, true);
  }
  renderSettings();
}

// ---------- 扫描 ----------

async function scan() {
  if (state.busy) return;
  state.busy = true;
  const btn = $("#scan");
  btn.disabled = true;
  btn.textContent = "扫描中…";
  try {
    const r = await api("/api/scan", { method: "POST" });
    state.entries = r.entries;
    state.selected.clear();
    $("#select-all").checked = false;
    if (r.skipped.length) {
      const parts = r.skipped.map((s) =>
        `${s.path}（${s.reason === "no_perm" ? "无权限读取" : "路径不存在"}）`
      );
      toast(`已跳过: ${parts.join("、")}`, true);
    }
    renderRows();
  } catch (e) {
    toast(`扫描失败: ${e.message}`, true);
  } finally {
    state.busy = false;
    btn.disabled = false;
    btn.textContent = "扫描";
    updateToolbar();
  }
}

// ---------- 处理 (mock) ----------

async function processSelected() {
  const ids = [...state.selected].filter(
    (id) => !state.entries.find((e) => e.id === id)?.processed,
  );
  if (!ids.length) return toast("请先勾选未处理的文件", true);
  const btn = $("#process");
  btn.disabled = true;
  btn.textContent = `处理中 (${ids.length})…`;
  try {
    const r = await api("/api/process", { method: "POST", body: JSON.stringify({ ids }) });
    toast(`已处理 ${r.processed} 个文件 (mock)`);
    state.selected.clear();
    $("#select-all").checked = false;
    state.entries.forEach((e) => {
      if (ids.includes(e.id)) {
        e.processed = true;
        e.processedAt = new Date().toISOString().slice(0, 19).replace("T", " ");
      }
    });
    renderRows();
  } catch (e) {
    toast(`处理失败: ${e.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "处理选中";
    updateToolbar();
  }
}

// ---------- 渲染 ----------

function renderSettings() {
  const box = $("#folders");
  box.innerHTML = state.settings.folders.length
    ? state.settings.folders
        .map(
          (f) =>
            `<span class="chip">${escapeHtml(f)}<button data-folder="${escapeHtml(f)}" title="移除">×</button></span>`,
        )
        .join("")
    : `<span class="hint">尚未配置文件夹, 添加后点「扫描」</span>`;
  box.querySelectorAll("button[data-folder]").forEach((b) => {
    b.onclick = () => removeFolder(b.dataset.folder);
  });
  $("#exts").value = state.settings.exts.join(", ");
}

const visibleEntries = () =>
  state.entries.filter((e) =>
    state.filter === "all" ? true : state.filter === "done" ? e.processed : !e.processed,
  );

function renderRows() {
  const rows = visibleEntries();
  const tbody = $("#tbody");
  $("#empty").hidden = rows.length > 0;
  $("#empty").textContent = state.entries.length
    ? "当前筛选下没有文件"
    : "暂无数据: 配置文件夹与后缀后点「扫描」";

  tbody.innerHTML = rows
    .map((e) => {
      const primary = e.copies[0];
      const copiesBtn = e.copies.length > 1
        ? `<button class="copies" data-id="${e.id}" title="点击展开所有副本">+${e.copies.length - 1} 份副本</button>`
        : "";
      return `
      <tr data-id="${e.id}" class="${e.processed ? "done" : ""}">
        <td><input type="checkbox" data-id="${e.id}" ${state.selected.has(e.id) ? "checked" : ""}></td>
        <td>${e.processed
          ? `<span class="badge ok" title="处理于 ${e.processedAt ?? ""}">✓ 已处理</span>`
          : `<span class="badge">未处理</span>`}</td>
        <td class="name" title="指纹 ${e.id.slice(0, 16)}…">${escapeHtml(e.name)}</td>
        <td>${humanSize(e.size)}</td>
        <td class="folder" title="${escapeHtml(primary.path)}">${escapeHtml(primary.folder || primary.path)}${copiesBtn}</td>
        <td>${new Date(e.mtime).toLocaleString("sv-SE", { hour12: false })}</td>
      </tr>
      ${e.copies.length > 1 ? `<tr id="paths-${e.id}" class="paths" hidden><td colspan="6"><ul>${
        e.copies.map((c) => `<li title="${escapeHtml(c.path)}">${escapeHtml(c.path)}</li>`).join("")
      }</ul></td></tr>` : ""}`;
    })
    .join("");
  updateToolbar();
}

function updateToolbar() {
  const total = state.entries.length;
  const done = state.entries.filter((e) => e.processed).length;
  const sel = [...state.selected].filter(
    (id) => !state.entries.find((e) => e.id === id)?.processed,
  ).length;
  $("#counts").textContent = total ? `共 ${total} 项 · 已处理 ${done} · 未处理 ${total - done}` : "";
  const btn = $("#process");
  btn.disabled = sel === 0;
  btn.textContent = sel > 0 ? `处理选中 (${sel})` : "处理选中";
}

function toast(msg, warn = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = warn ? "warn" : "";
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.hidden = true), 3000);
}

const humanSize = (n) =>
  n < 1024 ? `${n} B`
  : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB`
  : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB`
  : `${(n / 1024 ** 3).toFixed(2)} GB`;

const escapeHtml = (s) =>
  String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
