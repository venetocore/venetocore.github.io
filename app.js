(function () {
  "use strict";
  const SIZES = ["S", "M", "L", "XL"];
  const COLORS = { nero: "nera", bianco: "bianca", grigio: "grigia", altro: "di altro colore" };
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const eur = (n) => "€" + Number(n).toLocaleString("it-IT", { maximumFractionDigits: 2 });

  const cfg = window.VC_CONFIG || {};
  const LIVE = !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase);
  const sb = LIVE ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;

  let tees = [];      // {id,name,color,price,threshold,image,created_at,stock:{S:3}}
  let moves = [];     // {id,created_at,tee_name,size,delta,by_email}
  let session = null;
  let editMode = false, onlyLow = false;
  const pending = {}; // "teeId|size" -> delta not yet saved
  const timers = {};

  function toast(t) { const el = $("#toast"); el.textContent = t; el.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove("show"), 2600); }
  function setSync(t) { const el = $("#sync"); if (el) el.textContent = t; }

  /* ================= DATA LAYER ================= */
  const local = {
    KEY: "vc-magazzino-local-v1",
    read() {
      try { const s = JSON.parse(localStorage.getItem(this.KEY)); if (s && s.tees) return s; } catch (e) {}
      const now = Date.now();
      return {
        tees: [
          { id: "t1", name: "Will never die", color: "nero", price: null, threshold: 3, image: "img/will-never-die.jpg", created_at: now - 3, stock: { S: 0, M: 0, L: 0, XL: 0 } },
          { id: "t2", name: "Nordest", color: "bianco", price: null, threshold: 3, image: "img/nordest.jpg", created_at: now - 2, stock: { S: 0, M: 0, L: 0, XL: 0 } },
          { id: "t3", name: "I ♫ Veneto", color: "nero", price: null, threshold: 3, image: "img/i-nota-veneto.jpg", created_at: now - 1, stock: { S: 0, M: 0, L: 0, XL: 0 } }
        ], moves: []
      };
    },
    write(s) { try { localStorage.setItem(this.KEY, JSON.stringify(s)); } catch (e) { toast("Memoria del browser piena: usa foto più leggere"); } },
    async load() {
      const s = this.read();
      return {
        tees: s.tees.map((t) => ({ ...t, stock: Object.fromEntries(SIZES.map((size) => [size, t.stock[size] || 0])) })),
        moves: s.moves.slice(0, 20)
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
      Object.assign(t, { name: data.name, color: data.color, price: data.price, threshold: data.threshold, image: data.image });
      const st = { ...t.stock }; SIZES.forEach((z) => (st[z] = t.stock[z] || 0)); t.stock = st;
      this.write(s);
    },
    async deleteTee(id) { const s = this.read(); s.tees = s.tees.filter((t) => t.id !== id); this.write(s); },
    async upload(blob) { return await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); }); }
  };

  const remote = {
    async load() {
      const [a, b] = await Promise.all([
        sb.from("tees").select("id,name,color,price,threshold,image,created_at,stock(size,qty)").order("created_at"),
        sb.from("moves").select("id,created_at,tee_name,size,delta,by_email").order("created_at", { ascending: false }).limit(20)
      ]);
      if (a.error) throw a.error; if (b.error) throw b.error;
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
        moves: b.data
      };
    },
    async adjust(id, size, d) { const { data, error } = await sb.rpc("adjust_stock", { p_tee: id, p_size: size, p_delta: d }); if (error) throw error; return data; },
    async set(id, size, q) { const { data, error } = await sb.rpc("set_stock", { p_tee: id, p_size: size, p_qty: q }); if (error) throw error; return data; },
    async saveTee(data) {
      const row = { name: data.name, color: data.color, price: data.price, threshold: data.threshold, image: data.image };
      let id = data.id;
      if (id) { const { error } = await sb.from("tees").update(row).eq("id", id); if (error) throw error; }
      else { const { data: ins, error } = await sb.from("tees").insert(row).select("id").single(); if (error) throw error; id = ins.id; }
      const { error: e1 } = await sb.from("stock").upsert(SIZES.map((size) => ({ tee_id: id, size, qty: 0 })), { onConflict: "tee_id,size", ignoreDuplicates: true });
      if (e1) throw e1;
    },
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
    try { const r = await api.load(); tees = r.tees; moves = r.moves; renderMain(); setSync(LIVE ? "Aggiornato alle " + new Date().toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }) : "Modalità prova: dati solo su questo dispositivo"); }
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
    $("#fab").hidden = true; $("#who").innerHTML = "";
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
      $("#loginMsg").textContent = error ? "Questa email non è abilitata. Chiedi a chi gestisce il magazzino di aggiungerti." : "Link inviato: apri la mail da questo dispositivo.";
    });
  }

  function renderShell() {
    $("#fab").hidden = !editMode;
    if (LIVE && session) {
      $("#who").innerHTML = `<span>${esc(session.user.email)}</span><button class="link" id="logout">Esci</button>`;
      $("#logout").onclick = async () => { await sb.auth.signOut(); };
    }
    $("#app").innerHTML = `
      <section class="hero"><h1 class="g">Magazzino</h1></section>
      <div class="bar">
        <button class="chipbtn" id="lowBtn" aria-pressed="${onlyLow}">Da riordinare</button>
        <details class="menu">
          <summary class="chipbtn">Menu</summary>
          <div class="menu-panel"><button class="menu-action" id="editToggle">${editMode ? "Esci da modalità Modifica" : "Attiva modalità Modifica"}</button></div>
        </details>
        <span class="sync" id="sync"></span>
      </div>
      <div class="edit-notice" id="editNotice" ${editMode ? "" : "hidden"}>
        <span><strong>Modalità Modifica attiva</strong><br>Puoi aggiungere, modificare o eliminare design.</span>
        <button class="btn ghost" id="finishEdit">Fine</button>
      </div>
      <div id="list"></div>
      <section class="log" id="logWrap" hidden><h2 class="g">Movimenti</h2><ol id="log"></ol></section>
      <section class="summary" aria-label="Riepilogo complessivo"><h2 class="g">Riepilogo</h2><div class="stats" id="stats"></div></section>`;
    $("#lowBtn").addEventListener("click", (e) => { onlyLow = !onlyLow; e.currentTarget.setAttribute("aria-pressed", onlyLow); renderMain(); });
    $("#editToggle").addEventListener("click", () => { editMode = !editMode; renderShell(); renderMain(); });
    $("#finishEdit").addEventListener("click", () => { editMode = false; renderShell(); renderMain(); });
  }

  function renderMain() {
    if (!$("#list")) return;
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
      const meta = ["maglietta " + (COLORS[t.color] || t.color), t.price != null ? eur(t.price) : "", "avviso a " + t.threshold].filter(Boolean).join(", ");
      return `<article class="tee">
        <div class="tee-head">
          ${t.image ? `<div class="thumb"><img src="${esc(t.image)}" alt="" loading="lazy"></div>` : `<div class="thumb none">no foto</div>`}
          <div><h2 class="tee-name d">${esc(t.name)}</h2><div class="tee-meta">${esc(meta)}</div></div>
          <div class="tee-tot">${total(t)}<small>pezzi</small></div>
        </div>
        <div class="sizes">${orderSizes(t).map((s) => {
          const v = shown(t, s), k = t.id + "|" + s;
          const cls = [v === 0 ? "zero" : isLow(t, s) ? "low" : "", pending[k] ? "pending" : ""].join(" ");
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

  /* ================= EVENTS ================= */
  $("#app").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
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
  $("#fab").addEventListener("click", () => { if (editMode) openForm(); });

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
      <div class="row">
        <label class="field"><span>Colore maglietta</span><select name="color">${Object.keys(COLORS).map((c) => `<option value="${c}" ${t && t.color === c ? "selected" : ""}>${c[0].toUpperCase() + c.slice(1)}</option>`).join("")}</select></label>
        <label class="field"><span>Prezzo €</span><input name="price" type="number" inputmode="decimal" min="0" step="0.5" value="${t && t.price != null ? t.price : ""}" placeholder="facoltativo"></label>
      </div>
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
        await api.saveTee({ id: t && t.id, name: f.name.value.trim(), color: f.color.value, price: f.price.value === "" ? null : Math.max(0, +f.price.value), threshold: Math.max(0, parseInt(f.threshold.value, 10) || 0), image });
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
