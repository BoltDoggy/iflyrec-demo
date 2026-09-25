const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const STAGE_LABEL = {
  queued: "排队中",
  uploading: "上传中",
  transcribing: "转写中",
  summarizing: "总结中",
  mindmapping: "导图中",
};

const state = {
  settings: { folders: [], exts: [] },
  entries: [],
  selected: new Set(),
  filter: "all",
  busy: false,
  statuses: {}, // id -> {status, stage, error}
  active: [], // 服务端正在处理的 id
};

let pollTimer = null;
let markmapReady = null;
let pendingMindmap = null; // 打开详情时暂存, 切到导图 tab 再渲染(隐藏容器渲染会得到 NaN 坐标)

init();

async function init() {
  try {
    state.settings = await api("/api/settings");
  } catch (e) {
    toast(`读取配置失败: ${e.message}`, true);
  }
  renderSettings();
  bind();
  const st = await api("/api/status").catch(() => null);
  if (st) {
    state.statuses = st.statuses;
    state.active = st.active;
    if (Object.values(st.statuses).some((s) => s.status === "processing")) startPolling();
  }
  if (state.settings.folders.length) await scan();
}

function bind() {
  $("#add-folder").onclick = addFolder;
  $("#new-folder").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addFolder();
  });
  $("#save-exts").onclick = saveExts;
  $("#save-api").onclick = saveApi;
  // 版本切换时 resource id 自动跟随 (用户自定义过则不动)
  const KNOWN_RIDS = [
    "volc.bigasr.auc_turbo",
    "volc.bigasr.auc",
    "volc.seedasr.auc",
    "volc.bigasr.sauc.duration",
  ];
  $("#asr-edition").addEventListener("change", () => {
    const cur = $("#asr-resource").value.trim();
    if (!cur || KNOWN_RIDS.includes(cur)) {
      $("#asr-resource").value = $("#asr-edition").value === "standard"
        ? "volc.bigasr.auc"
        : "volc.bigasr.auc_turbo";
    }
  });
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
    $$("#filters button").forEach((b) => b.classList.toggle("on", b === btn));
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
    if (dup) {
      const paths = document.getElementById(`paths-${dup.dataset.id}`);
      if (paths) paths.hidden = !paths.hidden;
      return;
    }
    if (e.target.closest("input,button")) return;
    const tr = e.target.closest("tr[data-id]");
    if (!tr) return;
    if (state.statuses[tr.dataset.id]) openDetail(tr.dataset.id);
  });
  // 详情弹层
  $("#modal-close").onclick = closeModal;
  $("#modal-mask").onclick = closeModal;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });
  $(".tabs").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-tab]");
    if (!btn) return;
    $$(".tabs button").forEach((b) => b.classList.toggle("on", b === btn));
    $$(".panel").forEach((p) =>
      p.classList.toggle("on", p.id === `panel-${btn.dataset.tab}`)
    );
    // 导图 tab 首次激活时才渲染: 容器可见才有布局尺寸, 避免 translate(NaN,NaN)
    if (btn.dataset.tab === "mindmap" && pendingMindmap !== null) {
      const md = pendingMindmap;
      pendingMindmap = null;
      renderMindmap(md);
    }
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

