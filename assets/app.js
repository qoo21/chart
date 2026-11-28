// 譜面ビューア
//   ・Bot が公開しているサイトでは data/charts.json を自動で読み込み、譜面ごと（c/譜面ID/）・人ごと（u/URL名/）のページを持つ
//   ・データファイルを手で開く使い方もできる
(() => {
  "use strict";
  const FORMAT = "prsk-chart-data";
  const PAGE = 60;
  const DIFFS = ["Expert", "Master", "Append"];
  const DIFF_COLOR = { Expert: "var(--d-expert)", Master: "var(--d-master)", Append: "var(--d-append)" };
  const OTHER = "__other"; // 曲リストに無い曲・難易度

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString("ja-JP");
  const norm = (s) => String(s || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();

  const root = document.documentElement;
  const BASE = root.dataset.base || "./";
  const ROOT_URL = new URL(BASE, location.href);
  // ★ 追加: 最初からページにあるリンク（「譜面画像を作る」など）は、サイトの一番上からの場所にしておく
  //   （譜面のページなどに移った後でも、正しいページを指すように）
  for (const a of document.querySelectorAll("a[href]")) {
    const h = a.getAttribute("href");
    if (h && !/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(h)) a.href = new URL(h, location.href).href;
  }
  let INITIAL_ROUTE = null;
  try { INITIAL_ROUTE = JSON.parse(root.dataset.route || "null"); } catch {}
  let SITE = false; // サイトのデータを自動で読み込めた時 true

  // ---------- 状態 ----------
  let D = null;
  let charts = [];
  let chartById = new Map();
  let songIndex = new Map();
  let songStats = [];
  let userStats = new Map();
  const state = { q: "", song: "", diffs: new Set(), lvMin: "", lvMax: "", user: "", sort: "new", shown: PAGE, tab: "charts" };
  let userPageSort = "new";
  const daily = { diff: "", shown: PAGE, rank: new Map(), list: [] }; // ★ 追加: デイリーランキング

  // ---------- 明暗 ----------
  try { const t = localStorage.getItem("cv-theme"); if (t === "light" || t === "dark") root.dataset.theme = t; } catch {}
  $("themeBtn").addEventListener("click", () => {
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("cv-theme", root.dataset.theme); } catch {}
  });

  // ---------- 前回のデータ（手で開いた時だけ。このブラウザの中に保存） ----------
  const idb = {
    open() {
      return new Promise((res, rej) => {
        const r = indexedDB.open("chart-viewer", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("data");
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    },
    async get() {
      const db = await this.open();
      return new Promise((res) => { const t = db.transaction("data").objectStore("data").get("last"); t.onsuccess = () => res(t.result || null); t.onerror = () => res(null); });
    },
    async set(v) {
      const db = await this.open();
      return new Promise((res) => { const t = db.transaction("data", "readwrite"); t.objectStore("data").put(v, "last"); t.oncomplete = () => res(); t.onerror = () => res(); });
    }
  };

  // ---------- 読み込み ----------
  const valid = (d) => d && d.format === FORMAT && Array.isArray(d.charts);
  async function readFile(file) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let text;
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      if (typeof DecompressionStream === "undefined") throw new Error("このブラウザは .gz ファイルを開けません。最新のブラウザで開いてください。");
      const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
      text = await new Response(stream).text();
    } else {
      text = new TextDecoder("utf-8").decode(buf);
    }
    let data;
    try { data = JSON.parse(text); } catch { throw new Error("ファイルを読み取れませんでした。譜面データのファイルか確認してください。"); }
    if (!valid(data)) throw new Error("譜面データのファイルではありません。");
    return data;
  }
  async function loadFile(file) {
    $("err").hidden = true;
    try {
      const data = await readFile(file);
      setData(data);
      idb.set(data).catch(() => {});
      render({ type: "home" });
      toast(`譜面 ${fmt(data.charts.length)}件を読み込みました`);
    } catch (e) {
      showEmpty(e.message || String(e));
    }
  }
  function showEmpty(msg) {
    $("loadingView").hidden = true;
    $("emptyView").hidden = false;
    $("dataView").hidden = true;
    $("openFile").hidden = false;
    $("meta").textContent = "データはまだ読み込まれていません";
    if (msg) { $("err").textContent = msg; $("err").hidden = false; }
  }

  const fileInput = $("fileInput");
  const pick = () => { fileInput.value = ""; fileInput.click(); };
  $("openFile").addEventListener("click", pick);
  $("openFile2").addEventListener("click", pick);
  fileInput.addEventListener("change", () => { if (fileInput.files[0]) loadFile(fileInput.files[0]); });
  const drop = $("drop");
  ["dragenter", "dragover"].forEach((ev) => document.addEventListener(ev, (e) => { if (SITE) return; e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => document.addEventListener(ev, (e) => { if (SITE) return; e.preventDefault(); if (ev === "drop" || e.target === document.documentElement) drop.classList.remove("over"); }));
  document.addEventListener("drop", (e) => { if (SITE) return; const f = e.dataTransfer?.files?.[0]; if (f) loadFile(f); });

  // ---------- データを整える ----------
  const user = (key) => (key && D.users ? D.users[key] : null);
  function userName(key) {
    const u = user(key);
    if (!key) return "匿名";
    return (u && u.name) || "匿名";
  }
  const lvValue = (c) => (c.lv != null ? c.lv : c.level);
  const lvText = (c) => (c.lv != null ? Number(c.lv).toFixed(1) : (c.level ?? "?"));
  function diffKey(d) { return DIFFS.includes(d) ? d : OTHER; }
  function songKey(music) { return songIndex.get(norm(music)) ?? OTHER; }

  function setData(data) {
    D = data;
    songIndex = new Map();
    const songs = Array.isArray(D.songs) ? D.songs : [];
    for (const name of songs) { const k = norm(name); if (k && !songIndex.has(k)) songIndex.set(k, name); }

    charts = D.charts.map((c, i) => {
      const author = c.author && user(c.author) ? c.author : null;
      const authorName = userName(author);
      // ★ v29 追加: 合作した人（名前を公開している人だけ）
      const collab = [...new Set(Array.isArray(c.collab) ? c.collab : [])].filter((k) => k !== author && user(k));
      return { ...c, author, collab, idx: i, dkey: diffKey(c.difficulty), song: songKey(c.music), authorName, hay: norm([c.title, c.music, author ? authorName : "", ...collab.map(userName), c.id].join(" ")) };
    });
    chartById = new Map(charts.map((c) => [c.id, c]));

    const bySong = new Map(songs.map((n, i) => [n, { name: n, idx: i, charts: 0, d: {}, musics: new Set() }]));
    const other = { name: OTHER, idx: Infinity, charts: 0, d: {}, musics: new Set() };
    for (const c of charts) {
      const s = c.song === OTHER ? other : bySong.get(c.song);
      s.charts++; s.d[c.dkey] = (s.d[c.dkey] || 0) + 1;
      if (c.song === OTHER && c.music) s.musics.add(c.music);
    }
    songStats = [...bySong.values()];
    if (other.charts > 0) songStats.push(other);

    // 投稿者（名前を公開している人。譜面が無い人も入れる）。★ v29 変更: 合作した譜面も数える・プレイした譜面の数は出さない
    userStats = new Map();
    for (const [key, u] of Object.entries(D.users || {})) userStats.set(key, { id: key, name: u.name || "名前なし", charts: 0, plays: 0, likes: 0 });
    for (const c of charts) {
      for (const k of [c.author, ...c.collab]) {
        const u = k && userStats.get(k);
        if (!u) continue;
        u.charts++; u.plays += c.plays || 0; u.likes += c.likes || 0;
      }
    }

    const when = D.exportedAt ? new Date(D.exportedAt).toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" }) : "不明";
    $("meta").textContent = `${when} 時点のデータ`; // ★ 変更: サーバー名は出さない
    $("cntCharts").textContent = fmt(charts.length);
    $("cntSongs").textContent = fmt(songs.length);
    $("cntUsers").textContent = fmt(userStats.size);
    $("tabBorder").hidden = !(SITE && D.border && D.border.days > 0); // ★ v59: いいねボーダー（サイトにデータがある時だけ）

    // ★ 追加: デイリーランキング（/chart と同じ順：増えたいいねが多い順 → プレイ数が少ない順）
    daily.list = charts.filter((c) => c.daily > 0).sort(dailySorter);
    daily.rank = new Map(daily.list.map((c, i) => [c.id, i + 1]));
    daily.diff = ""; daily.shown = PAGE;
    $("cntDaily").textContent = fmt(daily.list.length);
    $("dailyNote").textContent = dailyNote();

    const songOpts = songStats.filter((s) => s.charts > 0)
      .map((s) => `<option value="${esc(s.name)}">${esc(s.name === OTHER ? "その他（曲リストに無い曲）" : s.name)}（${s.charts}）</option>`).join("");
    $("fSong").innerHTML = `<option value="">すべての曲</option>${songOpts}`;
    const users = [...userStats.values()].filter((u) => u.charts > 0).sort((a, b) => a.name.localeCompare(b.name, "ja"));
    const anonCount = charts.filter((c) => !c.author).length;
    $("fUser").innerHTML = `<option value="">すべての投稿者</option>` + users.map((u) => `<option value="${esc(u.id)}">${esc(u.name)}（${u.charts}）</option>`).join("")
      + (anonCount ? `<option value="__anon">匿名（${anonCount}）</option>` : "");
    const hasOther = charts.some((c) => c.dkey === OTHER);
    $("fDiff").innerHTML = [...DIFFS, ...(hasOther ? [OTHER] : [])]
      .map((d) => `<button type="button" class="chip" data-d="${d}" aria-pressed="false">${d === OTHER ? "その他" : d}</button>`).join("");

    resetFilters(false);
    $("loadingView").hidden = true;
    $("emptyView").hidden = true;
    $("dataView").hidden = false;
    renderSongs(); renderUsers();
  }

  // ---------- ページの切り替え（サイトでは URL も変える） ----------
  function pathOf(r) {
    if (!r || r.type === "home") return "";
    if (r.type === "chart") return `c/${encodeURIComponent(r.id)}/`;
    if (r.type === "user") return `u/${encodeURIComponent(r.id)}/`;
    if (r.type === "terms") return "terms/"; // ★ v47 追加: 利用規約
    return "";
  }
  function routeFromLocation() {
    let rel = location.pathname.startsWith(ROOT_URL.pathname) ? location.pathname.slice(ROOT_URL.pathname.length) : "";
    try { rel = decodeURIComponent(rel); } catch {}
    let m;
    if (rel === "" || rel === "index.html") return { type: "home" };
    if ((m = rel.match(/^c\/([^/]+)\/?(index\.html)?$/))) return { type: "chart", id: m[1] };
    if ((m = rel.match(/^u\/([^/]+)\/?(index\.html)?$/))) return { type: "user", id: m[1] };
    if (/^terms\/?(index\.html)?$/.test(rel)) return { type: "terms" }; // ★ v47 追加
    return { type: "notfound" };
  }
  // ★ v40: 「戻る」で1つ前のページに戻れるように、サイトの中で何ページ進んだか（depth）と、元のページのスクロール位置を覚えておく
  const trail = []; // ファイルを開いて見ている時（URL が変わらない時）の、前のページ
  let CURRENT = { type: "home" }; // ファイルを開いて見ている時の、今のページ
  function go(r) {
    if (SITE) {
      try { history.replaceState({ ...(history.state || {}), scroll: window.scrollY }, ""); } catch {}
      history.pushState({ ...r, depth: (history.state?.depth || 0) + 1 }, "", new URL(pathOf(r), ROOT_URL));
    } else {
      trail.push({ r: CURRENT, scroll: window.scrollY });
    }
    CURRENT = r;
    render(r);
    window.scrollTo({ top: 0 });
  }
  // 1つ前のページに戻る。サイトの外から開いた時（共有されたリンクなど）は一覧に行く
  function goBack() {
    if (SITE && history.state?.depth > 0) return history.back();
    if (!SITE && trail.length) {
      const prev = trail.pop();
      CURRENT = prev.r;
      render(prev.r);
      return window.scrollTo({ top: prev.scroll || 0 });
    }
    go({ type: "home" });
  }
  window.addEventListener("popstate", (e) => {
    if (!SITE || !D) return;
    render(routeFromLocation());
    window.scrollTo({ top: e.state?.scroll || 0 }); // ★ v40: 戻った時は、前に見ていた位置に戻す
  });
  function linkTo(r) { return SITE ? new URL(pathOf(r), ROOT_URL).href : "#"; }
  // a[data-go] のクリックはページを読み直さずに切り替える
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-go]");
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0 || !D) return;
    e.preventDefault();
    const t = a.dataset.go;
    if (t === "back") return goBack(); // ★ v40
    go(t === "home" ? { type: "home" } : { type: t, id: a.dataset.id });
  });
  // ★ v54 追加: ネタバレ（||…||）は押すと表示する（中のリンクは表示した後に押せる）
  document.addEventListener("click", (e) => {
    const sp = e.target.closest?.(".md-spoiler:not(.on)");
    if (!sp) return;
    e.preventDefault(); e.stopPropagation(); sp.classList.add("on");
  }, true);
  document.addEventListener("keydown", (e) => {
    const sp = e.target.closest?.(".md-spoiler:not(.on)");
    if (sp && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); sp.classList.add("on"); }
  });
  $("homeLink").addEventListener("click", (e) => { if (!D || e.ctrlKey || e.metaKey) return; e.preventDefault(); go({ type: "home" }); });

  function render(r) {
    const views = { home: "homeView", chart: "chartView", user: "userView", terms: "termsView", notfound: "notFoundView" }; // ★ v47: 利用規約
    let type = r?.type || "home";
    if (type === "chart" && !chartById.has(r.id)) type = "notfound";
    if (type === "user" && !user(r.id)) type = "notfound";
    for (const [k, id] of Object.entries(views)) $(id).hidden = k !== type;
    // ★ v47 変更: タブの名前を「譜面ビューア」から「Chart Viewer」にした
    if (type === "home") { document.title = "Chart Viewer"; showTab(state.tab); }
    else if (type === "chart") renderChartPage(chartById.get(r.id));
    else if (type === "user") renderUserPage(r.id);
    else if (type === "terms") document.title = "利用規約｜Chart Viewer";
    else document.title = "ページが見つかりません｜Chart Viewer";
  }

  // ---------- 部品 ----------
  // ★ v32 追加: 曲のジャケット画像（Bot が置いた j/ の画像だけを使う）
  const JK_RE = /^j\/[\w-]+\.(png|jpe?g|webp)$/;
  function jacketUrl(name) {
    const p = name && D.jackets && Object.prototype.hasOwnProperty.call(D.jackets, name) ? D.jackets[name] : null;
    return typeof p === "string" && JK_RE.test(p) ? new URL(p, ROOT_URL).href : null;
  }
  function jacketHtml(name, cls = "jk") {
    const u = jacketUrl(name);
    return u ? `<img class="${cls}" src="${esc(u)}" alt="" loading="lazy" decoding="async">` : `<span class="${cls} none" aria-hidden="true"></span>`;
  }
  // ★ v34 追加: 譜面の曲のジャケット（曲リストの名前で探し、無ければ譜面に書かれた曲名で探す）
  function chartJacketUrl(c) { return jacketUrl(c.song !== OTHER ? c.song : "") || jacketUrl(c.music); }
  // ★ v34 追加: 譜面の行のジャケット（サイトにジャケットがある時だけ。無い曲は斜線の四角）
  const hasJackets = () => !!(D.jackets && Object.keys(D.jackets).length);
  function rowJacketHtml(c) {
    if (!hasJackets()) return "";
    const u = chartJacketUrl(c);
    return u ? `<img class="jk jkc" src="${esc(u)}" alt="" loading="lazy" decoding="async">` : `<span class="jk jkc none" aria-hidden="true"></span>`;
  }
  function avatarHtml(key, cls = "") {
    const u = user(key);
    const ch = [...(userName(key) || "?").trim()][0] || "?";
    let url = null;
    if (u?.avatar && /^a\/[\w-]+\.png$/.test(u.avatar)) url = new URL(u.avatar, ROOT_URL).href; // ★ 修正: 譜面のページなどに移った後でも、サイトの一番上の a/ を指す
    else if (u?.avatar && /^https:\/\/(cdn|media)\.discordapp\.(com|net)\//.test(u.avatar)) url = u.avatar;
    const bg = u?.color && /^#[0-9a-fA-F]{6}$/.test(u.color) ? ` style="background:${u.color};color:${textOn(u.color)}"` : "";
    if (url) return `<img class="avatar ${cls}" src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-initial="${esc(ch)}">`;
    return `<span class="avatar ${cls}" aria-hidden="true"${bg}>${esc(key ? ch : "?")}</span>`;
  }
  function textOn(hex) {
    const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? "#20232b" : "#ffffff";
  }
  // 難易度とレベルの四角（textContent は「Master33」「Master31.4」のようになる）
  function diffBox(c) {
    const color = DIFF_COLOR[c.dkey] || "var(--d-other)";
    return `<span class="diff" style="--dc:${color}"><span class="dn">${esc(c.difficulty || "?")}</span><span class="lv${c.lv != null ? " dec" : ""}">${esc(lvText(c))}</span></span>`;
  }
  function userLink(key) {
    return `<a href="${esc(linkTo({ type: "user", id: key }))}" data-go="user" data-id="${esc(key)}">${esc(userName(key))}</a>`;
  }
  function authorHtml(c, withAvatar = true, withCollab = true) {
    // ★ v29 追加: 合作した人を「×」でつないで出す
    const co = withCollab && c.collab?.length ? c.collab.map((k) => `<span class="x">×</span>${userLink(k)}`).join("") : "";
    if (!c.author) return `<span class="anon">匿名</span>${co}`;
    return `${withAvatar ? avatarHtml(c.author) : ""}${userLink(c.author)}${co}`;
  }
  function mainHtml(c) {
    const r = { type: "chart", id: c.id };
    return `
        <div class="main">
          <a class="title" href="${esc(linkTo(r))}" data-go="chart" data-id="${esc(c.id)}">${esc(c.title || "名称未設定")}</a>${c.img ? `<span class="imgmark" title="譜面画像あり">画像</span>` : ""}
          <div class="music">${esc(c.music || "曲名不明")}${c.song === OTHER && c.music ? "（曲リストに無い曲）" : ""}</div>
          <div class="by">${authorHtml(c)}</div>
        </div>`;
  }
  function rowHtml(c) {
    return `
      <div class="card${hasJackets() ? " has-jk" : ""}" data-i="${c.idx}" style="--dc:${DIFF_COLOR[c.dkey] || "var(--d-other)"}">
        ${diffBox(c)}${rowJacketHtml(c)}
        ${mainHtml(c)}
        <div class="stats">
          <span class="num" title="プレイ数"><span class="v">${fmt(c.plays)}</span><span class="k">プレイ</span></span>
          <span class="num" title="いいね"><span class="v">${fmt(c.likes)}</span><span class="k">いいね</span></span>
        </div>
        <button type="button" class="copy" data-copy="${esc(c.id)}">IDをコピー</button>
      </div>`;
  }
  // 行のどこを押しても譜面のページへ（コピー・投稿者のリンクを除く）
  document.addEventListener("click", (e) => {
    const copy = e.target.closest("[data-copy]");
    if (copy) { e.preventDefault(); copyText(copy.dataset.copy, "譜面IDをコピーしました"); return; }
    if (e.target.closest("a")) return;
    const card = e.target.closest(".card");
    if (card && D) go({ type: "chart", id: charts[Number(card.dataset.i)].id });
  });

  // ---------- 一覧（譜面） ----------
  function filtered() {
    const q = norm(state.q);
    const min = state.lvMin === "" ? -Infinity : Number(state.lvMin);
    const max = state.lvMax === "" ? Infinity : Number(state.lvMax);
    const list = charts.filter((c) => {
      const v = lvValue(c);
      return (!q || c.hay.includes(q)) &&
        (!state.song || c.song === state.song) &&
        (state.diffs.size === 0 || state.diffs.has(c.dkey)) &&
        (v == null ? (min === -Infinity && max === Infinity) : (v >= min && (Number.isInteger(max) ? Math.floor(v) <= max : v <= max))) &&
        (!state.user || (state.user === "__anon" ? !c.author : c.author === state.user || c.collab.includes(state.user))); // ★ v29 変更: 合作した譜面も
    });
    return list.sort(sorter(state.sort));
  }
  function sorter(k) {
    return {
      new: (a, b) => b.order - a.order,
      old: (a, b) => a.order - b.order,
      plays: (a, b) => b.plays - a.plays || b.order - a.order,
      likes: (a, b) => b.likes - a.likes || b.order - a.order,
      lvDesc: (a, b) => (lvValue(b) || 0) - (lvValue(a) || 0) || b.order - a.order,
      lvAsc: (a, b) => (lvValue(a) || 99) - (lvValue(b) || 99) || b.order - a.order,
      title: (a, b) => a.title.localeCompare(b.title, "ja")
    }[k] || ((a, b) => b.order - a.order);
  }
  function renderCharts() {
    const list = filtered();
    $("result").innerHTML = `<b>${fmt(list.length)}</b>件`;
    $("grid").innerHTML = list.slice(0, state.shown).map(rowHtml).join("");
    $("none").hidden = list.length > 0;
    $("moreBtn").hidden = list.length <= state.shown;
    $("moreBtn").textContent = `さらに表示（残り ${fmt(list.length - state.shown)}件）`;
    renderActive();
  }
  function renderActive() {
    const items = [];
    if (state.q) items.push(["q", `キーワード「${state.q}」`]);
    if (state.song) items.push(["song", `曲「${state.song === OTHER ? "その他" : state.song}」`]);
    if (state.diffs.size) items.push(["diffs", `難易度 ${[...state.diffs].map((d) => (d === OTHER ? "その他" : d)).join("、")}`]);
    if (state.lvMin !== "" || state.lvMax !== "") items.push(["lv", `レベル ${state.lvMin || "?"}〜${state.lvMax || "?"}`]);
    if (state.user) items.push(["user", `投稿者「${state.user === "__anon" ? "匿名" : userName(state.user)}」`]);
    $("activeFilters").innerHTML = items.length
      ? `絞り込み中：` + items.map(([k, t]) => `<span>${esc(t)}<button type="button" data-clear="${k}" aria-label="${esc(t)}を外す">外す</button></span>`).join("")
      : "";
  }
  function syncInputs() {
    $("q").value = state.q; $("fSong").value = state.song; $("lvMin").value = state.lvMin; $("lvMax").value = state.lvMax;
    $("fUser").value = state.user; $("sort").value = state.sort;
    for (const b of $("fDiff").children) b.setAttribute("aria-pressed", String(state.diffs.has(b.dataset.d)));
  }
  function resetFilters(renderNow = true) {
    Object.assign(state, { q: "", song: "", lvMin: "", lvMax: "", user: "", shown: PAGE });
    state.diffs = new Set();
    syncInputs();
    if (renderNow) renderCharts();
  }
  const update = () => { state.shown = PAGE; renderCharts(); };
  $("q").addEventListener("input", (e) => { state.q = e.target.value; update(); });
  $("fSong").addEventListener("change", (e) => { state.song = e.target.value; update(); });
  $("fUser").addEventListener("change", (e) => { state.user = e.target.value; update(); });
  $("lvMin").addEventListener("input", (e) => { state.lvMin = e.target.value; update(); });
  $("lvMax").addEventListener("input", (e) => { state.lvMax = e.target.value; update(); });
  $("sort").addEventListener("change", (e) => { state.sort = e.target.value; update(); });
  $("fDiff").addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    const d = b.dataset.d;
    state.diffs.has(d) ? state.diffs.delete(d) : state.diffs.add(d);
    b.setAttribute("aria-pressed", String(state.diffs.has(d)));
    update();
  });
  $("resetBtn").addEventListener("click", () => resetFilters());
  $("toggleFilters").addEventListener("click", () => $("filters").classList.toggle("collapsed"));
  $("moreBtn").addEventListener("click", () => { state.shown += PAGE; renderCharts(); });
  $("activeFilters").addEventListener("click", (e) => {
    const k = e.target.closest("button")?.dataset.clear; if (!k) return;
    if (k === "diffs") state.diffs = new Set();
    else if (k === "lv") { state.lvMin = ""; state.lvMax = ""; }
    else state[k] = "";
    syncInputs(); update();
  });

  // ---------- デイリーランキング ----------
  function dailySorter(a, b) { return b.daily - a.daily || (a.plays || 0) - (b.plays || 0) || a.order - b.order; }
  // 集計した日（その日の4:00に集計）から「M月D日 4:00〜M月D日 4:00」を作る
  function dailyPeriod() {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(D?.daily?.date || "");
    if (!m) return null;
    const end = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    const start = new Date(end.getTime() - 86400000);
    const md = (d) => `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
    return { start: md(start), end: md(end) };
  }
  function dailyNote() {
    if (!D.daily) return "このデータにはデイリーランキングが入っていません（新しい Bot で書き出すと入ります）";
    const p = dailyPeriod();
    return p ? `${p.start} 4:00〜${p.end} 4:00` : "前の日"; // ★ v33 変更: 「に増えたいいねの数の順（/chart のデイリーと同じ）」を消した
  }
  function rankRowHtml(c, rank) {
    return `
      <div class="card ranked${hasJackets() ? " has-jk" : ""}" data-i="${c.idx}" style="--dc:${DIFF_COLOR[c.dkey] || "var(--d-other)"}">
        <span class="rk${rank <= 3 ? " top" : ""}"><span class="n">${rank}</span><span class="u">位</span></span>
        ${diffBox(c)}${rowJacketHtml(c)}
        ${mainHtml(c)}
        <div class="stats">
          <span class="num gain" title="増えたいいね"><span class="v">+${fmt(c.daily)}</span><span class="k">増えたいいね</span></span>
          <span class="num" title="プレイ数"><span class="v">${fmt(c.plays)}</span><span class="k">プレイ</span></span>
          <span class="num" title="いいねの合計"><span class="v">${fmt(c.likes)}</span><span class="k">いいね合計</span></span>
        </div>
        <button type="button" class="copy" data-copy="${esc(c.id)}">IDをコピー</button>
      </div>`;
  }
  function renderDaily() {
    const list = daily.diff ? daily.list.filter((c) => c.difficulty === daily.diff) : daily.list;
    for (const b of $("dailyDiff").children) b.setAttribute("aria-pressed", String(b.dataset.d === daily.diff));
    $("dailyList").innerHTML = list.slice(0, daily.shown).map((c, i) => rankRowHtml(c, i + 1)).join("");
    $("dailyNone").hidden = list.length > 0;
    $("dailyNone").textContent = !D.daily ? "デイリーランキングはありません。" : daily.diff ? `${daily.diff} の譜面で増えたいいねはありませんでした。` : "この日に増えたいいねはありませんでした。";
    $("dailyMore").hidden = list.length <= daily.shown;
    $("dailyMore").textContent = `さらに表示（残り ${fmt(list.length - daily.shown)}件）`;
  }
  $("dailyDiff").addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    daily.diff = b.dataset.d; daily.shown = PAGE; renderDaily();
  });
  $("dailyMore").addEventListener("click", () => { daily.shown += PAGE; renderDaily(); });

  // ---------- ★ v59 追加: いいねボーダー ----------
  //   data/border.json（Bot が prsk_border のデータから作る）を、タブを開いた時に読む
  const BD_CATS = [
    { k: "all", name: "すべて", color: "var(--b-all)" },
    { k: "append", name: "APPEND", color: "var(--b-append)" },
    { k: "master", name: "MASTER", color: "var(--b-master)" }
  ];
  const BD_RANKS = [1, 10, 20, 30];
  const BD_RANK_COLORS = ["var(--bt-1)", "var(--bt-2)", "var(--bt-3)", "var(--bt-4)"];
  const WD = ["日", "月", "火", "水", "木", "金", "土"];
  const bd = { data: null, loading: null, failed: false, mode: "week", idx: 0, cat: "all" };
  const mdOf = (s) => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;
  const wdOf = (s) => WD[new Date(`${s}T00:00:00Z`).getUTCDay()];
  const bdNum = (v) => (v === null || v === undefined ? "—" : fmt(v));
  const bdList = () => (bd.mode === "week" ? bd.data.weeks : bd.data.days); // 古い順
  const bdLabel = (p, long) => bd.mode === "week"
    ? `${mdOf(p.start)}（月）〜${mdOf(p.end)}（日）${long ? `・${p.days}日分` : ""}`
    : `${long ? p.date.slice(0, 4) + "/" : ""}${mdOf(p.date)}（${wdOf(p.date)}）`;
  const bdShort = (p) => (bd.mode === "week" ? `${mdOf(p.start)}〜` : mdOf(p.date));
  const bdRow = (p) => (bd.mode === "week" ? `${mdOf(p.start)}〜${mdOf(p.end)}` : `${mdOf(p.date)}（${wdOf(p.date)}）`); // 表の行の名前（短く）

  function bdValid(x) {
    const okArr = (a) => Array.isArray(a) && a.length <= 30 && a.every((v) => v === null || Number.isFinite(v));
    const okDay = /^\d{4}-\d{2}-\d{2}$/;
    return x && x.format === "prsk-border" && Array.isArray(x.days) && Array.isArray(x.weeks)
      && x.days.every((d) => okDay.test(d.date) && BD_CATS.every((c) => okArr(d[c.k])))
      && x.weeks.every((w) => okDay.test(w.start) && okDay.test(w.end) && BD_CATS.every((c) => okArr(w[c.k])));
  }
  function loadBorder() {
    if (bd.data || bd.loading) return bd.loading;
    bd.failed = false;
    bd.loading = fetch(BASE + "data/border.json?v=" + encodeURIComponent((D.border && D.border.last) || ""), { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((x) => {
        if (!bdValid(x)) throw new Error("bad");
        bd.data = x;
        if (!x.weeks.length) bd.mode = "day";
        bd.idx = bdList().length - 1;
        syncBorderTools();
      })
      .catch(() => { bd.failed = true; })
      .finally(() => { bd.loading = null; if (state.tab === "border" && !$("tab-border").hidden) renderBorder(); });
    return bd.loading;
  }
  function syncBorderTools() {
    for (const b of $("bdMode").querySelectorAll(".chip")) {
      b.setAttribute("aria-pressed", String(b.dataset.m === bd.mode));
      b.disabled = b.dataset.m === "week" && !bd.data.weeks.length;
    }
    const list = bdList();
    $("bdWhen").innerHTML = list.map((p, i) => `<option value="${i}">${esc(bdLabel(p, true))}</option>`).reverse().join("");
    $("bdWhen").value = String(bd.idx);
    $("bdNote").textContent = bd.data.days.length ? `${bd.data.days[0].date.replace(/-/g, "/")}〜${bd.data.days[bd.data.days.length - 1].date.replace(/-/g, "/")} のデータ` : "";
  }
  $("bdMode").addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b || b.disabled || !bd.data || b.dataset.m === bd.mode) return;
    bd.mode = b.dataset.m; bd.idx = bdList().length - 1; syncBorderTools(); renderBorder();
  });
  $("bdWhen").addEventListener("change", (e) => { bd.idx = Number(e.target.value) || 0; renderBorder(); });

  function renderBorder() {
    const body = $("bdBody");
    if (!bd.data) {
      if (bd.failed) body.innerHTML = `<div class="none">ボーダーのデータを読み込めませんでした。時間をおいてページを開き直してください。</div>`;
      else { body.innerHTML = `<div class="loading">読み込み中…</div>`; loadBorder(); }
      return;
    }
    const list = bdList();
    const p = list[bd.idx];
    if (!p) { body.innerHTML = `<div class="none">まだボーダーのデータがありません。</div>`; return; }
    const what = bd.mode === "week" ? `${bdLabel(p, false)} の平均（${p.days}日分）` : `${bdLabel(p, true)}`;
    body.innerHTML = `
      <p class="bd-about">@prsk_chart（譜面メーカーまとめ）のデイリーランキング画像から集計した、各順位の譜面が1日に増やしたいいね数です。前の日の画像に同じ譜面が載っていない順位は「—」です。</p>
      <section class="bd-block">
        <h3>順位ごとのボーダー<span class="bd-what">${esc(what)}</span></h3>
        <div class="bd-grid">
          <div class="bd-chart" id="bdRankChart"></div>
          <div class="bd-table"><table>
            <caption class="sr">順位ごとのボーダー（${esc(what)}）</caption>
            <thead><tr><th scope="col">順位</th>${BD_CATS.map((c) => `<th scope="col"><i style="--dc:${c.color}"></i>${c.name}</th>`).join("")}</tr></thead>
            <tbody>${Array.from({ length: 30 }, (_, i) => `<tr><th scope="row">${i + 1}位</th>${BD_CATS.map((c) => `<td>${bdNum(p[c.k][i])}</td>`).join("")}</tr>`).join("")}</tbody>
          </table></div>
        </div>
      </section>
      <section class="bd-block">
        <h3>ボーダーの移り変わり<span class="bd-what">${bd.mode === "week" ? "週の平均" : "日ごと"}・${BD_RANKS.map((r) => r + "位").join("・")}</span></h3>
        <div class="tools bd-tools">
          <div class="seg" id="bdCat" role="group" aria-label="ランキングの種類">${BD_CATS.map((c) => `<button type="button" class="chip" data-c="${c.k}" aria-pressed="${c.k === bd.cat}">${c.name}</button>`).join("")}</div>
        </div>
        <div class="bd-grid">
          <div class="bd-chart" id="bdTrendChart"></div>
          <div class="bd-table"><table>
            <caption class="sr">ボーダーの移り変わり（${esc(BD_CATS.find((c) => c.k === bd.cat).name)}）</caption>
            <thead><tr><th scope="col">${bd.mode === "week" ? "週" : "日"}</th>${BD_RANKS.map((r, i) => `<th scope="col"><i style="--dc:${BD_RANK_COLORS[i]}"></i>${r}位</th>`).join("")}</tr></thead>
            <tbody>${list.map((q, j) => `<tr${j === bd.idx ? ' class="on"' : ""}><th scope="row">${esc(bdRow(q))}</th>${BD_RANKS.map((r) => `<td>${bdNum(q[bd.cat][r - 1])}</td>`).join("")}</tr>`).reverse().join("")}</tbody>
          </table></div>
        </div>
      </section>`;
    $("bdCat").addEventListener("click", (e) => {
      const b = e.target.closest(".chip"); if (!b || b.dataset.c === bd.cat) return;
      bd.cat = b.dataset.c; renderBorder();
    });
    drawBorderCharts();
  }
  function drawBorderCharts() {
    if (!bd.data || !$("bdRankChart")) return;
    const list = bdList();
    const p = list[bd.idx];
    lineChart($("bdRankChart"), {
      labels: Array.from({ length: 30 }, (_, i) => `${i + 1}`),
      tipTitle: (i) => `${i + 1}位`,
      xTicks: (i) => i === 0 || (i + 1) % 5 === 0,
      xName: "順位",
      series: BD_CATS.map((c) => ({ name: c.name, color: c.color, values: Array.from({ length: 30 }, (_, i) => p[c.k][i] ?? null) }))
    });
    const every = Math.max(1, Math.ceil(list.length / 8));
    lineChart($("bdTrendChart"), {
      labels: list.map(bdShort),
      tipTitle: (i) => bdLabel(list[i], true),
      xTicks: (i) => (list.length - 1 - i) % every === 0,
      mark: bd.idx,
      series: BD_RANKS.map((r, j) => ({ name: `${r}位`, color: BD_RANK_COLORS[j], values: list.map((q) => q[bd.cat][r - 1] ?? null) }))
    });
  }
  let bdResize;
  window.addEventListener("resize", () => { clearTimeout(bdResize); bdResize = setTimeout(() => { if (state.tab === "border" && !$("tab-border").hidden && !$("homeView").hidden) drawBorderCharts(); }, 150); });

  // 折れ線グラフ（SVG）。値の無い所は線を切る。マウス・指・矢印キーで値を表示
  function lineChart(el, { labels, series, tipTitle, xTicks = () => true, xName = "", mark = -1 }) {
    const W = Math.max(300, Math.round(el.clientWidth || 640)), H = 280;
    const m = { l: 40, r: 64, t: 12, b: xName ? 40 : 28 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const n = labels.length;
    const all = series.flatMap((s) => s.values).filter((v) => v !== null);
    const step = niceStep(Math.max(1, ...all) / 4);
    const yMax = Math.max(step, Math.ceil(Math.max(1, ...all) / step) * step);
    const x = (i) => m.l + (n === 1 ? iw / 2 : (iw * i) / (n - 1));
    const y = (v) => m.t + ih - (ih * v) / yMax;
    const grid = [];
    for (let v = 0; v <= yMax + 1e-9; v += step) grid.push(`<line class="g" x1="${m.l}" x2="${m.l + iw}" y1="${y(v)}" y2="${y(v)}"/><text class="yl" x="${m.l - 6}" y="${y(v)}" dy="4">${fmt(v)}</text>`);
    const xs = labels.map((t, i) => (xTicks(i) ? `<text class="xl" x="${x(i)}" y="${m.t + ih + 18}">${esc(t)}</text>` : "")).join("");
    const half = n > 1 ? iw / (n - 1) / 2 : iw / 2;
    const bx0 = Math.max(m.l, x(mark) - half), bx1 = Math.min(m.l + iw, x(mark) + half); // 選んだ日・週の帯（グラフの外には出さない）
    const band = mark >= 0 ? `<rect class="band" x="${bx0}" y="${m.t}" width="${Math.max(0, bx1 - bx0)}" height="${ih}"/>` : "";
    const lines = series.map((s, si) => {
      let d = "", pen = false;
      s.values.forEach((v, i) => { if (v === null) { pen = false; return; } d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; });
      const dots = s.values.map((v, i) => (v === null ? "" : `<circle class="pt" data-s="${si}" data-i="${i}" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="4"/>`)).join("");
      return `<g style="--sc:${s.color}"><path class="ln" d="${d}"/>${dots}</g>`;
    }).join("");
    // 線の右端に名前（重ならないようにずらす）
    const ends = series.map((s, si) => { let i = s.values.length - 1; while (i >= 0 && s.values[i] === null) i--; return i < 0 ? null : { si, i, yy: y(s.values[i]) }; }).filter(Boolean).sort((a, b) => a.yy - b.yy);
    for (let k = 1; k < ends.length; k++) if (ends[k].yy - ends[k - 1].yy < 14) ends[k].yy = ends[k - 1].yy + 14;
    const labs = ends.map((e) => `<text class="el" x="${x(e.i) + 8}" y="${e.yy}" dy="4">${esc(series[e.si].name)}</text>`).join("");
    el.innerHTML = `
      <div class="bd-legend">${series.map((s) => `<span><i style="--dc:${s.color}"></i>${esc(s.name)}</span>`).join("")}</div>
      <div class="bd-plot">
        <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(series.map((s) => s.name).join("・"))}の折れ線グラフ（数は下の表にもあります）" tabindex="0">
          ${band}${grid.join("")}<line class="ax" x1="${m.l}" x2="${m.l + iw}" y1="${m.t + ih}" y2="${m.t + ih}"/>${xs}
          ${xName ? `<text class="xn" x="${m.l + iw / 2}" y="${H - 4}">${esc(xName)}</text>` : ""}
          <line class="cross" y1="${m.t}" y2="${m.t + ih}" x1="0" x2="0" visibility="hidden"/>
          ${lines}${labs}
          <rect class="hit" x="${m.l - 10}" y="0" width="${iw + 20}" height="${H}"/>
        </svg>
        <div class="bd-tip" hidden></div>
      </div>`;
    const svg = el.querySelector("svg"), tip = el.querySelector(".bd-tip"), cross = el.querySelector(".cross");
    let cur = -1;
    const show = (i) => {
      cur = Math.max(0, Math.min(n - 1, i));
      cross.setAttribute("x1", x(cur)); cross.setAttribute("x2", x(cur)); cross.setAttribute("visibility", "visible");
      for (const c of svg.querySelectorAll(".pt")) c.classList.toggle("on", Number(c.dataset.i) === cur);
      tip.innerHTML = `<b>${esc(tipTitle(cur))}</b>${series.map((s) => `<span><i style="--dc:${s.color}"></i>${esc(s.name)}<em>${bdNum(s.values[cur])}</em></span>`).join("")}`;
      tip.hidden = false;
      const sx = svg.getBoundingClientRect().width / W;
      const px = x(cur) * sx, tw = tip.offsetWidth, pw = el.querySelector(".bd-plot").clientWidth;
      tip.style.left = `${Math.max(0, Math.min(pw - tw, px + (px + 14 + tw > pw ? -tw - 14 : 14)))}px`;
    };
    const hide = () => { cur = -1; tip.hidden = true; cross.setAttribute("visibility", "hidden"); for (const c of svg.querySelectorAll(".pt.on")) c.classList.remove("on"); };
    const idxAt = (cx) => { const r = svg.getBoundingClientRect(); const vx = ((cx - r.left) * W) / r.width; return n === 1 ? 0 : Math.round(((vx - m.l) * (n - 1)) / iw); };
    svg.addEventListener("pointermove", (e) => show(idxAt(e.clientX)));
    svg.addEventListener("pointerdown", (e) => show(idxAt(e.clientX)));
    svg.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") hide(); });
    svg.addEventListener("blur", hide);
    svg.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); show(cur < 0 ? (e.key === "ArrowRight" ? 0 : n - 1) : cur + (e.key === "ArrowRight" ? 1 : -1)); }
      else if (e.key === "Escape") hide();
    });
  }
  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }

  // ---------- タブ ----------
  function showTab(name) {
    if (name === "border" && $("tabBorder").hidden) name = "charts"; // ★ v59: ボーダーのデータが無いサイト
    state.tab = name;
    for (const t of document.querySelectorAll(".tab")) t.setAttribute("aria-selected", String(t.dataset.tab === name));
    for (const n of ["charts", "daily", "songs", "users", "border"]) $("tab-" + n).hidden = n !== name; // ★ v59: いいねボーダー
    if (name === "charts") renderCharts();
    if (name === "daily") renderDaily();
    if (name === "border") renderBorder();
  }
  document.querySelector(".tabs").addEventListener("click", (e) => { const t = e.target.closest(".tab"); if (t) { showTab(t.dataset.tab); window.scrollTo({ top: 0 }); } });
  function goCharts(patch) {
    resetFilters(false);
    Object.assign(state, patch);
    syncInputs();
    state.tab = "charts";
    go({ type: "home" });
  }

  // ---------- 曲 ----------
  function diffCounts(d) {
    return `<span class="counts" aria-label="難易度別の譜面数">${[...DIFFS, OTHER].filter((k) => k !== OTHER || d[OTHER])
      .map((k) => `<span class="${d[k] ? "" : "zero"}" style="--dc:${DIFF_COLOR[k] || "var(--d-other)"}" title="${k === OTHER ? "その他" : k}">${d[k] || 0}</span>`).join("")}</span>`;
  }
  function renderSongs() {
    const q = norm($("songQ").value);
    const hasOnly = $("songHasOnly").checked;
    const list = songStats.filter((s) => (!hasOnly || s.charts > 0) && (!q || norm(s.name === OTHER ? "その他" : s.name).includes(q) || (s.name === OTHER && [...s.musics].some((m) => norm(m).includes(q)))));
    const sort = $("songSort").value;
    if (sort === "count") list.sort((a, b) => b.charts - a.charts || a.idx - b.idx);
    else if (sort === "name") list.sort((a, b) => (a.name === OTHER) - (b.name === OTHER) || a.name.localeCompare(b.name, "ja"));
    else list.sort((a, b) => a.idx - b.idx);
    const showJk = hasJackets(); // ★ v32: ジャケットがある時だけ（ファイルを読み込んで見る時は出さない）
    $("songList").innerHTML = list.map((s) => {
      const isOther = s.name === OTHER;
      const sub = isOther
        ? `曲リストに無い曲名：${esc([...s.musics].slice(0, 8).join("、"))}${s.musics.size > 8 ? ` ほか${s.musics.size - 8}曲` : ""}`
        : (s.charts ? `譜面 ${s.charts}件` : "譜面はまだありません");
      return `<button type="button" class="item ${showJk ? "song" : ""} ${isOther ? "other" : ""}" data-song="${esc(s.name)}" ${s.charts ? "" : "disabled"}>
        ${showJk ? jacketHtml(isOther ? "" : s.name) : ""}
        <span><span class="name">${esc(isOther ? "その他" : s.name)}</span><span class="sub">${sub}</span></span>
        ${diffCounts(s.d)}
      </button>`;
    }).join("") || `<div class="none">見つかりませんでした</div>`;
  }
  ["input", "change"].forEach((ev) => { $("songQ").addEventListener(ev, renderSongs); $("songSort").addEventListener(ev, renderSongs); $("songHasOnly").addEventListener(ev, renderSongs); });
  $("songList").addEventListener("click", (e) => { const b = e.target.closest(".item"); if (b && !b.disabled) goCharts({ song: b.dataset.song }); });

  // ---------- 投稿者 ----------
  function renderUsers() {
    const q = norm($("userQ").value);
    const list = [...userStats.values()].filter((u) => !q || norm(u.name).includes(q));
    const k = $("userSort").value;
    list.sort(k === "name" ? (a, b) => a.name.localeCompare(b.name, "ja") : (a, b) => b[k] - a[k] || b.charts - a.charts);
    $("userList").innerHTML = list.map((u) => `
      <a class="item" href="${esc(linkTo({ type: "user", id: u.id }))}" data-go="user" data-id="${esc(u.id)}" style="color:inherit;text-decoration:none">
        <span class="name">${avatarHtml(u.id, "lg")}<span>${esc(u.name)}</span></span>
        <span class="ustats">
          <span class="num"><span class="v">${fmt(u.charts)}</span><span class="k">譜面</span></span>
          <span class="num"><span class="v">${fmt(u.plays)}</span><span class="k">合計プレイ</span></span>
          <span class="num"><span class="v">${fmt(u.likes)}</span><span class="k">合計いいね</span></span>
        </span>
      </a>`).join("") || `<div class="none">名前を公開している人はまだいません。Discord の /mypage で公開できます。</div>`;
  }
  ["input", "change"].forEach((ev) => { $("userQ").addEventListener(ev, renderUsers); $("userSort").addEventListener(ev, renderUsers); });

  // ---------- 譜面のページ ----------
  function relList(list) {
    return `<div class="rel">${list.map((c) => `<a href="${esc(linkTo({ type: "chart", id: c.id }))}" data-go="chart" data-id="${esc(c.id)}">${diffBox(c)}<span class="t">${esc(c.title || "名称未設定")}</span><span class="n">${fmt(c.plays)}プレイ</span></a>`).join("")}</div>`;
  }
  // ★ v54 追加: Discord の文字装飾（説明・自己紹介）。中身はすべて esc してから組み立てるので、HTML は入らない
  //   太字 **  斜体 * _  下線 __  打ち消し ~~  ネタバレ ||  コード ` ```  見出し # ## ###  小さい文字 -#  引用 > >>>  箇条書き - * 1.
  //   リンク [文字](https://…)・<https://…>・そのままの URL。\* のように \ を付けると記号のまま出す
  const MD_URL = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&()*+,;=%]+/y;
  function mdLink(url, inner) {
    return `<a href="${esc(url)}" target="_blank" rel="noopener nofollow ugc">${inner}</a>`;
  }
  function mdUrl(m) { // 文の終わりの記号・対になっていない ) は URL に入れない（v43 と同じ）
    let u = m;
    while (/[.,!?:;*~]$/.test(u) || (u.endsWith(")") && (u.match(/\(/g) || []).length < (u.match(/\)/g) || []).length)) u = u.slice(0, -1);
    return u.length > 8 ? u : null;
  }
  const MD_RULES = [
    [/\\([^A-Za-z0-9\s])/y, (m) => esc(m[1])],
    [/(`+)([\s\S]*?[^`])\1(?!`)/y, (m) => `<code class="md-code">${esc(m[2].replace(/^ ([\s\S]*\S[\s\S]*) $/, "$1"))}</code>`],
    [/\[([^\[\]\n]+)\]\(\s*<?(https?:\/\/[^\s<>()]+(?:\([^\s<>()]*\)[^\s<>()]*)*)>?\s*\)/y, (m, lk) => lk ? null : mdLink(m[2], mdInline(m[1], true))],
    [/<(https?:\/\/[^\s<>]+)>/y, (m, lk) => lk ? null : mdLink(m[1], esc(m[1]))],
    [/\*\*((?:\\[\s\S]|[^\\])+?)\*\*(?!\*)/y, (m, lk) => `<strong>${mdInline(m[1], lk)}</strong>`],
    [/__((?:\\[\s\S]|[^\\])+?)__(?!_)/y, (m, lk) => `<u>${mdInline(m[1], lk)}</u>`],
    [/\b_((?:__|\\[\s\S]|[^\\_])+?)_\b|\*(?=\S)((?:\*\*|\\[\s\S]|\s+(?:\\[\s\S]|[^\s*\\]|\*\*)|[^\s*\\])+?)\*(?!\*)/y, (m, lk) => `<em>${mdInline(m[1] ?? m[2], lk)}</em>`],
    [/~~([\s\S]+?)~~/y, (m, lk) => `<s>${mdInline(m[1], lk)}</s>`],
    [/\|\|([\s\S]+?)\|\|/y, (m, lk) => `<span class="md-spoiler" tabindex="0" role="button" aria-label="ネタバレ（押すと表示）">${mdInline(m[1], lk)}</span>`]
  ];
  function mdInline(src, inLink = false) {
    let out = "", text = "", i = 0;
    const flush = () => { out += esc(text); text = ""; };
    while (i < src.length) {
      let done = false;
      if (!inLink && (src[i] === "h" || src[i] === "H")) {
        MD_URL.lastIndex = i;
        const m = MD_URL.exec(src);
        const u = m && mdUrl(m[0]);
        if (u && (i === 0 || !/[A-Za-z0-9]/.test(src[i - 1]))) { flush(); out += mdLink(u, esc(u)); i += u.length; continue; }
      }
      if ("\\`[<*_~|".includes(src[i])) {
        for (const [re, fn] of MD_RULES) {
          re.lastIndex = i;
          const m = re.exec(src);
          if (!m) continue;
          const html = fn(m, inLink);
          if (html == null) continue;
          flush(); out += html; i += m[0].length; done = true; break;
        }
      }
      if (!done) text += src[i++];
    }
    flush();
    return out;
  }
  // 行ごとの装飾。ブロック（見出し・引用・箇条書き・コード）の後ろの改行は、pre-wrap で空行が増えないように取る
  function mdBlocks(src, inQuote = false) {
    const lines = src.split("\n");
    let out = "", buf = [];
    const flushText = () => { if (buf.length) { out += mdInline(buf.join("\n")); buf = []; } };
    for (let k = 0; k < lines.length; k++) {
      const line = lines[k];
      let m;
      if (!inQuote && /^>>> /.test(line)) {
        flushText();
        out += `<blockquote class="md-quote">${mdBlocks([line.slice(4), ...lines.slice(k + 1)].join("\n"), true)}</blockquote>`;
        return out;
      }
      if (!inQuote && /^> /.test(line)) {
        flushText();
        const q = [];
        while (k < lines.length && /^> /.test(lines[k])) q.push(lines[k++].slice(2));
        k--;
        out += `<blockquote class="md-quote">${mdBlocks(q.join("\n"), true)}</blockquote>`;
        continue;
      }
      if ((m = /^(#{1,3}) (.*\S.*)$/.exec(line))) { flushText(); out += `<span class="md-h md-h${m[1].length}">${mdInline(m[2].trim())}</span>`; continue; }
      if ((m = /^-# (.*\S.*)$/.exec(line))) { flushText(); out += `<span class="md-sub">${mdInline(m[1].trim())}</span>`; continue; }
      if (/^ *(?:[-*]|\d{1,9}\.) +\S/.test(line)) {
        flushText();
        const items = [];
        while (k < lines.length && (m = /^( *)([-*]|\d{1,9}\.) +(.*\S.*)$/.exec(lines[k]))) { items.push({ lv: Math.min(Math.floor(m[1].length / 2), 3), ol: m[2] !== "-" && m[2] !== "*" ? parseInt(m[2], 10) : null, t: m[3] }); k++; }
        k--;
        let html = "", cur = null;
        for (const it of items) {
          const tag = it.ol != null ? "ol" : "ul";
          if (!cur || cur.tag !== tag) { if (cur) html += `</${cur.tag}>`; cur = { tag }; html += tag === "ol" ? `<ol class="md-list" start="${it.ol}">` : `<ul class="md-list">`; }
          html += `<li class="md-lv${it.lv}">${mdInline(it.t)}</li>`;
        }
        out += html + `</${cur.tag}>`;
        continue;
      }
      buf.push(line);
    }
    flushText();
    return out;
  }
  function mdHtml(text) {
    const src = String(text ?? "").replace(/\r\n?/g, "\n");
    let out = "", last = 0;
    const re = /```(?:([A-Za-z0-9_+\-.#]+)?\n)?\n*([\s\S]*?)\n*```/g;
    for (let m; (m = re.exec(src));) {
      if (!m[2]) continue; // 中身が空の ``` は文字のまま
      out += mdBlocks(src.slice(last, m.index).replace(/\n$/, "")) + `<pre class="md-pre"><code>${esc(m[2])}</code></pre>`;
      last = re.lastIndex;
      if (src[last] === "\n") last++;
    }
    return out + mdBlocks(src.slice(last));
  }
  // ★ v43 追加: 譜面の説明（作者が /mypage で書いた文。改行はそのまま、http(s) の URL はリンクにする）
  function noteHtml(c) {
    const text = typeof c.note === "string" ? c.note.trim() : "";
    if (!text) return "";
    return `<section class="cnote"><h3>説明</h3><div class="md">${mdHtml(text)}</div></section>`; // ★ v54 変更: Discord の文字装飾を表示する
  }
  function shareHtml(label) {
    return SITE ? `<div class="share"><button class="btn" type="button" data-share>${label}</button></div>` : "";
  }
  function renderChartPage(c) {
    document.title = `${c.title || "名称未設定"}（${c.difficulty} ${lvText(c)}）｜Chart Viewer`;
    const guildId = D.guild?.id;
    const threadUrl = guildId && /^\d+$/.test(guildId) && c.thread && /^\d+$/.test(c.thread) ? `https://discord.com/channels/${guildId}/${c.thread}` : null;
    // ★ v29 追加: 関連する譜面（作者が選んだもの）。ほかの一覧には重ねて出さない
    const rel = (Array.isArray(c.rel) ? c.rel : []).map((id) => chartById.get(id)).filter((x) => x && x !== c);
    const relIds = new Set(rel.map((x) => x.id));
    const sameAuthor = c.author ? charts.filter((x) => x.author === c.author && x !== c && !relIds.has(x.id)).sort((a, b) => b.order - a.order).slice(0, 8) : [];
    const sameSong = c.song !== OTHER ? charts.filter((x) => x.song === c.song && x !== c && !relIds.has(x.id)).sort((a, b) => b.plays - a.plays).slice(0, 8) : [];
    const jk = chartJacketUrl(c); // ★ v32 追加: 曲のジャケット（★ v34: 一覧の行と同じ探し方を関数にした）
    $("chartView").innerHTML = `
      <a class="back" href="${esc(linkTo({ type: "home" }))}" data-go="back">戻る</a>
      <div class="chart-head${jk ? " has-jk" : ""}" style="--dc:${DIFF_COLOR[c.dkey] || "var(--d-other)"}">${diffBox(c)}<div><h2>${esc(c.title || "名称未設定")}</h2><div class="music">${esc(c.music || "曲名不明")}</div></div>${jk ? `<img class="jk-head" src="${esc(jk)}" alt="${esc(c.music || "")} のジャケット" decoding="async">` : ""}</div>
      <dl class="kv">
        <dt>譜面ID</dt><dd><code>${esc(c.id)}</code><button class="copy" type="button" data-copy="${esc(c.id)}">コピー</button></dd>
        <dt>投稿者</dt><dd>${authorHtml(c, true, false)}</dd>
        ${c.collab.length ? `<dt>合作</dt><dd class="collab">${c.collab.map((k) => `<span class="who">${avatarHtml(k)}${userLink(k)}</span>`).join("")}</dd>` : ""}
        <dt>レベル</dt><dd><span class="big">${esc(lvText(c))}</span><span class="note">${esc(c.difficulty || "")}</span></dd>
        <dt>曲</dt><dd>${esc(c.music || "不明")}${c.song === OTHER ? '<span class="note">（曲リストに無いので「その他」に入ります）</span>' : ""}</dd>
        <dt>プレイ数</dt><dd><span class="big">${fmt(c.plays)}</span></dd>
        <dt>いいね</dt><dd><span class="big">${fmt(c.likes)}</span></dd>
        ${c.daily > 0 ? `<dt>デイリー</dt><dd><span class="big">+${fmt(c.daily)}</span><span class="note">${fmt(daily.rank.get(c.id))}位${dailyPeriod() ? `（${dailyPeriod().start} 4:00〜${dailyPeriod().end} 4:00 に増えたいいね）` : ""}</span></dd>` : ""}
        <dt>スレッド</dt><dd>${threadUrl ? `<a href="${threadUrl}" target="_blank" rel="noopener">Discord で開く</a>` : '<span class="note">なし</span>'}</dd>
      </dl>
      ${shareHtml("このページを共有")}
      ${noteHtml(c)}
      ${rel.length ? `<h3>関連する譜面</h3>${relList(rel)}` : ""}
      ${imageSectionHtml(c)}
      ${accuracyHtml(c)}
      ${sameAuthor.length ? `<h3>${esc(c.authorName)} さんのほかの譜面</h3>${relList(sameAuthor)}` : ""}
      ${sameSong.length ? `<h3>同じ曲のほかの譜面</h3>${relList(sameSong)}` : ""}`;
    setupImageViewer(c);
    loadAccuracy(c); // ★ v53 追加: 精度ランキングは別のファイルから読む
  }

  // ---------- ★ v38 追加: 精度ランキング（スレッドに送られたリザルト画面から読んだ数。名前を公開している人だけ） ----------
  const JUDGES = [["p", "PERFECT"], ["g", "GREAT"], ["gd", "GOOD"], ["b", "BAD"], ["m", "MISS"]];
  const isCount = (n) => Number.isInteger(n) && n >= 0 && n <= 99999;
  // ★ v48 変更: 精度％ ＝ (PERFECT×1 + GREAT×0.5 + GOOD×0.2 + BAD×0.1) ÷ 合計ノーツ数 × 101（AP が 101.00%）
  const accPercent = (a) => { const t = a.p + a.g + a.gd + a.b + a.m; return t > 0 ? ((a.p + a.g * 0.5 + a.gd * 0.2 + a.b * 0.1) / t) * 101 : 0; };
  const pctText = (v) => (Math.floor(v * 100 + 1e-9) / 100).toFixed(2); // ★ v48 変更: 小数第二位まで（切り捨て）
  function accuracyHtml(c) {
    // ★ v53: 精度ランキングが別のファイルにある時は、読み込むまで場所だけ取っておく（loadAccuracy が中身を入れる）
    if (!Array.isArray(c.acc) && c.accN > 0) return `<section class="acc" id="acc" data-wait="${esc(c.id)}" hidden></section>`;
    const list = (Array.isArray(c.acc) ? c.acc : []).filter((a) => a && user(a.u) && JUDGES.every(([k]) => isCount(a[k])))
      .map((a) => ({ ...a, pct: accPercent(a) })).sort((x, y) => y.pct - x.pct); // ★ v41: 精度％の高い順
    if (!list.length) return "";
    let rank = 0, prev = null;
    const rows = list.map((a, i) => {
      if (prev === null || Math.abs(a.pct - prev) > 1e-9) { rank = i + 1; prev = a.pct; } // 精度％が同じなら同じ順位
      const tag = a.g + a.gd + a.b + a.m === 0 ? '<span class="acc-tag ap" title="ALL PERFECT">AP</span>'
        : a.gd + a.b + a.m === 0 ? '<span class="acc-tag fc" title="FULL COMBO">FC</span>' : "";
      const cls = a.g + a.gd + a.b + a.m === 0 ? " ap" : a.gd + a.b + a.m === 0 ? " fc" : "";
      // ★ v42 変更: 1〜3位の行に r1・r2・r3 を付ける（番号を金・銀・銅の色にする）
      return `<li class="acc-row${rank <= 3 ? ` top r${rank}` : ""}"><span class="acc-rk">${rank}</span><span class="acc-who">${avatarHtml(a.u)}${userLink(a.u)}${tag}</span><span class="acc-pct${cls}">${pctText(a.pct)}<small>%</small></span>${JUDGES.map(([k, label]) => `<span class="acc-n j-${k}${a[k] === 0 && k !== "p" ? " zero" : ""}" data-l="${label}">${fmt(a[k])}</span>`).join("")}</li>`;
    }).join("");
    return `
      <section class="acc" id="acc">
        <h3>精度ランキング</h3>
        <ol class="acc-list">
          <li class="acc-row acc-head" aria-hidden="true"><span class="acc-rk">順位</span><span class="acc-who">プレイヤー</span><span class="acc-pct">精度</span>${JUDGES.map(([k, label]) => `<span class="acc-n j-${k}">${label}</span>`).join("")}</li>
          ${rows}
        </ol>
      </section>`;
  }

  // ★ v53 追加: 精度ランキングを data/acc/<譜面ID>.json から読んで、譜面のページに入れる（1回読んだら覚えておく）
  const ACC_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  async function loadAccuracy(c) {
    if (Array.isArray(c.acc) || !(c.accN > 0) || !SITE || !ACC_ID_RE.test(String(c.id || ""))) return;
    try {
      const res = await fetch(new URL(`data/acc/${c.id}.json`, ROOT_URL), { cache: "no-cache" }); // ページを移った後でもサイトの一番上から指す
      const list = res.ok ? await res.json() : null;
      c.acc = Array.isArray(list) ? list : [];
    } catch { return; }
    const slot = document.querySelector(`#chartView section.acc[data-wait="${CSS.escape(c.id)}"]`);
    if (slot) slot.outerHTML = accuracyHtml(c);
  }

  // ---------- 譜面画像（ドラッグで移動・ホイールや2本指で拡大縮小） ----------
  const IMG_RE = /^i\/[\w-]+\.(png|jpe?g|webp)$/;
  let iv = null; // 表示中の譜面画像
  function imageSectionHtml(c) {
    if (!c.img || !IMG_RE.test(c.img)) return "";
    const url = new URL(c.img, ROOT_URL).href; // サイトの一番上からの場所（譜面のページに移った後でも正しく指す）
    return `
      <section class="cimg" id="cimg">
        <h3>譜面画像</h3>
        <div class="cimg-bar">
          <button class="btn" type="button" data-iz="out" aria-label="縮小">−</button>
          <span class="zoom" id="cimgZoom">100%</span>
          <button class="btn" type="button" data-iz="in" aria-label="拡大">＋</button>
          <button class="btn" type="button" data-iz="all">全体</button>
          <button class="btn" type="button" data-iz="height">高さ合わせ</button>
          <button class="btn" type="button" data-iz="one">等倍</button>
          <span class="sp"></span>
          <button class="btn" type="button" data-iz="full" id="cimgFull">全画面</button>
          <a class="btn" href="${esc(url)}" target="_blank" rel="noopener">画像だけを開く</a>
        </div>
        <div class="cimg-cols" id="cimgCols" hidden></div>
        <div class="cimg-box" id="cimgBox">
          <button class="btn primary cimg-close" type="button" data-iz="full">閉じる</button>
          <div class="cimg-view" id="cimgView"><img id="cimgImg" alt="${esc(c.title || "譜面")}の譜面画像" src="${esc(url)}" decoding="async" draggable="false"></div>
        </div>
        <p class="cimg-note" id="cimgNote">ドラッグで移動、ホイールまたは2本指で拡大縮小できます。${c.imgW && c.imgH ? `（${fmt(c.imgW)} × ${fmt(c.imgH)} px）` : ""}</p>
      </section>`;
  }
  // ★ v53 追加: Bot が記録した列の場所（画像を WebP にして小さくした時は、画像の中の情報が消えるので、こちらを使う）
  function colsFromData(c, img) {
    const W = img.naturalWidth, H = img.naturalHeight;
    if (!Array.isArray(c?.imgCols) || c.imgCols.length < 2 || c.imgCols.length > 50) return null;
    const rects = [];
    for (const r of c.imgCols) {
      if (!Array.isArray(r) || r.length !== 4 || !r.every((v) => Number.isInteger(v) && v >= 0)) return null;
      const [x, y, w, h] = r;
      if (w <= 0 || h <= 0 || x + w > W || y + h > H) return null;
      rects.push({ x, y, w, h });
    }
    return rects;
  }
  // Chart Maker の画像に埋め込まれている「列の並べ方」を読む（無ければ null）
  function readChartLayout(img) {
    try {
      const W = img.naturalWidth, H = img.naturalHeight;
      if (W < 64 || H < 10) return null;
      const cv = document.createElement("canvas");
      cv.width = W; cv.height = Math.min(32, H);
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, H - cv.height, W, cv.height, 0, 0, W, cv.height);
      const last = ctx.getImageData(0, cv.height - 1, W, 1).data;
      let len = 0;
      for (let b = 0; b < 16; b++) len = (len | ((last[b * 4] & 3) << (b * 2))) >>> 0;
      const MAGIC = "PJSK_TS1:";
      if (len <= MAGIC.length) return null;
      const rows = Math.ceil((16 + len * 2) / W);
      if (rows > Math.min(32, Math.floor(H / 4))) return null;
      const data = ctx.getImageData(0, cv.height - rows, W, rows).data;
      const at = (k) => (((rows - 1 - Math.floor(k / W)) * W) + (k % W)) * 4;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        const i1 = at(16 + i * 2), i2 = at(17 + i * 2);
        bytes[i] = (data[i1] & 3) | ((data[i1 + 1] & 3) << 2) | ((data[i2] & 3) << 4) | ((data[i2 + 1] & 3) << 6);
      }
      const text = new TextDecoder().decode(bytes);
      if (!text.startsWith(MAGIC)) return null;
      const lay = JSON.parse(text.slice(MAGIC.length)).lay;
      if (!lay || lay.m !== "grid" || !(lay.n > 1)) return null;
      const s = lay.s || 1, g = lay.g || 0, top = (lay.hh || 0) + g;
      const rects = [];
      for (let k = 0; k < lay.n; k++) {
        const x1 = Math.round((g + k * (lay.cw + g)) * s), x2 = Math.round((g + k * (lay.cw + g) + lay.cw) * s);
        const y1 = Math.round(top * s), y2 = Math.round((top + lay.ch) * s);
        if (x2 > W || y2 > H || x2 <= x1 || y2 <= y1) return null;
        rects.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
      }
      return rects;
    } catch { return null; }
  }
  function setupImageViewer(c) {
    iv = null;
    const view = $("cimgView");
    if (!view) return;
    const img = $("cimgImg"), box = $("cimgBox"), sec = $("cimg");
    const st = iv = { s: 1, x: 0, y: 0, rects: null, box };
    const apply = () => { img.style.transform = `translate(${st.x}px, ${st.y}px) scale(${st.s})`; $("cimgZoom").textContent = `${Math.round(st.s * 100)}%`; };
    const size = () => ({ w: img.naturalWidth, h: img.naturalHeight, vw: view.clientWidth, vh: view.clientHeight });
    const fitAll = () => { const z = size(); if (!z.w) return; st.s = Math.min((z.vw - 20) / z.w, (z.vh - 20) / z.h, 1.5); st.x = Math.max(10, (z.vw - z.w * st.s) / 2); st.y = Math.max(10, (z.vh - z.h * st.s) / 2); apply(); };
    const fitHeight = () => { const z = size(); if (!z.h) return; st.s = (z.vh - 20) / z.h; st.x = 10; st.y = 10; apply(); };
    const zoomAt = (f, cx, cy) => { const ns = Math.min(4.5, Math.max(0.02, st.s * f)); const k = ns / st.s; st.x = cx - (cx - st.x) * k; st.y = cy - (cy - st.y) * k; st.s = ns; apply(); };
    // 列へ移動：その列の一番下（譜面の始まり側）を、読める大きさで見せる
    const jump = (k) => {
      const rc = st.rects && st.rects[k]; if (!rc) return;
      const z = size();
      st.s = Math.min(1.5, Math.max(0.1, (z.vw - 20) / (rc.w * 1.6)));
      st.x = (z.vw - rc.w * st.s) / 2 - rc.x * st.s;
      st.y = Math.min(10, z.vh - 10 - (rc.y + rc.h) * st.s);
      apply();
    };
    const setFull = (on) => { box.classList.toggle("full", on); $("cimgFull").textContent = on ? "全画面を閉じる" : "全画面"; requestAnimationFrame(fitAll); };
    st.setFull = setFull;
    const onLoad = () => {
      st.rects = colsFromData(c, img) || readChartLayout(img); // ★ v53: Bot が記録した列の場所を先に使う
      const cols = $("cimgCols");
      if (st.rects && st.rects.length > 1) {
        cols.innerHTML = st.rects.map((_, k) => `<button class="btn" type="button" data-ic="${k}">${k + 1}列目</button>`).join("");
        cols.hidden = false;
        jump(0);
      } else fitAll();
    };
    if (img.complete && img.naturalWidth) onLoad(); else img.addEventListener("load", onLoad, { once: true });
    img.addEventListener("error", () => { $("cimgNote").textContent = "譜面画像を読み込めませんでした。"; }, { once: true });
    sec.addEventListener("click", (e) => {
      const b = e.target.closest("[data-iz],[data-ic]"); if (!b) return;
      if (b.dataset.ic != null) return jump(Number(b.dataset.ic));
      const z = size();
      const act = { in: () => zoomAt(1.25, z.vw / 2, z.vh / 2), out: () => zoomAt(0.8, z.vw / 2, z.vh / 2), all: fitAll, height: fitHeight, one: () => { st.s = 1; st.x = 10; st.y = 10; apply(); }, full: () => setFull(!box.classList.contains("full")) }[b.dataset.iz];
      if (act) act();
    });
    view.addEventListener("wheel", (e) => { e.preventDefault(); const r = view.getBoundingClientRect(); zoomAt(e.deltaY < 0 ? 1.15 : 0.87, e.clientX - r.left, e.clientY - r.top); }, { passive: false });
    // マウス・タッチ共通：1本指で移動、2本指で拡大縮小
    const pts = new Map();
    let drag = null, pinch = null;
    view.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      view.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) { drag = { x: e.clientX - st.x, y: e.clientY - st.y }; view.classList.add("dragging"); }
      else if (pts.size === 2) {
        const [a, b] = [...pts.values()]; const r = view.getBoundingClientRect();
        pinch = { d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), cx: (a.x + b.x) / 2 - r.left, cy: (a.y + b.y) / 2 - r.top, s: st.s, x: st.x, y: st.y };
      }
    });
    view.addEventListener("pointermove", (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size >= 2 && pinch) {
        const [a, b] = [...pts.values()]; const r = view.getBoundingClientRect();
        const ns = Math.min(4.5, Math.max(0.02, pinch.s * Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) / pinch.d));
        const k = ns / pinch.s, cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top;
        st.x = cx - (pinch.cx - pinch.x) * k; st.y = cy - (pinch.cy - pinch.y) * k; st.s = ns; apply();
      } else if (drag) { st.x = e.clientX - drag.x; st.y = e.clientY - drag.y; apply(); }
    });
    const end = (e) => {
      if (!pts.delete(e.pointerId)) return;
      if (pts.size === 1) { const p = [...pts.values()][0]; pinch = null; drag = { x: p.x - st.x, y: p.y - st.y }; }
      else if (pts.size === 0) { drag = null; pinch = null; view.classList.remove("dragging"); }
    };
    view.addEventListener("pointerup", end);
    view.addEventListener("pointercancel", end);
  }
  window.addEventListener("keydown", (e) => { if (e.key === "Escape" && iv && iv.box.classList.contains("full")) iv.setFull(false); });

  // ---------- マイページ ----------
  function renderUserPage(key) {
    const u = user(key);
    const st = userStats.get(key);
    document.title = `${u.name || "名前なし"}｜Chart Viewer`;
    const color = u.color && /^#[0-9a-fA-F]{6}$/.test(u.color) ? u.color : null;
    const own = charts.filter((c) => c.author === key || c.collab.includes(key)); // ★ v29 変更: 合作した譜面も出す
    const pinned = (u.pinned || []).map((id) => chartById.get(id)).filter((c) => c && (c.author === key || c.collab.includes(key))); // ★ v35 変更: 合作した譜面も
    const links = (u.links || []).filter((l) => l && /^https:\/\//i.test(l.url))
      .map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener nofollow">${esc(l.label || l.url)}</a>`).join("");
    $("userView").innerHTML = `
      <a class="back" href="${esc(linkTo({ type: "home" }))}" data-go="back">戻る</a>
      <header class="profile"${color ? ` style="--uc:${color}"` : ""}>
        ${avatarHtml(key, "xl")}
        <div>
          <h2>${esc(u.name || "名前なし")}</h2>
          ${u.bio ? `<div class="bio md">${mdHtml(u.bio)}</div>` : ""}
          ${links ? `<div class="links">${links}</div>` : ""}
        </div>
      </header>
      <div class="figures">
        <span class="num"><span class="v">${fmt(st.charts)}</span><span class="k">投稿した譜面</span></span>
        <span class="num"><span class="v">${fmt(st.plays)}</span><span class="k">合計プレイ</span></span>
        <span class="num"><span class="v">${fmt(st.likes)}</span><span class="k">合計いいね</span></span>
      </div>
      ${shareHtml("このページを共有")}
      ${pinned.length ? `<h3>おすすめの譜面</h3><div class="rows">${pinned.map(rowHtml).join("")}</div>` : ""}
      <div class="toolbar">
        <div class="result"><b>${fmt(own.length)}</b>件の譜面</div>
        <select class="field" id="userPageSort" aria-label="並び順">
          ${[["new", "登録が新しい順"], ["plays", "プレイ数が多い順"], ["likes", "いいねが多い順"], ["lvDesc", "レベルが高い順"], ["lvAsc", "レベルが低い順"]]
            .map(([v, t]) => `<option value="${v}" ${v === userPageSort ? "selected" : ""}>${t}</option>`).join("")}
        </select>
      </div>
      <div class="rows">${own.sort(sorter(userPageSort)).map(rowHtml).join("") || '<div class="none">まだ譜面はありません</div>'}</div>`;
    $("userPageSort").addEventListener("change", (e) => { userPageSort = e.target.value; renderUserPage(key); });
  }

  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-share]")) sharePage();
  });
  // ★ 追加: スマートフォンなどでは端末の共有画面を出す（使えない時やパソコンでは URL をコピー）
  async function sharePage() {
    const url = location.href;
    if (navigator.share && matchMedia("(pointer: coarse)").matches) {
      try { await navigator.share({ title: document.title, url }); return; }
      catch (err) { if (err && err.name === "AbortError") return; }
    }
    copyText(url, "このページのURLをコピーしました");
  }

  async function copyText(text, done) {
    try { await navigator.clipboard.writeText(text); toast(done); } catch { toast("コピーできませんでした"); }
  }
  let toastTimer;
  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
  }

  // アイコンが読み込めない時は頭文字にする
  document.addEventListener("error", (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains("avatar")) return;
    const span = document.createElement("span");
    span.className = img.className;
    span.textContent = img.dataset.initial || "?";
    img.replaceWith(span);
  }, true);

  // ---------- 起動 ----------
  (async () => {
    // 1. Bot が公開しているサイトなら、データを自動で読み込む
    try {
      const res = await fetch(BASE + "data/charts.json", { cache: "no-cache" });
      if (res.ok) {
        const data = await res.json();
        if (valid(data)) {
          SITE = true;
          setData(data);
          render(INITIAL_ROUTE || routeFromLocation());
          history.replaceState(INITIAL_ROUTE || routeFromLocation(), "");
          return;
        }
      }
    } catch {}
    // 2. 手で開く使い方（前回のデータがあれば表示）
    showEmpty();
    try {
      const data = await idb.get();
      if (valid(data) && !D) { setData(data); render({ type: "home" }); $("openFile").hidden = false; }
    } catch {}
  })();
})();
