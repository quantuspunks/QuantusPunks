(function () {
  const C = window.QP_CONFIG, Q = window.QPunks;
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => n.toLocaleString("en-US");
  const ADDR_RE = /^q[1-9A-HJ-NP-Za-km-z]{39,59}$/;
  const PER_PAGE = 48;

  let traits = [], rarityScore = [], counts = null, owners = {}, minted = 0, apiOnline = false;

  // ---------- helpers ----------
  function punkCanvas(id, size, cls) {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    if (cls) c.className = cls;
    Q.drawCanvas(c.getContext("2d"), traits[id - 1], size);
    return c;
  }
  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2200);
  }
  function copy(text, label) {
    const done = () => toast(label + " copied");
    try {
      navigator.clipboard.writeText(text).then(done, () => fallback());
    } catch (e) { fallback(); }
    function fallback() {
      const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); done(); } catch (e) { toast("Select and copy manually"); }
      ta.remove();
    }
  }
  const short = (a) => a.slice(0, 6) + "…" + a.slice(-5);
  function api(path) {
    if (!C.api) return Promise.reject(new Error("no api"));
    return fetch(C.api.replace(/\/$/, "") + path).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
  }

  // ---------- background lattice ----------
  function drawLattice() {
    const cv = $("lattice"), dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
    const g = cv.getContext("2d"); g.scale(dpr, dpr);
    const step = 36;
    for (let y = 0; y < innerHeight + step; y += step) {
      for (let x = 0; x < innerWidth + step; x += step) {
        const ox = (y / step) % 2 ? step / 2 : 0;
        const h = Math.sin(x * 0.013 + y * 0.021) * Math.cos(y * 0.009);
        g.fillStyle = h > 0.55 ? "rgba(227,177,106,.55)" : "rgba(110,130,175,.28)";
        g.fillRect(x + ox, y, h > 0.55 ? 2 : 1.5, h > 0.55 ? 2 : 1.5);
      }
    }
  }

  // ---------- hero ----------
  function showHero(id) {
    const t = traits[id - 1];
    Q.drawCanvas($("heroPunk").getContext("2d"), t, 480);
    $("heroId").textContent = "#" + String(id).padStart(4, "0");
    const attrs = Q.attributes(t);
    $("heroType").textContent = attrs[0].value;
    $("heroTraits").innerHTML = attrs.slice(1).map((a) => `<li>${a.trait_type}: <span>${a.value}</span></li>`).join("");
  }
  function startHero() {
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const pickRare = () => rarityScore.slice(0, 600)[Math.floor(Math.random() * 600)].id;
    showHero(pickRare());
    if (reduce) return;
    setInterval(() => {
      const fig = document.querySelector(".specimen");
      fig.classList.remove("flip"); void fig.offsetWidth; fig.classList.add("flip");
      setTimeout(() => showHero(pickRare()), 140);
    }, 3200);
  }

  function ribbon() {
    const r = $("ribbon"), ids = [];
    for (let i = 0; i < 30; i++) ids.push(1 + ((i * 337 + 71) % C.supply));
    [...ids, ...ids].forEach((id) => r.appendChild(punkCanvas(id, 64)));
  }

  // ---------- stats / live ----------
  function setMinted(n) {
    minted = n;
    $("specMinted").textContent = fmt(n);
    $("mintedLabel").textContent = `${fmt(n)} / ${fmt(C.supply)}`;
    $("progressFill").style.width = (n / C.supply * 100).toFixed(2) + "%";
  }
  function refreshStats() {
    api("/api/stats").then((s) => {
      apiOnline = true;
      setMinted(s.minted);
      if (s.treasury) setTreasury(s.treasury);
      if (s.seedCommit) $("seedHash").textContent = s.seedReveal ? `${s.seedCommit} (seed: ${s.seedReveal})` : s.seedCommit;
      const chip = $("liveChip"); chip.className = "live on";
      $("liveText").textContent = s.minted >= s.supply ? "Sold out" : `Block ${fmt(s.lastBlock)}`;
    }).catch(() => {
      apiOnline = false;
      $("liveChip").className = "live preview";
      $("liveText").textContent = C.api ? "Indexer offline" : "Preview · " + C.mintDate;
    });
    api("/api/recent").then(renderRecent).catch(() => {});
    api("/api/owners").then((o) => { owners = o; renderGallery(); }).catch(() => {});
  }
  function renderRecent(list) {
    const ul = $("recentList");
    if (!list.length) { ul.innerHTML = '<li class="muted">No mints yet.</li>'; return; }
    ul.innerHTML = "";
    list.slice(0, 8).forEach((m) => {
      const li = document.createElement("li");
      li.appendChild(punkCanvas(m.ids[0], 32));
      li.appendChild(document.createTextNode(`${short(m.from)} minted ${m.ids.length} · block ${fmt(m.block)}`));
      ul.appendChild(li);
    });
  }

  // ---------- mint panel ----------
  function setTreasury(addr) {
    if ($("treasuryAddr").textContent === addr) return;
    $("treasuryAddr").textContent = addr;
    try {
      const qr = qrcode(0, "M"); qr.addData(addr); qr.make();
      $("qr").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    } catch (e) { $("qr").innerHTML = ""; }
  }
  function amountFor(q) { return (Math.round(q * C.priceQTC * 1e6) / 1e6).toString(); }
  function syncQty(v) {
    const q = Math.max(1, Math.min(C.maxPerTx, parseInt(v, 10) || 1));
    $("qty").value = q;
    $("amountQTC").textContent = amountFor(q);
  }

  // live payment detection via txWatch, confirmation via indexer
  let ws = null, pollTimer = null;
  function status(html, done) { const s = $("trackStatus"); s.hidden = false; s.innerHTML = html; s.classList.toggle("done", !!done); }
  function track() {
    const addr = $("trackAddr").value.trim();
    if (!ADDR_RE.test(addr)) { status("That does not look like a Quantus address. It starts with <b>q</b> and is about 48 characters."); return; }
    let baseline = null;
    status("Watching the network for a transfer from " + short(addr) + "…");
    if (ws) try { ws.close(); } catch (e) {}
    try {
      ws = new WebSocket(C.rpc);
      let subId = null;
      ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "txWatch_watchAddress", params: [$("treasuryAddr").textContent] }));
      ws.onmessage = (ev) => {
        const d = JSON.parse(ev.data);
        if (d.id === 1 && d.result) { subId = d.result; return; }
        if (d.method === "txWatch_transfer" && d.params && d.params.subscription === subId) {
          const t = d.params.result;
          if (t.from === addr && t.asset_id == null) {
            status(`Payment seen: <b>${Number(t.amount) / 1e12} QTC</b>. Waiting for the block to finalize, usually under a minute.`);
          }
        }
      };
    } catch (e) {}
    clearInterval(pollTimer);
    const poll = () => api("/api/owner/" + encodeURIComponent(addr)).then((r) => {
      if (baseline === null) baseline = r.ids.length;
      if (r.ids.length > baseline || (baseline > 0 && !$("trackStatus").dataset.shown)) {
        $("trackStatus").dataset.shown = "1";
        status(`This wallet holds <b>${r.ids.length}</b> punk${r.ids.length === 1 ? "" : "s"}: ${r.ids.slice(-12).map((i) => "#" + i).join(", ")}${r.ids.length > 12 ? "…" : ""}`, true);
        baseline = r.ids.length;
      }
    }).catch(() => { if (!C.api) status("Preview mode: the indexer is not connected yet, so mints cannot be confirmed here."); });
    poll(); pollTimer = setInterval(poll, 6000);
  }

  // ---------- gallery ----------
  let page = 0, filtered = [];
  function fillSelect(sel, key, label) {
    sel.innerHTML = `<option value="">${label}: all</option>` + Q.TRAITS[key].map((t, i) => `<option value="${i}">${t.name}</option>`).join("");
    sel.addEventListener("change", () => { page = 0; renderGallery(); });
  }
  function card(id) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "card"; b.setAttribute("aria-label", "Punk #" + id);
    b.appendChild(punkCanvas(id, 120));
    const rare = rarityRank[id] <= 500;
    const tag = owners[id] ? '<span class="tag minted">Minted</span>' : rare ? '<span class="tag rare">Top 5%</span>' : "";
    b.insertAdjacentHTML("beforeend", `<div class="card-meta"><span>#${id}</span>${tag}</div>`);
    b.addEventListener("click", () => openModal(id));
    return b;
  }
  function renderGallery() {
    if (!traits.length) return;
    const ft = $("fType").value, fh = $("fHead").value, fe = $("fEyes").value;
    filtered = [];
    for (let i = 0; i < traits.length; i++) {
      const t = traits[i];
      if (ft !== "" && t[0] != ft) continue;
      if (fh !== "" && t[2] != fh) continue;
      if (fe !== "" && t[3] != fe) continue;
      filtered.push(i + 1);
    }
    if ($("fSort").value === "rare") filtered.sort((a, b) => rarityRank[a] - rarityRank[b]);
    const pages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
    page = Math.min(page, pages - 1);
    const g = $("gallery"); g.innerHTML = "";
    filtered.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE).forEach((id) => g.appendChild(card(id)));
    $("resultCount").textContent = fmt(filtered.length) + " punks";
    $("pageLabel").textContent = `${page + 1} / ${pages}`;
    $("prevPage").disabled = page === 0; $("nextPage").disabled = page >= pages - 1;
  }

  let rarityRank = {};
  function computeRarity() {
    counts = Q.ORDER.map((k) => Q.TRAITS[k].map(() => 0));
    traits.forEach((t) => t.forEach((v, i) => counts[i][v]++));
    rarityScore = traits.map((t, i) => ({ id: i + 1, s: t.reduce((s, v, j) => s + traits.length / counts[j][v], 0) }));
    rarityScore.sort((a, b) => b.s - a.s);
    rarityScore.forEach((r, i) => { rarityRank[r.id] = i + 1; });
  }

  function openModal(id) {
    const t = traits[id - 1];
    Q.drawCanvas($("mCanvas").getContext("2d"), t, 384);
    $("mTitle").textContent = "QuantusPunk #" + id;
    $("mOwner").textContent = owners[id] ? "Owner " + owners[id] : `Not minted yet · rarity rank ${fmt(rarityRank[id])} of ${fmt(traits.length)}`;
    $("mAttr").innerHTML = Q.attributes(t).map((a, i) => `<li><small>${a.trait_type}</small><span>${a.value}</span><em>${(counts[i][t[i]] / traits.length * 100).toFixed(1)}%</em></li>`).join("");
    $("modal").hidden = false;
    $("modalClose").focus();
  }

  // ---------- my punks ----------
  function lookup() {
    const addr = $("mineAddr").value.trim(), g = $("mineGallery");
    g.innerHTML = "";
    if (!ADDR_RE.test(addr)) { $("mineStatus").textContent = "Enter a valid Quantus address (starts with q, about 48 characters)."; return; }
    $("mineStatus").textContent = "Loading…";
    api("/api/owner/" + encodeURIComponent(addr)).then((r) => {
      $("mineStatus").textContent = r.ids.length ? `${short(r.address)} holds ${r.ids.length} punk${r.ids.length === 1 ? "" : "s"}.` : "No punks in this wallet yet.";
      r.ids.forEach((id) => g.appendChild(card(id)));
      const pend = (r.refunds || []).filter((x) => !x.done);
      if (pend.length) $("mineStatus").textContent += ` Pending refund: ${pend.reduce((s, x) => s + Number(x.amount), 0) / 1e12} QTC.`;
    }).catch(() => { $("mineStatus").textContent = C.api ? "The indexer is not responding. Try again in a minute." : "Preview mode: wallet lookups work once the indexer is connected."; });
  }

  // ---------- init ----------
  function bind() {
    $("qtyDown").onclick = () => syncQty(+$("qty").value - 1);
    $("qtyUp").onclick = () => syncQty(+$("qty").value + 1);
    $("qty").addEventListener("change", (e) => syncQty(e.target.value));
    $("copyAmount").onclick = () => copy($("amountQTC").textContent, "Amount");
    $("copyTreasury").onclick = () => copy($("treasuryAddr").textContent, "Address");
    $("trackBtn").onclick = track;
    $("mineBtn").onclick = lookup;
    $("trackAddr").addEventListener("keydown", (e) => { if (e.key === "Enter") track(); });
    $("mineAddr").addEventListener("keydown", (e) => { if (e.key === "Enter") lookup(); });
    $("prevPage").onclick = () => { page--; renderGallery(); $("collection").scrollIntoView(); };
    $("nextPage").onclick = () => { page++; renderGallery(); $("collection").scrollIntoView(); };
    $("fSort").onchange = () => { page = 0; renderGallery(); };
    $("searchId").addEventListener("keydown", (e) => {
      const n = parseInt(e.target.value, 10);
      if (e.key === "Enter" && n >= 1 && n <= traits.length) openModal(n);
    });
    $("modalClose").onclick = () => { $("modal").hidden = true; };
    $("modal").addEventListener("click", (e) => { if (e.target.id === "modal") $("modal").hidden = true; });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("modal").hidden = true; });
    addEventListener("resize", () => { clearTimeout(bind._r); bind._r = setTimeout(drawLattice, 150); });
  }

  function init() {
    $("specSupply").textContent = fmt(C.supply);
    $("specPrice").textContent = C.priceQTC + " QTC";
    $("specRoyalty").textContent = C.royaltyPct + "%";
    $("maxTx").textContent = C.maxPerTx;
    $("qty").max = C.maxPerTx;
    $("xLink").href = C.x;
    setTreasury(C.treasury);
    setMinted(0);
    syncQty(1);
    drawLattice();
    bind();
    fetch("data/rarity.json").then((r) => r.json()).then((d) => { $("provHash").textContent = d.provenance; }).catch(() => {});
    fetch("data/traits.json").then((r) => r.json()).then((t) => {
      traits = t;
      computeRarity();
      const bm = $("brandMark").getContext("2d");
      Q.drawCanvas(bm, [6, 3, 10, 2, 1, 0, 5], 24);
      fillSelect($("fType"), "type", "Type");
      fillSelect($("fHead"), "head", "Head");
      fillSelect($("fEyes"), "eyes", "Eyes");
      startHero();
      ribbon();
      renderGallery();
      refreshStats();
      setInterval(refreshStats, 15000);
    });
  }
  init();
})();