async function saveApi() {
  state.settings.api = {
    asr: {
      provider: $("#asr-provider").value,
      apiKey: $("#asr-key").value.trim(),
      edition: $("#asr-edition").value,
      resourceId: $("#asr-resource").value.trim(),
      ssdVersion: $("#asr-ssd").value,
      tos: {
        bucket: $("#tos-bucket").value.trim(),
        region: $("#tos-region").value.trim(),
        endpoint: "", // 由服务端按 region 补默认
        accessKeyId: $("#tos-ak").value.trim(),
        accessKeySecret: $("#tos-sk").value.trim(),
        prefix: "",
      },
    },
    llm: {
      provider: $("#llm-provider").value,
      baseUrl: $("#llm-base").value.trim(),
      apiKey: $("#llm-key").value.trim(),
      model: $("#llm-model").value.trim(),
    },
  };
  await saveSettings();
  toast("服务配置已保存");
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

  const api = state.settings.api ?? {};
  const asr = api.asr ?? {};
  const llm = api.llm ?? {};
  $("#asr-provider").value = asr.provider ?? "mock";
  $("#asr-key").value = asr.apiKey ?? "";
  $("#asr-edition").value = asr.edition ?? "flash";
  $("#asr-resource").value = asr.resourceId ?? "";
  $("#asr-ssd").value = asr.ssdVersion ?? "200";
  const tos = asr.tos ?? {};
  $("#tos-bucket").value = tos.bucket ?? "";
  $("#tos-region").value = tos.region ?? "";
  $("#tos-ak").value = tos.accessKeyId ?? "";
  $("#tos-sk").value = tos.accessKeySecret ?? "";
  $("#llm-provider").value = llm.provider ?? "mock";
  $("#llm-base").value = llm.baseUrl ?? "";
  $("#llm-key").value = llm.apiKey ?? "";
  $("#llm-model").value = llm.model ?? "";
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

// ---------- 处理 ----------

async function processSelected() {
  const ids = [...state.selected];
  if (!ids.length) return toast("请先勾选要处理的文件", true);
  try {
    const r = await api("/api/process", { method: "POST", body: JSON.stringify({ ids }) });
    toast(`已加入处理队列: ${r.queued} 个文件`);
    state.selected.clear();
    $("#select-all").checked = false;
    renderRows();
    startPolling();
  } catch (e) {
    toast(`处理失败: ${e.message}`, true);
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    try {
      const r = await api("/api/status");
      state.statuses = r.statuses;
      state.active = r.active;
      patchStatuses();
      const busy = Object.values(r.statuses).some((s) => s.status === "processing");
      if (!busy) {
        stopPolling();
        scan(); // 刷新已处理标记
      }
    } catch {
      stopPolling();
    }
  }, 1500);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

/** 只更新状态/上传列与工具栏, 不重建表格(保留勾选/展开状态)。 */
function patchStatuses() {
  $$("#tbody tr[data-id]").forEach((tr) => {
    // 必须带上完整 entry(processed 等), 否则会把已完成刷成未处理
    const entry = state.entries.find((e) => e.id === tr.dataset.id) ?? { id: tr.dataset.id };
    const cell = tr.querySelector("td:nth-child(2)");
    if (cell) cell.innerHTML = statusBadgeHtml(entry);
    const upCell = tr.querySelector("td:nth-child(3)");
    const st = state.statuses[tr.dataset.id];
    if (upCell && st) {
      upCell.innerHTML = st.uploaded
        ? `<span class="badge up">已上传</span>`
        : `<span class="badge">未上传</span>`;
    }
  });
  updateToolbar();
}
// ---------- 渲染 ----------

const visibleEntries = () =>
  state.entries.filter((e) =>
    state.filter === "all" ? true : state.filter === "done" ? e.processed : !e.processed,
  );

/** 服务端在跑=processing; 文件标记 processing 但服务端不在跑=被中断(如重启)。 */
function effectiveStatus(id) {
  const st = state.statuses[id];
  if (!st) return null;
  if (st.status === "processing") return state.active.includes(id) ? "processing" : "error";
  return st.status;
}

function statusBadgeHtml({ id, processed, processedAt }) {
  const eff = effectiveStatus(id);
  if (eff === "processing") {
    const st = state.statuses[id];
    return `<span class="badge busy"><span class="spin"></span>${
      STAGE_LABEL[st.stage] ?? "排队中"
    }</span>`;
  }
  if (eff === "error") {
    const msg = state.statuses[id]?.error ?? "处理被中断(服务重启?), 点击行查看并重试";
    return `<span class="badge err" title="${escapeHtml(msg)}">✗ 失败</span>`;
  }
  if (eff === "done") {
    return `<span class="badge ok" title="处理于 ${processedAt ?? ""}">✓ 已完成</span>`;
  }
  return processed
    ? `<span class="badge ok" title="处理于 ${processedAt ?? ""}">✓ 已完成</span>`
    : `<span class="badge">未处理</span>`;
}

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
      const clickable = state.statuses[e.id] ? " clickable" : "";
      return `
      <tr data-id="${e.id}" class="${e.processed ? "done" : ""}${clickable}">
        <td><input type="checkbox" data-id="${e.id}" ${state.selected.has(e.id) ? "checked" : ""}></td>
        <td>${statusBadgeHtml(e)}</td>
        <td>${
          e.uploaded
            ? `<span class="badge up" title="${escapeHtml(e.uploadObject ?? "")} · ${e.uploadedAt ?? ""}">已上传</span>`
            : `<span class="badge">未上传</span>`
        }</td>
        <td class="name" title="指纹 ${e.id.slice(0, 16)}…">${escapeHtml(e.name)}</td>
        <td class="brief" title="${escapeHtml(e.brief ?? "")}">${
          e.brief ? escapeHtml(e.brief) : `<span class="hint">—</span>`
        }</td>
        <td>${humanSize(e.size)}</td>
        <td class="folder" title="${escapeHtml(primary.path)}">${escapeHtml(primary.folder || primary.path)}${copiesBtn}</td>
        <td>${new Date(e.mtime).toLocaleString("sv-SE", { hour12: false })}</td>
      </tr>
      ${e.copies.length > 1 ? `<tr id="paths-${e.id}" class="paths" hidden><td colspan="8"><ul>${
        e.copies.map((c) => `<li title="${escapeHtml(c.path)}">${escapeHtml(c.path)}</li>`).join("")
      }</ul></td></tr>` : ""}`;
    })
    .join("");
  updateToolbar();
}

