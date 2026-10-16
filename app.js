(function () {
  "use strict";
  const SIZES = ["S", "M", "L", "XL"];
  const COLORS = { nero: "nera", bianco: "bianca", grigio: "grigia", altro: "di altro colore" };
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const eur = (n) => (n < 0 ? "−" : "") + "€" + Math.abs(Number(n)).toLocaleString("it-IT", { maximumFractionDigits: 2 });

  const cfg = window.VC_CONFIG || {};
  const LIVE = !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase);
  const sb = LIVE ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;

  let tees = [];      // {id,name,color,price,threshold,image,created_at,stock:{S:3}}
  let moves = [];     // {id,created_at,tee_name,size,delta,by_email}
  let session = null;
  let sales = [], orders = [], defs = { price: null, cost: null }, tab = "stock", period = "all";
  let editMode = false, onlyLow = false;
  const pending = {}; // "teeId|size" -> delta not yet saved
  const timers = {};

  function toast(t) { const el = $("#toast"); el.textContent = t; el.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove("show"), 2600); }
  function setSync(t) { const el = $("#sync"); if (el) el.textContent = t; }

  /* ================= DATA LAYER ================= */
  const local = {
    KEY: "vc-magazzino-local-v1",
    read() {
      try { const s = JSON.parse(localStorage.getItem(this.KEY)); if (s && s.tees) return Object.assign({ moves: [], sales: [], orders: [], defs: { price: 20, cost: 7.5 } }, s); } catch (e) {}
      const now = Date.now();
      return {
        tees: [
          { id: "t1", name: "Will never die", color: "nero", threshold: 3, image: "img/will-never-die.jpg", created_at: now - 3, stock: { S: 0, M: 0, L: 0, XL: 0 } },
          { id: "t2", name: "Nordest", color: "bianco", threshold: 3, image: "img/nordest.jpg", created_at: now - 2, stock: { S: 0, M: 0, L: 0, XL: 0 } },
          { id: "t3", name: "I ♫ Veneto", color: "nero", threshold: 3, image: "img/i-nota-veneto.jpg", created_at: now - 1, stock: { S: 0, M: 0, L: 0, XL: 0 } }
        ], moves: [], sales: [], orders: [], defs: { price: 20, cost: 7.5 }
      };
    },
    write(s) { try { localStorage.setItem(this.KEY, JSON.stringify(s)); } catch (e) { toast("Memoria del browser piena: usa foto più leggere"); } },
    async load() {
      const s = this.read();
      return {
        tees: s.tees.map((t) => ({ ...t, stock: Object.fromEntries(SIZES.map((size) => [size, t.stock[size] || 0])) })),
        moves: s.moves.slice(0, 20), sales: s.sales, orders: s.orders, defs: s.defs
      };
    },
    async change(id, size, fn) {
      const s = this.read(); const t = s.tees.find((x) => x.id === id); if (!t || !(size in t.stock)) throw new Error("Taglia non trovata");
      const old = t.stock[size], nv = Math.max(0, fn(old));
      if (nv !== old) { t.stock[size] = nv; s.moves.unshift({ id: Date.now() + Math.random(), created_at: Date.now(), tee_name: t.name, size, delta: nv - old, by_email: "" }); s.moves = s.moves.slice(0, 50); this.write(s); }
      return nv;
    },
    adjust(id, size, d) { return this.change(id, size, (o) => o + d); },
    set(id, size, q) { return this.change(id, size, () => q); },
    async saveTee(data, sizes) {
      const s = this.read(); let t = data.id && s.tees.find((x) => x.id === data.id);
      if (!t) { t = { id: "t" + Date.now(), created_at: Date.now(), stock: {} }; s.tees.push(t); }
      Object.assign(t, { name: data.name, color: data.color, price: data.price, cost: data.cost, threshold: data.threshold, image: data.image });
      const st = { ...t.stock }; SIZES.forEach((z) => (st[z] = t.stock[z] || 0)); t.stock = st;
      this.write(s);
    },
    async saveDefs(m) { const s = this.read(); s.defs = m; this.write(s); },
    async createSale(d) {
      const s = this.read(), t = s.tees.find((x) => x.id === d.tee_id); if (!t) throw new Error("Design non trovato");
      const have = t.stock[d.size] || 0;
      if (have < d.qty) throw new Error("Scorta insufficiente: in magazzino ne restano " + have);
      t.stock[d.size] = have - d.qty;
      const now = Date.now();
      s.moves.unshift({ id: now + Math.random(), created_at: now, tee_name: t.name, size: d.size, delta: -d.qty, by_email: "" });
      s.moves = s.moves.slice(0, 50);
      s.sales.unshift({ id: now + Math.random(), created_at: now, tee_id: t.id, tee_name: t.name, size: d.size, qty: d.qty, customer: d.customer, payment: d.payment, unit_price: d.price, unit_cost: t.cost != null ? t.cost : s.defs.cost, by_email: "" });
      this.write(s);
    },
    async deleteSale(id) {
      const s = this.read(), x = s.sales.find((r) => String(r.id) === String(id)); if (!x) return;
      const t = s.tees.find((y) => y.id === x.tee_id);
      if (t && x.size in t.stock) {
        t.stock[x.size] += x.qty;
        s.moves.unshift({ id: Date.now() + Math.random(), created_at: Date.now(), tee_name: t.name, size: x.size, delta: x.qty, by_email: "" });
        s.moves = s.moves.slice(0, 50);
      }
      s.sales = s.sales.filter((r) => r !== x);
      this.write(s);
    },
    async saveOrder(d) {
      const s = this.read(), now = Date.now();
      s.orders.unshift({ id: now + Math.random(), created_at: now, tee_id: d.tee_id, tee_name: d.tee_name, qty: d.qty, unit_cost: d.unit_cost, status: "ordinato", received_at: null, by_email: "" });
      this.write(s);
    },
    async receiveOrder(id) {
      const s = this.read(), o = s.orders.find((r) => String(r.id) === String(id));
      if (!o || o.status === "ricevuto") throw new Error("Ordine già ricevuto");
      const t = s.tees.find((y) => y.id === o.tee_id); if (!t) throw new Error("Il design di questo ordine è stato eliminato");
      const now = Date.now();
      Object.keys(o.qty).forEach((z) => {
        const n = o.qty[z] || 0; if (n <= 0) return;
        t.stock[z] = (t.stock[z] || 0) + n;
        s.moves.unshift({ id: now + Math.random(), created_at: now, tee_name: t.name, size: z, delta: n, by_email: "" });
      });
      s.moves = s.moves.slice(0, 50);
      o.status = "ricevuto"; o.received_at = now;
      this.write(s);
    },
    async deleteOrder(id) { const s = this.read(); s.orders = s.orders.filter((r) => String(r.id) !== String(id)); this.write(s); },
    async deleteTee(id) { const s = this.read(); s.tees = s.tees.filter((t) => t.id !== id); this.write(s); },
    async upload(blob) { return await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); }); }
  };

  const remote = {
    async load() {
      const [a, b, c, d, e] = await Promise.all([

        sb.from("tees").select("id,name,color,price,cost,threshold,image,created_at,stock(size,qty)").order("created_at"),
        sb.from("moves").select("id,created_at,tee_name,size,delta,by_email").order("created_at", { ascending: false }).limit(20),
        sb.from("sales").select("id,created_at,tee_id,tee_name,size,qty,customer,payment,unit_price,unit_cost,by_email").order("created_at", { ascending: false }).limit(2000),
        sb.from("supplier_orders").select("id,created_at,tee_id,tee_name,qty,unit_cost,status,received_at,by_email").order("created_at", { ascending: false }).limit(1000),
        sb.from("settings").select("price,cost")
      ]);
      if (a.error) throw a.error; if (b.error) throw b.error; if (c.error) throw c.error; if (d.error) throw d.error; if (e.error) throw e.error;
      const missing = [];
      a.data.forEach((t) => {
        const existing = new Set((t.stock || []).map((r) => r.size));
        SIZES.forEach((size) => { if (!existing.has(size)) missing.push({ tee_id: t.id, size, qty: 0 }); });
      });
      if (missing.length) {
        const { error } = await sb.from("stock").upsert(missing, { onConflict: "tee_id,size", ignoreDuplicates: true });
        if (error) throw error;
      }
      return {
        tees: a.data.map((t) => {
          const st = Object.fromEntries(SIZES.map((size) => [size, 0]));
          (t.stock || []).forEach((r) => { if (SIZES.includes(r.size)) st[r.size] = r.qty; });
          return { ...t, stock: st };
        }),
        moves: b.data, sales: c.data, orders: d.data, defs: e.data[0] || { price: null, cost: null }
      };
    },
    async adjust(id, size, d) { const { data, error } = await sb.rpc("adjust_stock", { p_tee: id, p_size: size, p_delta: d }); if (error) throw error; return data; },
    async set(id, size, q) { const { data, error } = await sb.rpc("set_stock", { p_tee: id, p_size: size, p_qty: q }); if (error) throw error; return data; },
    async saveTee(data) {
      const row = { name: data.name, color: data.color, price: data.price, cost: data.cost, threshold: data.threshold, image: data.image };
      let id = data.id;
      if (id) { const { error } = await sb.from("tees").update(row).eq("id", id); if (error) throw error; }
      else { const { data: ins, error } = await sb.from("tees").insert(row).select("id").single(); if (error) throw error; id = ins.id; }
      const { error: e1 } = await sb.from("stock").upsert(SIZES.map((size) => ({ tee_id: id, size, qty: 0 })), { onConflict: "tee_id,size", ignoreDuplicates: true });
      if (e1) throw e1;
    },
    async saveDefs(m) { const { error } = await sb.from("settings").upsert({ id: 1, price: m.price, cost: m.cost }); if (error) throw error; },
    async createSale(d) { const { error } = await sb.rpc("create_sale", { p_tee: d.tee_id, p_size: d.size, p_qty: d.qty, p_customer: d.customer, p_payment: d.payment, p_price: d.price }); if (error) throw error; },
    async deleteSale(id) { const { error } = await sb.rpc("delete_sale", { p_id: id }); if (error) throw error; },
    async saveOrder(d) { const { error } = await sb.from("supplier_orders").insert({ tee_id: d.tee_id, tee_name: d.tee_name, qty: d.qty, unit_cost: d.unit_cost }); if (error) throw error; },
    async receiveOrder(id) { const { error } = await sb.rpc("receive_order", { p_id: id }); if (error) throw error; },
    async deleteOrder(id) { const { error } = await sb.from("supplier_orders").delete().eq("id", id); if (error) throw error; },
    async deleteTee(id) { const { error } = await sb.from("tees").delete().eq("id", id); if (error) throw error; },
    async upload(blob) {
      const path = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)) + ".jpg";
      const { error } = await sb.storage.from("foto").upload(path, blob, { contentType: "image/jpeg" });
      if (error) throw error;
      return sb.storage.from("foto").getPublicUrl(path).data.publicUrl;
    }
  };
  const api = LIVE ? remote : local;

  /* ================= LOAD / SYNC ================= */
  let loading = false, again = false;
  async function reload() {
    if (loading) { again = true; return; }
    loading = true;
    try { const r = await api.load(); tees = r.tees; moves = r.moves; sales = r.sales || []; orders = r.orders || []; defs = r.defs || { price: null, cost: null }; renderMain(); setSync(LIVE ? "Aggiornato alle " + new Date().toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }) : "Modalità prova: dati solo su questo dispositivo"); }
    catch (e) { setSync("Non riesco a caricare i dati. Controlla la connessione e riprova."); console.error(e); }
    loading = false;
    if (again) { again = false; reload(); }
  }
  let rt = null, rtTimer = null;
  function startRealtime() {
    if (!LIVE || rt) return;
    const ping = () => { clearTimeout(rtTimer); rtTimer = setTimeout(reload, 400); };
    rt = sb.channel("magazzino")
      .on("postgres_changes", { event: "*", schema: "public", table: "stock" }, ping)
      .on("postgres_changes", { event: "*", schema: "public", table: "tees" }, ping)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "moves" }, ping)
      .on("postgres_changes", { event: "*", schema: "public", table: "sales" }, ping)
      .on("postgres_changes", { event: "*", schema: "public", table: "supplier_orders" }, ping)
      .on("postgres_changes", { event: "*", schema: "public", table: "settings" }, ping)
      .subscribe();
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && (!LIVE || session)) reload(); });

  /* ================= STOCK CHANGES ================= */
  const shown = (t, s) => Math.max(0, (t.stock[s] || 0) + (pending[t.id + "|" + s] || 0));
  function bump(id, size, d) {
    const t = tees.find((x) => x.id === id); if (!t) return;
    const k = id + "|" + size;
    if (shown(t, size) + d < 0) return;
    pending[k] = (pending[k] || 0) + d;
    renderMain(); setSync("Salvataggio…");
    clearTimeout(timers[k]);
    timers[k] = setTimeout(() => flush(id, size), 650);
  }
  async function flush(id, size) {
    const k = id + "|" + size, d = pending[k]; delete timers[k];
    if (!d) { delete pending[k]; return; }
    try {
      const nv = await api.adjust(id, size, d);
      delete pending[k];
      const t = tees.find((x) => x.id === id); if (t) t.stock[size] = nv;
      setSync("Salvato"); reload();
    } catch (e) { delete pending[k]; toast("Modifica non salvata: " + (e.message || "errore")); reload(); }
  }
  async function setExact(id, size, val) {
    const k = id + "|" + size; clearTimeout(timers[k]); delete timers[k]; delete pending[k];
    const q = Math.max(0, Math.min(99999, parseInt(val, 10) || 0));
    try { await api.set(id, size, q); setSync("Salvato"); } catch (e) { toast("Modifica non salvata: " + (e.message || "errore")); }
    reload();
  }

  /* ================= RENDER ================= */
  const total = (t) => Object.keys(t.stock).reduce((a, s) => a + shown(t, s), 0);
  const isLow = (t, s) => { const v = shown(t, s); return v > 0 && v <= (t.threshold || 0); };
  const hasIssue = (t) => Object.keys(t.stock).some((s) => shown(t, s) <= (t.threshold || 0));
  const orderSizes = (t) => SIZES.filter((s) => s in t.stock);

  function renderLogin(msg) {
    editMode = false;
    $("#fab").hidden = true; $("#tabs").hidden = true; $("#gear").hidden = true; $("#who").innerHTML = "";
    $("#app").innerHTML = `<section class="login">
      <h1 class="g">Magazzino</h1>
      <p>Accesso riservato al team. Inserisci la tua email e ti mandiamo un link per entrare.</p>
      <form id="loginForm">
        <label class="field"><span>Email</span><input name="email" type="email" required autocomplete="email" inputmode="email"></label>
        <div class="err" id="loginMsg" role="alert">${esc(msg || "")}</div>
        <button class="btn" style="width:100%">Mandami il link di accesso</button>
      </form></section>`;
    $("#loginForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = e.target.email.value.trim().toLowerCase(), btn = e.target.querySelector("button");
      btn.disabled = true; $("#loginMsg").textContent = "";
      const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname } });
      btn.disabled = false;
      const code = error && (error.code || "");
      $("#loginMsg").textContent = !error ? "Link inviato: apri la mail da questo dispositivo."
        : code === "otp_disabled" || code === "user_not_found" ? "Questa email non è abilitata. Chiedi a chi gestisce il magazzino di aggiungerti."
        : error.status === 429 || /rate.?limit/i.test(code) ? "Troppi tentativi: aspetta qualche minuto e riprova."
        : "Non sono riuscito a mandare il link (" + (error.message || "errore") + "). Riprova tra poco.";
    });
  }

  const TABS = [["stock", "Magazzino"], ["sales", "Vendite"], ["orders", "Fornitore"], ["profit", "Guadagni"]];
  function renderFab() {
    const f = $("#fab");
    const label = tab === "stock" ? (editMode ? "Aggiungi design" : "") : tab === "sales" ? "Nuova vendita" : tab === "orders" ? "Nuovo ordine fornitore" : "";
    f.hidden = !label; f.textContent = label;
  }
  function showTab(t) {
    tab = t;
    TABS.forEach(([k]) => { const v = $("#v-" + k); if (v) v.hidden = k !== tab; });
    document.querySelectorAll("#tabs button").forEach((b) => b.setAttribute("aria-current", b.dataset.tab === tab ? "page" : "false"));
    renderFab();
  }

  function renderShell() {
    const nav = $("#tabs");
    nav.hidden = false;
    nav.innerHTML = TABS.map(([k, l]) => `<button data-tab="${k}">${l}</button>`).join("");
    nav.onclick = (e) => { const b = e.target.closest("button"); if (b) { showTab(b.dataset.tab); window.scrollTo(0, 0); } };
    if (LIVE && session) {
      $("#who").innerHTML = `<span>${esc(session.user.email)}</span><button class="link" id="logout">Esci</button>`;
      $("#logout").onclick = async () => { await sb.auth.signOut(); };
    }
    $("#app").innerHTML = `
      <p class="sync" id="sync"></p>
      <div id="v-stock">
        <section class="hero"><h1 class="g">Magazzino</h1></section>
        <div class="bar">
          <button class="chipbtn" id="lowBtn" aria-pressed="${onlyLow}">Da riordinare</button>
        </div>
        <div class="edit-notice" id="editNotice" ${editMode ? "" : "hidden"}>
          <span><strong>Modalità Modifica attiva</strong><br>Qui correggi le quantità a mano e aggiungi, modifichi o elimini i design. Per vendite e merce arrivata usa le altre schede.</span>
          <button class="btn ghost" id="finishEdit">Fine</button>
        </div>
        <div id="list"></div>
        <section class="log" id="logWrap" hidden><h2 class="g">Movimenti</h2><ol id="log"></ol></section>
        <section class="summary" aria-label="Riepilogo complessivo"><h2 class="g">Riepilogo</h2><div class="stats" id="stats"></div></section>
      </div>
      <div id="v-sales" hidden></div>
      <div id="v-orders" hidden></div>
      <div id="v-profit" hidden></div>`;
    $("#lowBtn").addEventListener("click", (e) => { onlyLow = !onlyLow; e.currentTarget.setAttribute("aria-pressed", onlyLow); renderMain(); });
    const gear = $("#gear");
    gear.hidden = false; gear.setAttribute("aria-pressed", editMode);
    gear.onclick = openSettings;
    $("#finishEdit").addEventListener("click", () => { editMode = false; renderShell(); renderMain(); });
    showTab(tab);
  }

  function renderMain() {
    if (!$("#list")) return;
    renderSales(); renderOrders(); renderProfit();
    const pieces = tees.reduce((a, t) => a + total(t), 0);
    const low = tees.reduce((a, t) => a + Object.keys(t.stock).filter((s) => isLow(t, s)).length, 0);
    const out = tees.reduce((a, t) => a + Object.keys(t.stock).filter((s) => shown(t, s) === 0).length, 0);
    $("#stats").innerHTML = `
      <div class="stat"><b>${pieces}</b><span>pezzi</span></div>
      <div class="stat"><b>${tees.length}</b><span>design</span></div>
      <div class="stat${low ? " alert" : ""}"><b>${low}</b><span>taglie quasi finite</span></div>
      <div class="stat${out ? " alert" : ""}"><b>${out}</b><span>taglie esaurite</span></div>`;

    const list = tees.filter((t) => !onlyLow || hasIssue(t));
    const L = $("#list");
    // keep focus on the qty field being typed into
    const act = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.set;
    if (!tees.length) L.innerHTML = `<div class="empty"><span class="d">Magazzino vuoto</span>Aggiungi il primo design per iniziare a contare.</div>`;
    else if (!list.length) L.innerHTML = `<div class="empty"><span class="d">Niente qui</span>Nessuna taglia da riordinare.</div>`;
    else L.innerHTML = list.map((t) => {
      const meta = ["maglietta " + (COLORS[t.color] || t.color), priceOf(t) != null ? "vendita " + eur(priceOf(t)) : "", costOf(t) != null ? "costo " + eur(costOf(t)) : "", "avviso a " + t.threshold].filter(Boolean).join(", ");
      return `<article class="tee">
        <div class="tee-head">
          ${t.image ? `<div class="thumb"><img src="${esc(t.image)}" alt="" loading="lazy"></div>` : `<div class="thumb none">no foto</div>`}
          <div><h2 class="tee-name d">${esc(t.name)}</h2><div class="tee-meta">${esc(meta)}</div></div>
          <div class="tee-tot">${total(t)}<small>pezzi</small></div>
        </div>
        <div class="sizes">${orderSizes(t).map((s) => {
          const v = shown(t, s), k = t.id + "|" + s;
          const cls = [v === 0 ? "zero" : isLow(t, s) ? "low" : "", pending[k] ? "pending" : ""].join(" ");
          if (!editMode) return `<div class="size ro ${cls}"><span class="lbl">${s}</span><b class="qty" aria-label="${esc(t.name)} taglia ${s}: ${v} pezzi">${v}</b></div>`;
          return `<div class="size ${cls}"><span class="lbl">${s}</span>
            <button data-b="${t.id}|${s}|-1" aria-label="Togli una ${s}">−</button>
            <input type="number" inputmode="numeric" min="0" value="${v}" data-set="${k}" aria-label="${esc(t.name)} taglia ${s}">
            <button data-b="${t.id}|${s}|1" aria-label="Aggiungi una ${s}">+</button></div>`;
        }).join("")}</div>
        ${editMode ? `<div class="tee-actions"><button class="link" data-edit="${t.id}">Modifica</button><button class="link" data-del="${t.id}">Elimina</button></div>` : ""}
      </article>`;
    }).join("");
    if (act) { const el = document.querySelector(`[data-set="${act}"]`); if (el) { el.focus(); } }

    const W = $("#logWrap");
    if (!moves.length) W.hidden = true;
    else {
      W.hidden = false;
      $("#log").innerHTML = moves.slice(0, 15).map((m) => {
        const d = new Date(m.created_at);
        const when = d.toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit" }) + " " + d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
        const by = m.by_email ? ` <span class="by">${esc(m.by_email.split("@")[0])}</span>` : "";
        return `<li><time>${when}</time><span class="dl">${m.delta > 0 ? "+" : ""}${m.delta}</span><span>${esc(m.tee_name || "Design eliminato")}, ${esc(m.size)}${by}</span></li>`;
      }).join("");
    }
  }

  /* ================= VENDITE / FORNITORE / GUADAGNI ================= */
  const PAYMENTS = ["Contanti", "Carta", "PayPal", "Satispay", "Bonifico", "Altro"];
  const num = (v) => Number(v) || 0;
  const priceOf = (t) => (t.price != null ? t.price : defs.price);
  const costOf = (t) => (t.cost != null ? t.cost : defs.cost);
  const when = (v) => { const d = new Date(v); return d.toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit", year: "2-digit" }) + " " + d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }); };
  const orderPieces = (o) => Object.values(o.qty || {}).reduce((a, n) => a + num(n), 0);
  const orderSizesText = (o) => SIZES.filter((s) => num((o.qty || {})[s]) > 0).map((s) => s + " × " + o.qty[s]).join(", ");
  const byWho = (r) => (r.by_email ? ` · ${esc(r.by_email.split("@")[0])}` : "");

  function renderSales() {
    const v = $("#v-sales"); if (!v) return;
    const rev = sales.reduce((a, s) => a + num(s.unit_price) * num(s.qty), 0);
    const pcs = sales.reduce((a, s) => a + num(s.qty), 0);
    v.innerHTML = `<section class="hero"><h1 class="g">Vendite</h1></section>
      <p class="hint">Ogni vendita toglie subito i pezzi dal magazzino. Se la elimini, i pezzi ci tornano.</p>
      ${sales.length ? `<div class="sumline"><b>${pcs}</b> pezzi venduti · <b>${eur(rev)}</b> incassati</div>
      <ol class="recs">${sales.map((s) => `<li class="rec">
        <div class="rec-main"><b class="d">${esc(s.customer)}</b>
          <div>${esc(s.tee_name || "Design eliminato")}, taglia ${esc(s.size)}${num(s.qty) > 1 ? " × " + num(s.qty) : ""}</div>
          <div class="meta">${when(s.created_at)} · ${esc(s.payment)}${byWho(s)}</div></div>
        <div class="rec-side"><b class="amt">${eur(num(s.unit_price) * num(s.qty))}</b><button class="link" data-sale-del="${esc(s.id)}">Elimina</button></div>
      </li>`).join("")}</ol>`
      : `<div class="empty"><span class="d">Nessuna vendita</span>Tocca «Nuova vendita» per registrare la prima.</div>`}`;
  }

  function renderOrders() {
    const v = $("#v-orders"); if (!v) return;
    const waiting = orders.filter((o) => o.status !== "ricevuto").reduce((a, o) => a + orderPieces(o), 0);
    v.innerHTML = `<section class="hero"><h1 class="g">Fornitore</h1></section>
      <p class="hint">Registra qui cosa ordini al fornitore. Quando arriva la merce tocca «Arrivato»: i pezzi entrano in magazzino.</p>
      ${orders.length ? `<div class="sumline"><b>${waiting}</b> pezzi in arrivo</div>
      <ol class="recs">${orders.map((o) => {
        const got = o.status === "ricevuto", n = orderPieces(o);
        return `<li class="rec">
        <div class="rec-main"><b class="d">${esc(o.tee_name || "Design eliminato")}</b>
          <div>${esc(orderSizesText(o))} · ${n} pezzi</div>
          <div class="meta">Ordinato il ${when(o.created_at)}${byWho(o)}${got && o.received_at ? " · arrivato il " + when(o.received_at) : ""}</div></div>
        <div class="rec-side"><b class="amt">${eur(num(o.unit_cost) * n)}</b>
          ${got ? `<span class="badge done">Arrivato</span>` : `<span class="badge">In arrivo</span><button class="btn small" data-ord-recv="${esc(o.id)}">Arrivato</button><button class="link" data-ord-del="${esc(o.id)}">Elimina</button>`}
        </div>
      </li>`; }).join("")}</ol>`
      : `<div class="empty"><span class="d">Nessun ordine</span>Tocca «Nuovo ordine fornitore» per registrare il primo.</div>`}`;
  }

  function renderProfit() {
    const v = $("#v-profit"); if (!v) return;
    const now = new Date(), from = period === "month" ? new Date(now.getFullYear(), now.getMonth(), 1).getTime() : 0;
    const inP = (r) => new Date(r.created_at).getTime() >= from;
    const S = sales.filter(inP), O = orders.filter(inP);
    let rev = 0, cogs = 0, pcs = 0, nocost = 0; const byTee = {}, byPay = {};
    S.forEach((s) => {
      const q = num(s.qty), r = num(s.unit_price) * q, c = num(s.unit_cost) * q, name = s.tee_name || "Design eliminato";
      rev += r; cogs += c; pcs += q; if (s.unit_cost == null) nocost++;
      const m = byTee[name] || (byTee[name] = { q: 0, r: 0, c: 0 }); m.q += q; m.r += r; m.c += c;
      byPay[s.payment || "–"] = (byPay[s.payment || "–"] || 0) + r;
    });
    const spent = O.reduce((a, o) => a + num(o.unit_cost) * orderPieces(o), 0);
    const profit = rev - cogs, margin = rev > 0 ? Math.round((profit / rev) * 100) + "%" : "–";
    const stockVal = tees.reduce((a, t) => a + total(t) * num(costOf(t)), 0);
    const cell = (b, l, alert) => `<div class="stat${alert ? " alert" : ""}"><b>${b}</b><span>${l}</span></div>`;
    const rows = (obj, fmt) => Object.entries(obj).sort((a, b) => fmt.sort(b[1]) - fmt.sort(a[1])).map(([k, x]) => `<li><span>${esc(k)}</span><span>${fmt.text(x)}</span></li>`).join("");
    v.innerHTML = `<section class="hero"><h1 class="g">Guadagni</h1></section>
      <div class="bar">
        <button class="chipbtn" data-period="all" aria-pressed="${period === "all"}">Sempre</button>
        <button class="chipbtn" data-period="month" aria-pressed="${period === "month"}">Questo mese</button>
      </div>
      <div class="stats grid">
        ${cell(eur(rev), "incassato")}${cell(eur(cogs), "costo dei pezzi venduti")}${cell(eur(profit), "guadagno", profit < 0)}${cell(margin, "margine")}
        ${cell(pcs, "pezzi venduti")}${cell(eur(spent), "speso dal fornitore")}${cell(eur(rev - spent), "incassato meno speso")}${cell(eur(stockVal), "valore magazzino ora")}
      </div>
      <p class="hint">Guadagno = incassato meno il costo dei soli pezzi venduti. «Incassato meno speso» conta invece tutto ciò che hai pagato al fornitore, anche la merce ancora in magazzino.</p>
      ${nocost ? `<p class="hint warn">Per ${nocost} vendite manca il costo dal fornitore, quindi il guadagno è sovrastimato. Imposta il costo standard con l'ingranaggio in alto a destra: vale per le vendite future.</p>` : ""}
      ${S.length ? `<section class="log"><h2 class="g">Per modello</h2><ol class="rows">${rows(byTee, { sort: (x) => x.r - x.c, text: (x) => `${x.q} pz · <b>${eur(x.r - x.c)}</b>` })}</ol></section>
      <section class="log"><h2 class="g">Per pagamento</h2><ol class="rows">${rows(byPay, { sort: (x) => x, text: (x) => `<b>${eur(x)}</b>` })}</ol></section>` : `<div class="empty"><span class="d">Ancora niente</span>I guadagni compaiono dopo la prima vendita.</div>`}`;
  }

  function openSettings() {
    const d = $("#dlg");
    const val = (k) => (defs[k] != null ? defs[k] : "");
    d.innerHTML = `<form class="dlg" id="st">
      <h3 class="g">Impostazioni</h3>
      <p class="hint" style="margin:0 0 14px">Prezzo di vendita e costo dal fornitore standard. Valgono per tutti i modelli e vengono proposti in vendite e ordini. Se un modello ha un prezzo diverso, lo imposti dalla modalità Modifica.</p>
      <div class="row">
        <label class="field"><span>Prezzo di vendita €</span><input name="price" type="number" inputmode="decimal" min="0" step="0.5" value="${val("price")}"></label>
        <label class="field"><span>Costo fornitore €</span><input name="cost" type="number" inputmode="decimal" min="0" step="0.01" value="${val("cost")}"></label>
      </div>
      <div class="err" id="ferr" role="alert"></div>
      <button type="button" class="btn ghost" id="toEdit" style="width:100%;margin-bottom:12px">${editMode ? "Esci da modalità Modifica" : "Modifica quantità e modelli"}</button>
      <div class="foot"><button type="button" class="btn ghost" id="cancel">Annulla</button><button class="btn" id="save">Salva</button></div>
    </form>`;
    const f = $("#st"), el = f.elements;
    const read = () => {
      const one = (n) => { const raw = el[n].value.trim(); if (raw === "") return null; const x = parseFloat(raw.replace(",", ".")); if (isNaN(x) || x < 0) throw new Error("Controlla i numeri: devono essere zero o più."); return x; };
      return { price: one("price"), cost: one("cost") };
    };
    const saveAll = async () => {
      $("#ferr").textContent = "";
      try { const m = read(); await api.saveDefs(m); defs = m; return true; }
      catch (er) { $("#ferr").textContent = "Non salvato: " + (er.message || "errore"); return false; }
    };
    $("#cancel").onclick = () => d.close();
    f.onsubmit = async (e) => {
      e.preventDefault(); $("#save").disabled = true;
      if (await saveAll()) { d.close(); toast("Prezzi salvati"); reload(); } else $("#save").disabled = false;
    };
    $("#toEdit").onclick = async () => {
      if (!(await saveAll())) return;
      d.close(); editMode = !editMode; if (editMode) tab = "stock";
      renderShell(); renderMain(); if (editMode) window.scrollTo(0, 0); reload();
    };
    d.showModal();
  }

  function teeLabel(t) { return `${esc(t.name)}, ${esc(t.color)}`; }

  function openSaleForm() {
    if (!tees.length) { toast("Aggiungi prima un design nel Magazzino"); return; }
    const d = $("#dlg");
    d.innerHTML = `<form class="dlg" id="sf">
      <h3 class="g">Nuova vendita</h3>
      <label class="field"><span>Nome cliente</span><input name="customer" required maxlength="80" autocomplete="off"></label>
      <label class="field"><span>Modello</span><select name="tee">${tees.map((t) => `<option value="${esc(t.id)}">${teeLabel(t)}</option>`).join("")}</select></label>
      <div class="row">
        <label class="field"><span>Taglia</span><select name="size"></select></label>
        <label class="field"><span>Quantità</span><input name="qty" type="number" inputmode="numeric" min="1" step="1" value="1" required></label>
      </div>
      <div class="row">
        <label class="field"><span>Prezzo cad. €</span><input name="price" type="number" inputmode="decimal" min="0" step="0.5" required></label>
        <label class="field"><span>Pagamento</span><select name="payment">${PAYMENTS.map((p) => `<option>${p}</option>`).join("")}</select></label>
      </div>
      <div class="total" id="stot"></div>
      <div class="err" id="ferr" role="alert"></div>
      <div class="foot"><button type="button" class="btn ghost" id="cancel">Annulla</button><button class="btn" id="save">Registra vendita</button></div>
    </form>`;
    const f = $("#sf"), el = f.elements, teeOf = () => tees.find((t) => t.id === el.tee.value);
    const fillSizes = () => {
      const t = teeOf();
      el.size.innerHTML = orderSizes(t).map((s) => `<option value="${s}">${s} · ${shown(t, s)} disp.</option>`).join("");
      const first = orderSizes(t).find((s) => shown(t, s) > 0); if (first) el.size.value = first;
    };
    const upd = () => { const q = parseInt(el.qty.value, 10) || 0, p = parseFloat(el.price.value); $("#stot").textContent = q > 0 && !isNaN(p) ? "Totale: " + eur(q * p) : ""; };
    el.tee.onchange = () => { const t = teeOf(); fillSizes(); el.price.value = priceOf(t) != null ? priceOf(t) : ""; upd(); };
    f.addEventListener("input", upd);
    el.tee.onchange();
    $("#cancel").onclick = () => d.close();
    f.onsubmit = async (e) => {
      e.preventDefault();
      const customer = el.customer.value.trim(), qty = parseInt(el.qty.value, 10), price = parseFloat(el.price.value);
      if (!customer) { $("#ferr").textContent = "Scrivi il nome del cliente."; return; }
      if (!(qty >= 1)) { $("#ferr").textContent = "Metti almeno 1 pezzo."; return; }
      if (!(price >= 0)) { $("#ferr").textContent = "Inserisci il prezzo."; return; }
      $("#save").disabled = true; $("#ferr").textContent = "";
      try {
        await api.createSale({ tee_id: el.tee.value, size: el.size.value, qty, customer, payment: el.payment.value, price });
        d.close(); toast("Vendita registrata, magazzino aggiornato"); reload();
      } catch (er) { $("#ferr").textContent = "Non salvata: " + (er.message || "errore"); $("#save").disabled = false; }
    };
    d.showModal();
  }

  function openOrderForm() {
    if (!tees.length) { toast("Aggiungi prima un design nel Magazzino"); return; }
    const d = $("#dlg");
    d.innerHTML = `<form class="dlg" id="of">
      <h3 class="g">Ordine al fornitore</h3>
      <label class="field"><span>Modello</span><select name="tee">${tees.map((t) => `<option value="${esc(t.id)}">${teeLabel(t)}</option>`).join("")}</select></label>
      <div class="field"><span>Pezzi per taglia</span><div class="row">${SIZES.map((s) => `<label class="field"><span>${s}</span><input name="q_${s}" type="number" inputmode="numeric" min="0" step="1" placeholder="0"></label>`).join("")}</div></div>
      <label class="field"><span>Costo cad. dal fornitore €</span><input name="cost" type="number" inputmode="decimal" min="0" step="0.01" required></label>
      <div class="total" id="stot"></div>
      <div class="err" id="ferr" role="alert"></div>
      <div class="foot"><button type="button" class="btn ghost" id="cancel">Annulla</button><button class="btn" id="save">Salva ordine</button></div>
    </form>`;
    const f = $("#of"), el = f.elements, teeOf = () => tees.find((t) => t.id === el.tee.value);
    const qtys = () => { const q = {}; SIZES.forEach((s) => { const n = parseInt(el["q_" + s].value, 10); if (n > 0) q[s] = n; }); return q; };
    const upd = () => { const n = Object.values(qtys()).reduce((a, b) => a + b, 0), c = parseFloat(el.cost.value); $("#stot").textContent = n > 0 ? n + " pezzi" + (!isNaN(c) ? " · Totale: " + eur(n * c) : "") : ""; };
    el.tee.onchange = () => { const t = teeOf(); el.cost.value = costOf(t) != null ? costOf(t) : ""; upd(); };
    f.addEventListener("input", upd);
    el.tee.onchange();
    $("#cancel").onclick = () => d.close();
    f.onsubmit = async (e) => {
      e.preventDefault();
      const qty = qtys(), cost = parseFloat(el.cost.value), t = teeOf();
      if (!Object.keys(qty).length) { $("#ferr").textContent = "Metti almeno un pezzo in una taglia."; return; }
      if (!(cost >= 0)) { $("#ferr").textContent = "Inserisci il costo dal fornitore."; return; }
      $("#save").disabled = true; $("#ferr").textContent = "";
      try { await api.saveOrder({ tee_id: t.id, tee_name: t.name, qty, unit_cost: cost }); d.close(); toast("Ordine salvato"); reload(); }
      catch (er) { $("#ferr").textContent = "Non salvato: " + (er.message || "errore"); $("#save").disabled = false; }
    };
    d.showModal();
  }

  /* ================= EVENTS ================= */
  $("#app").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.period) { period = b.dataset.period; return renderProfit(); }
    const fail = (er) => toast("Non riuscito: " + (er.message || "errore"));
    if (b.dataset.saleDel) {
      const x = sales.find((r) => String(r.id) === b.dataset.saleDel); if (!x) return;
      if (confirm(`Eliminare la vendita di ${x.customer}? I ${x.qty} pezzi tornano in magazzino.`))
        api.deleteSale(b.dataset.saleDel).then(() => { toast("Vendita eliminata"); reload(); }).catch(fail);
      return;
    }
    if (b.dataset.ordRecv) {
      const x = orders.find((r) => String(r.id) === b.dataset.ordRecv); if (!x) return;
      if (confirm(`La merce è arrivata? Aggiungo ${orderPieces(x)} pezzi di "${x.tee_name}" al magazzino.`)) {
        b.disabled = true;
        api.receiveOrder(b.dataset.ordRecv).then(() => { toast("Magazzino aggiornato"); reload(); }).catch((er) => { b.disabled = false; fail(er); });
      }
      return;
    }
    if (b.dataset.ordDel) {
      const x = orders.find((r) => String(r.id) === b.dataset.ordDel); if (!x) return;
      if (confirm(`Eliminare l'ordine di "${x.tee_name}"?`)) api.deleteOrder(b.dataset.ordDel).then(() => { toast("Ordine eliminato"); reload(); }).catch(fail);
      return;
    }
    if (b.dataset.b) { const [id, s, d] = b.dataset.b.split("|"); return bump(id, s, +d); }
    if (b.dataset.edit && editMode) return openForm(tees.find((t) => t.id === b.dataset.edit));
    if (b.dataset.del && editMode) {
      const t = tees.find((x) => x.id === b.dataset.del);
      if (confirm(`Eliminare "${t.name}" dal magazzino? Le quantità vengono cancellate.`))
        api.deleteTee(t.id).then(() => { toast("Design eliminato"); reload(); }).catch((er) => toast("Eliminazione non riuscita: " + er.message));
    }
  });
  $("#app").addEventListener("change", (e) => { const k = e.target.dataset.set; if (k) { const [id, s] = k.split("|"); setExact(id, s, e.target.value); } });
  $("#app").addEventListener("focusin", (e) => { if (e.target.dataset.set) e.target.select(); });
  $("#fab").addEventListener("click", () => { if (tab === "stock") { if (editMode) openForm(); } else if (tab === "sales") openSaleForm(); else if (tab === "orders") openOrderForm(); });

  /* ================= FORM ================= */
  function resizeImage(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file), im = new Image();
      im.onload = () => {
        const n = 800, c = document.createElement("canvas"); c.width = c.height = n;
        const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, n, n);
        const s = Math.min(n / im.width, n / im.height);
        x.drawImage(im, (n - im.width * s) / 2, (n - im.height * s) / 2, im.width * s, im.height * s);
        URL.revokeObjectURL(url); c.toBlob((b) => (b ? res(b) : rej(new Error("Foto non leggibile"))), "image/jpeg", 0.82);
      };
      im.onerror = () => rej(new Error("Foto non leggibile")); im.src = url;
    });
  }
  function openForm(t) {
    const d = $("#dlg"); let blob = null;
    d.innerHTML = `<form class="dlg" id="tf">
      <h3 class="g">${t ? "Modifica design" : "Nuovo design"}</h3>
      <div class="field"><span>Foto</span><div class="photo">
        <div class="thumb${t && t.image ? "" : " none"}" id="prev">${t && t.image ? `<img src="${esc(t.image)}" alt="">` : "no foto"}</div>
        <input type="file" accept="image/*" id="file" aria-label="Scegli una foto"></div></div>
      <label class="field"><span>Nome del design</span><input name="name" required maxlength="60" value="${esc(t ? t.name : "")}"></label>
      <label class="field"><span>Colore maglietta</span><select name="color">${Object.keys(COLORS).map((c) => `<option value="${c}" ${t && t.color === c ? "selected" : ""}>${c[0].toUpperCase() + c.slice(1)}</option>`).join("")}</select></label>
      <div class="row">
        <label class="field"><span>Prezzo di vendita €</span><input name="price" type="number" inputmode="decimal" min="0" step="0.5" value="${t && t.price != null ? t.price : ""}" placeholder="standard ${defs.price != null ? defs.price : ""}"></label>
        <label class="field"><span>Costo fornitore €</span><input name="cost" type="number" inputmode="decimal" min="0" step="0.01" value="${t && t.cost != null ? t.cost : ""}" placeholder="standard ${defs.cost != null ? defs.cost : ""}"></label>
      </div>
      <p class="hint" style="margin:-6px 0 14px">Lascia vuoto per usare il prezzo e il costo standard delle Impostazioni.</p>
      <label class="field"><span>Avvisami quando una taglia scende a</span><input name="threshold" type="number" inputmode="numeric" min="0" value="${t ? t.threshold : 3}"></label>
      <div class="field"><span>Taglie disponibili</span><div class="chips">${SIZES.map((s) => `<span class="chip">${s}</span>`).join("")}</div></div>
      <div class="err" id="ferr" role="alert"></div>
      <div class="foot"><button type="button" class="btn ghost" id="cancel">Annulla</button><button class="btn" id="save">${t ? "Salva modifiche" : "Salva design"}</button></div>
    </form>`;
    $("#cancel").onclick = () => d.close();
    $("#file").onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try { blob = await resizeImage(f); $("#prev").className = "thumb"; $("#prev").innerHTML = `<img src="${URL.createObjectURL(blob)}" alt="">`; }
      catch (er) { $("#ferr").textContent = er.message; }
    };
    $("#tf").onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      if (!f.name.value.trim()) { $("#ferr").textContent = "Dai un nome al design."; return; }
      $("#save").disabled = true; $("#ferr").textContent = "";
      try {
        const image = blob ? await api.upload(blob) : t ? t.image : null;
        await api.saveTee({ id: t && t.id, name: f.name.value.trim(), color: f.color.value, price: f.price.value === "" ? null : Math.max(0, +f.price.value), cost: f.cost.value === "" ? null : Math.max(0, +f.cost.value), threshold: Math.max(0, parseInt(f.threshold.value, 10) || 0), image });
        d.close(); toast(t ? "Modifiche salvate" : "Design aggiunto"); reload();
      } catch (er) { $("#ferr").textContent = "Salvataggio non riuscito: " + (er.message || "errore"); $("#save").disabled = false; }
    };
    d.showModal();
  }

  /* ================= BOOT ================= */
  if (!LIVE) {
    const ban = $("#banner"); ban.hidden = false;
    ban.textContent = "Modalità prova: i dati restano su questo dispositivo finché non colleghi Supabase in config.js.";
    renderShell(); reload();
  } else {
    sb.auth.onAuthStateChange((_ev, s) => {
      const was = !!session; session = s;
      if (s && !was) { renderShell(); reload(); startRealtime(); }
      if (!s) { if (rt) { sb.removeChannel(rt); rt = null; } renderLogin(); }
    });
    sb.auth.getSession().then(({ data }) => { if (!data.session) renderLogin(); });
  }
})();