function updateToolbar() {
  const total = state.entries.length;
  const busy = Object.keys(state.statuses).filter((id) => effectiveStatus(id) === "processing").length;
  const done = state.entries.filter((e) => e.processed).length;
  const sel = state.selected.size;
  $("#counts").textContent = total
    ? `共 ${total} 项 · 处理中 ${busy} · 已完成 ${done} · 未处理 ${total - done - (busy ? 0 : 0)}`
    : "";
  const btn = $("#process");
  btn.disabled = sel === 0;
  btn.textContent = sel > 0 ? `处理选中 (${sel})` : "处理选中";
}

// ---------- 详情弹层 ----------

async function openDetail(id) {
  let r;
  try {
    r = await api(`/api/result/${id}`);
  } catch (e) {
    return toast(`读取结果失败: ${e.message}`, true);
  }
  $("#modal-title").textContent = r.name;
  const meta = [];
  if (r.meta?.duration) meta.push(`时长 ${fmtTime(r.meta.duration)}`);
  if (r.meta?.asrMs) meta.push(`转写 ${(r.meta.asrMs / 1000).toFixed(1)}s (${r.meta.asrProvider})`);
  if (r.meta?.llmMs) meta.push(`LLM ${(r.meta.llmMs / 1000).toFixed(1)}s`);
  if (r.meta?.at) meta.push(r.meta.at.replace("T", " "));
  $("#modal-meta").innerHTML = meta.map((m) => `<span>${escapeHtml(m)}</span>`).join("");
  const briefEl = $("#modal-brief");
  if (r.brief) {
    briefEl.textContent = `简介：${r.brief}`;
    briefEl.hidden = false;
  } else {
    briefEl.hidden = true;
  }

  // 转写文稿: 失败时显示错误横幅, 但已完成的转写照样展示(总结失败不影响看文稿)
  const transcript = $("#panel-transcript");
  let transcriptHtml = "";
  if (r.status === "error") {
    transcriptHtml += `<p class="error">处理失败: ${escapeHtml(r.error ?? "")}</p>
      <p class="hint">勾选该文件后点「处理选中」可重试; 已完成的转写阶段不会重复计费。</p>`;
  }
  if (r.turns?.length) {
    transcriptHtml += r.turns
      .map((t) => {
        const n = ((Number(t.speaker) || 1) - 1) % 4 + 1;
        return `<div class="turn"><span class="t">[${fmtTime(t.start)}]</span>
          <span class="spk spk-${n}">说话人 ${escapeHtml(t.speaker)}</span>
          <span class="txt">${escapeHtml(t.text)}</span></div>`;
      })
      .join("");
  } else if (!transcriptHtml) {
    transcriptHtml = `<p class="hint">暂无文稿</p>`;
  }
  transcript.innerHTML = transcriptHtml;

  // 总结
  $("#panel-summary").innerHTML = r.summary
    ? `<div class="md">${renderMarkdown(r.summary)}</div>`
    : `<p class="hint">暂无总结</p>`;

  // 思维导图: 暂存内容, 切到对应 tab 再渲染
  pendingMindmap = r.mindmap ?? null;
  $("#panel-mindmap").innerHTML = `<p class="hint">${
    r.mindmap ? "切到「思维导图」标签后渲染" : "暂无思维导图"
  }</p>`;

  // 默认切到文稿 tab
  $$(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === "transcript"));
  $$(".panel").forEach((p) => p.classList.toggle("on", p.id === "panel-transcript"));
  $("#modal").hidden = false;
}

function closeModal() {
  $("#modal").hidden = true;
}

async function renderMindmap(md) {
  const panel = $("#panel-mindmap");
  panel.innerHTML = `<p class="hint">渲染中…</p>`;
  const ok = await ensureMarkmap();
  if (!ok) return fallbackOutline(md, "markmap 组件加载失败");
  panel.innerHTML = "";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.style.cssText = "width:100%;height:60vh;display:block";
  panel.appendChild(svg);
  try {
    window.__renderMarkmap(svg, md);
  } catch (e) {
    console.error("markmap 渲染失败:", e);
    fallbackOutline(md);
  }
}

function fallbackOutline(md, reason = "渲染失败") {
  $("#panel-mindmap").innerHTML =
    `<div class="md outline">${renderMarkdown(md)}</div>
     <p class="hint">思维导图${reason}, 已退化为大纲文本</p>`;
}

/** 本地内置的 markmap bundle (public/vendor), 不依赖外网 CDN。 */
function ensureMarkmap() {
  if (window.__renderMarkmap) return Promise.resolve(true);
  if (markmapReady) return markmapReady;
  markmapReady = new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = "/vendor/markmap.vendor.js";
    s.onload = () => resolve(!!window.__renderMarkmap);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
    setTimeout(() => resolve(!!window.__renderMarkmap), 10000);
  });
  return markmapReady;
}

// ---------- 工具 ----------

function renderMarkdown(md) {
  const out = [];
  let inList = false;
  const inline = (s) =>
    escapeHtml(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    const task = line.match(/^\s*- \[( |x|X)\]\s+(.*)$/);
    if (task) {
      if (!inList) {
        out.push('<ul class="tasks">');
        inList = true;
      }
      out.push(
        `<li class="task"><input type="checkbox" disabled ${task[1] === " " ? "" : "checked"}>${
          inline(task[2])
        }</li>`,
      );
      continue;
    }
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    closeList();
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const lv = h[1].length + 1;
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
      continue;
    }
    if (line.startsWith(">")) {
      out.push(`<blockquote>${inline(line.slice(1).trim())}</blockquote>`);
      continue;
    }
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join("");
}

function toast(msg, warn = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = warn ? "warn" : "";
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.hidden = true), 3000);
}

const fmtTime = (ms) => {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

const humanSize = (n) =>
  n < 1024 ? `${n} B`
  : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB`
  : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB`
  : `${(n / 1024 ** 3).toFixed(2)} GB`;

const escapeHtml = (s) =>
  String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
