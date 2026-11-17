/* Inventory Flow Analytics - operational pages: product gallery, unallocated stock, validation, export. */
(function () {
  "use strict";
  const App = window.App;
  const { fmt, esc } = App;
  const S = App.state;
  const db = () => App.db;
  const F = () => App.db.fact_stock;
  const sku = i => App.db.dim_product[App.db.fact_stock.sku_key[i]];
  const loc = i => App.db.dim_store[App.db.fact_stock.store_key[i]];
  const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);

  // ============================================================== GALERIA DE PRODUTOS (gallery with neutral placeholders)
  const AGE_OPTIONS = [["", "Todas as idades"], ["0-0", "0–30 dias"], ["1-1", "31–60 dias"], ["2-2", "61–90 dias"], ["3-3", "91–180 dias"],
    ["4-4", "181–365 dias"], ["5-5", "Mais de 365 dias"], ["3-5", "Acima de 90 dias"], ["4-5", "Acima de 180 dias"], ["6-6", "Pré-lançamento"]];
  const bf = { q: "", sort: "qty", cat: "*", age: "", onlyAvail: false, shown: 48 };

  function galleryModels() {
    const m = S.ref, ag = App.agingIndex(m);
    const byModel = new Map();
    for (const i of App.byMonth[m]) {
      if (!App.pass(i)) continue;
      const on = F().qty_on_hand[i];
      if (!on) continue;
      const p = sku(i);
      let g = byModel.get(p.model);
      if (!g) byModel.set(p.model, (g = { model: p.model, p, name: App.models.get(p.model).name, qty: 0, avail: 0, cost: 0, colors: new Map(), cd: new Set(), shops: new Set(), age: ag[p.sku_key] }));
      g.qty += on; g.cost += F().cost_value[i];
      g.avail += on - F().qty_reserved[i] - F().qty_blocked[i];
      g.colors.set(p.color, (g.colors.get(p.color) || 0) + on);
      (loc(i).type === "LOJA" ? g.shops : g.cd).add(F().store_key[i]);
    }
    return [...byModel.values()];
  }

  function renderGallery(el) {
    if (App.galleryAge !== undefined) { bf.age = App.galleryAge; App.galleryAge = undefined; bf.shown = 48; }
    if (App.galleryCat !== undefined) { bf.cat = App.galleryCat; App.galleryCat = undefined; }
    const all = galleryModels();
    const catCounts = new Map();
    all.forEach(g => catCounts.set(g.p.category, (catCounts.get(g.p.category) || 0) + 1));
    el.innerHTML = `
      <div class="page-kpis" id="bf-kpis"></div>
      <div class="card">
        <div class="toolbar">
          <div class="chips" id="bf-cats" style="margin:0"><button data-c="*" class="${bf.cat === "*" ? "on" : ""}">Todas <small>${all.length}</small></button>
            ${db().meta.categories.filter(c => catCounts.has(c)).map(c => `<button data-c="${esc(c)}" class="${bf.cat === c ? "on" : ""}">${esc(c)} <small>${catCounts.get(c)}</small></button>`).join("")}</div>
          <div class="tools">
            <input type="search" class="field" id="bf-q" placeholder="Buscar modelo, linha, coleção, cor…" value="${esc(bf.q)}">
            <select class="field" id="bf-age" aria-label="Idade do estoque">${AGE_OPTIONS.map(([v, t]) => `<option value="${v}" ${v === bf.age ? "selected" : ""}>${t}</option>`).join("")}</select>
            <select class="field" id="bf-sort" aria-label="Ordenar">
              <option value="qty">Mais peças</option><option value="cost">Maior custo</option><option value="avail">Mais disponível</option>
              <option value="age">Mais antigo</option><option value="name">Modelo A–Z</option></select>
            <label class="toggle"><input type="checkbox" id="bf-avail" ${bf.onlyAvail ? "checked" : ""}>Só com disponível</label>
            <button class="btn" id="bf-csv" title="Exporta modelo × cor × local">Exportar CSV</button>
          </div>
        </div>
        <div id="bf-body"></div>
      </div>
      <p class="note">As imagens são ícones genéricos por categoria, tingidos pela linha: o projeto não usa fotos de produto.</p>`;
    el.querySelector("#bf-sort").value = bf.sort;
    const redraw = () => { bf.shown = 48; drawGallery(all); };
    let t;
    el.querySelector("#bf-q").oninput = e => { clearTimeout(t); t = setTimeout(() => { bf.q = e.target.value.trim().toLowerCase(); redraw(); }, 250); };
    el.querySelector("#bf-age").onchange = e => { bf.age = e.target.value; redraw(); };
    el.querySelector("#bf-sort").onchange = e => { bf.sort = e.target.value; redraw(); };
    el.querySelector("#bf-avail").onchange = e => { bf.onlyAvail = e.target.checked; redraw(); };
    el.querySelector("#bf-cats").onclick = e => {
      const b = e.target.closest("button[data-c]");
      if (!b) return;
      bf.cat = b.dataset.c;
      el.querySelectorAll("#bf-cats button").forEach(x => x.classList.toggle("on", x === b));
      redraw();
    };
    el.querySelector("#bf-csv").onclick = () => exportGallery();
    el.querySelector("#bf-body").addEventListener("click", e => {
      const tile = e.target.closest(".tile");
      if (tile) App.openProduct(tile.dataset.m);
      if (e.target.closest("#bf-more")) { bf.shown += 48; drawGallery(all); }
    });
    drawGallery(all);
  }
  function filteredGallery(all) {
    const [amin, amax] = bf.age ? bf.age.split("-").map(Number) : [0, 6];
    let list = all.filter(g => (bf.cat === "*" || g.p.category === bf.cat) && g.age >= amin && g.age <= amax && (!bf.onlyAvail || g.avail > 0));
    if (bf.q) list = list.filter(g => [g.model, g.name, g.p.line, g.p.collection, g.p.subcategory, ...g.colors.keys()].join(" ").toLowerCase().includes(bf.q));
    const by = { qty: (a, b) => b.qty - a.qty, cost: (a, b) => b.cost - a.cost, avail: (a, b) => b.avail - a.avail,
      age: (a, b) => App.skuAgeDays(b.p.sku_key) - App.skuAgeDays(a.p.sku_key), name: (a, b) => a.name.localeCompare(b.name, "pt-BR") }[bf.sort];
    return list.sort(by);
  }
  function drawGallery(all) {
    const list = filteredGallery(all);
    document.getElementById("bf-kpis").innerHTML = `
      <div class="kpi"><h3>Modelos com estoque</h3><div class="value">${fmt.int(list.length)}</div><div class="foot">de ${fmt.int(all.length)} no filtro global</div></div>
      <div class="kpi"><h3>Variações (cores)</h3><div class="value">${fmt.int(sum(list, g => g.colors.size))}</div><div class="foot">média de ${fmt.dec1(list.length ? sum(list, g => g.colors.size) / list.length : 0)} por modelo</div></div>
      <div class="kpi"><h3>Peças</h3><div class="value">${fmt.int(sum(list, g => g.qty))}</div><div class="foot">${fmt.int(sum(list, g => g.avail))} disponíveis · ${fmt.moneyShort(sum(list, g => g.cost))}</div></div>`;
    const body = document.getElementById("bf-body");
    const ageTag = g => (g.age === 6 ? App.badge("neutral", "Pré-lançamento") : g.age >= 5 ? App.badge("hot", "> 365 dias") : g.age === 4 ? App.badge("warn", "> 180 dias") : "");
    body.innerHTML = list.length ? `<div class="gallery">${list.slice(0, bf.shown).map(g => {
      const colors = [...g.colors.entries()].sort((a, b) => b[1] - a[1]);
      return `<button class="tile" data-m="${esc(g.model)}">
        ${App.thumb(g.p, { tag: ageTag(g) })}
        <div class="tile-body">
          <div class="tile-l1"><b>${esc(g.model)}</b><span>${fmt.int(g.qty)} pç</span></div>
          <div class="tile-l2">${esc(g.name)} · ${esc(g.p.line)}</div>
          <div class="tile-stock"><div class="tile-bar"><span style="width:${g.qty ? (g.avail / g.qty) * 100 : 0}%"></span></div><small>${fmt.int(g.avail)} disp.</small></div>
          <div class="swatches">${colors.slice(0, 3).map(([c, q]) => `<span class="swatch" title="${fmt.int(q)} peças">${esc(c)}</span>`).join("")}${colors.length > 3 ? `<span class="swatch">+${colors.length - 3}</span>` : ""}</div>
          <div class="swatches">${g.cd.size ? App.badge("neutral", `${g.cd.size} CD/trânsito`) : ""}${g.shops.size ? App.badge("ok", `${g.shops.size} loja${g.shops.size > 1 ? "s" : ""}`) : App.badge("warn", "fora das lojas")}</div>
        </div></button>`;
    }).join("")}</div>
      <div class="more-row"><span>Mostrando ${fmt.int(Math.min(bf.shown, list.length))} de ${fmt.int(list.length)} modelos</span>
        ${list.length > bf.shown ? `<button class="btn" id="bf-more">Mostrar mais</button>` : ""}</div>`
      : `<p class="empty">Nenhum modelo com estoque para esses filtros.</p>`;
  }
  function exportGallery() {
    const all = filteredGallery(galleryModels());
    const models = new Set(all.map(g => g.model));
    const rows = [];
    for (const i of App.byMonth[S.ref]) {
      if (!App.pass(i) || !F().qty_on_hand[i]) continue;
      const p = sku(i);
      if (!models.has(p.model)) continue;
      const s = loc(i);
      rows.push({ model: p.model, sku: p.sku, name: p.model_name, color: p.color, category: p.category, line: p.line, collection: p.collection, launch: p.launch_date,
        local: s.name, type: s.type_label, region: s.region, qty: F().qty_on_hand[i], avail: F().qty_on_hand[i] - F().qty_reserved[i] - F().qty_blocked[i], cost: F().cost_value[i] });
    }
    App.downloadCsv("galeria_produtos", [{ k: "model", label: "Modelo" }, { k: "sku", label: "SKU" }, { k: "name", label: "Nome" }, { k: "color", label: "Cor" }, { k: "category", label: "Categoria" },
      { k: "line", label: "Linha" }, { k: "collection", label: "Coleção" }, { k: "launch", label: "Lançamento" }, { k: "local", label: "Local" }, { k: "type", label: "Tipo de local" },
      { k: "region", label: "Região" }, { k: "qty", label: "Peças", type: "int" }, { k: "avail", label: "Disponível", type: "int" }, { k: "cost", label: "Custo" }], rows);
  }

  App.page({
    id: "galeria", order: 5, title: "Galeria de Produtos",
    subtitle: () => `Galeria de modelos com estoque em ${db().dim_date[S.ref].label} · clique num card para ver o detalhe`,
    icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
    render: renderGallery,
  });

  // ============================================================== PENDENTE DE ALOCAÇÃO
  const STATUS = ["Pendente", "Em análise", "Alocar", "Devolver ao fornecedor"];
  const na = { q: "", status: "*", open: new Set() };
  const statusKey = () => "ifa-na-status-" + S.seed;
  function unallocated() {
    const D = db(), m = S.ref;
    // RECEB quantity per SKU for every month up to m (to count how long it has been waiting)
    const hist = new Map();
    for (let mm = 0; mm <= m; mm++) for (const i of App.byMonth[mm]) {
      if (loc(i).type !== "RECEB" || !App.pass(i)) continue;
      const k = F().sku_key[i];
      if (!hist.has(k)) hist.set(k, new Map());
      hist.get(k).set(mm, (hist.get(k).get(mm) || 0) + F().qty_on_hand[i]);
    }
    const saved = App.store.get(statusKey(), {}) || {};
    const items = [];
    hist.forEach((h, k) => {
      const qty = h.get(m) || 0;
      if (!qty) return;
      let days = 15;   // mid-month estimate for the reference month
      for (let mm = m - 1; mm >= 0 && (h.get(mm) || 0) > 0; mm--) days += D.dim_date[mm].days;
      const p = D.dim_product[k];
      items.push({ k, p, sku: p.sku, model: p.model, name: p.model_name, color: p.color, line: p.line, category: p.category, collection: p.collection,
        qty, cost: qty * p.unit_cost * (1 - 0.004 * (D.dim_date.length - 1 - m)), days, status: saved[p.sku] || "Pendente" });
    });
    return items;
  }
  function renderUnallocated(el) {
    const D = db(), m = S.ref;
    const items = unallocated();
    const pieces = sum(items, x => x.qty), cost = sum(items, x => x.cost);
    const oldest = items.slice().sort((a, b) => b.days - a.days)[0];
    // upcoming launches (next 3 months) sitting in the CDs
    let upcoming = 0;
    for (const i of App.byMonth[m]) if (App.pass(i)) { const l = sku(i).launch_idx; if (l > m && l <= m + 3) upcoming += F().qty_on_hand[i]; }
    const BUCKETS = [["até 30 dias", 0, 31], ["31–60 dias", 31, 62], ["61–90 dias", 62, 93], ["91–180 dias", 93, 184], ["mais de 180 dias", 184, 1e9]];
    const byBucket = BUCKETS.map(([t, a, b]) => ({ t, qty: sum(items.filter(x => x.days >= a && x.days < b), x => x.qty) }));
    const byCat = new Map();
    items.forEach(x => byCat.set(x.category, (byCat.get(x.category) || 0) + x.cost));
    const cats = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
    const mxB = Math.max(1, ...byBucket.map(b => b.qty)), mxC = Math.max(1, ...cats.map(c => c[1]));
    const ramp = App.ramp(5);

    el.innerHTML = `
      <div class="page-kpis six">
        <div class="kpi"><h3>Peças pendentes de alocação</h3><div class="value">${fmt.int(pieces)}</div><div class="foot">na área de recebimento do CD</div></div>
        <div class="kpi"><h3>Modelos</h3><div class="value">${fmt.int(new Set(items.map(x => x.model)).size)}</div><div class="foot">${fmt.int(items.length)} SKUs</div></div>
        <div class="kpi"><h3>Custo parado</h3><div class="value">${fmt.moneyShort(cost)}</div><div class="foot">a custo do mês</div></div>
        <div class="kpi"><h3>Dias médios</h3><div class="value">${pieces ? fmt.int(sum(items, x => x.days * x.qty) / pieces) : "–"}</div><div class="foot">ponderado por peças</div></div>
        <div class="kpi"><h3>Item mais antigo</h3><div class="value" style="font-size:18px">${oldest ? esc(oldest.sku) : "–"}</div><div class="foot">${oldest ? fmt.int(oldest.days) + " dias sem alocação" : ""}</div></div>
        <div class="kpi"><h3>Lançamentos · próx. 3 meses</h3><div class="value">${fmt.int(upcoming)}</div><div class="foot">peças já nos CDs</div></div>
      </div>
      <div class="grid c2">
        <div class="card"><div class="card-head"><h2>Tempo sem alocação</h2></div>
          <div class="bar-list">${byBucket.map((b, i) => `<div class="bar-row"><span class="name">${b.t}</span>
            <span class="bar-track"><span style="width:${(b.qty / mxB) * 100}%;background:${ramp[i]}"></span></span><span class="val">${fmt.int(b.qty)}</span></div>`).join("")}</div>
          <p class="note">Contagem de meses seguidos com saldo no recebimento até ${D.dim_date[m].label}.</p></div>
        <div class="card"><div class="card-head"><h2>Impacto por categoria (custo)</h2></div>
          <div class="bar-list">${cats.map(([c, v]) => `<div class="bar-row"><span class="name">${esc(c)}</span>
            <span class="bar-track"><span class="bar-fill" style="width:${(v / mxC) * 100}%"></span></span><span class="val">${fmt.moneyShort(v)}</span></div>`).join("") || `<p class="empty">Nada parado.</p>`}</div>
          <p class="note">Peças recebidas e ainda não liberadas para o estoque disponível do CD.</p></div>
      </div>
      <div class="card block">
        <div class="toolbar">
          <div class="chips" id="na-status" style="margin:0">${["*", ...STATUS].map(s => `<button data-s="${esc(s)}" class="${na.status === s ? "on" : ""}">${s === "*" ? "Todos" : esc(s)}
            <small>${s === "*" ? items.length : items.filter(x => x.status === s).length}</small></button>`).join("")}</div>
          <div class="tools"><input type="search" class="field" id="na-q" placeholder="Buscar SKU, modelo, linha…" value="${esc(na.q)}">
            <button class="btn" id="na-expand">Expandir tudo</button><button class="btn" id="na-csv">Exportar CSV</button></div>
        </div>
        <div id="na-table"></div>
        <p class="note">O status é só uma anotação local (fica salvo neste navegador); os dados continuam somente leitura.</p>
      </div>`;

    const draw = () => {
      const q = na.q.toLowerCase();
      const list = items.filter(x => (na.status === "*" || x.status === na.status) && (!q || [x.sku, x.name, x.line, x.collection, x.color].join(" ").toLowerCase().includes(q)));
      const groups = new Map();
      list.forEach(x => { if (!groups.has(x.line)) groups.set(x.line, []); groups.get(x.line).push(x); });
      const g = [...groups.entries()].sort((a, b) => sum(b[1], x => x.cost) - sum(a[1], x => x.cost));
      const dayBadge = d => App.badge(d > 180 ? "bad" : d > 90 ? "warn" : "neutral", fmt.int(d) + " d");
      document.getElementById("na-table").innerHTML = `<div class="table-wrap" style="max-height:640px"><table>
        <thead><tr><th class="l">Linha / SKU</th><th></th><th class="l">Modelo</th><th class="l">Coleção</th><th>Peças</th><th>Custo</th><th>Dias</th><th>Status</th></tr></thead>
        <tbody>${g.map(([line, xs]) => {
          const open = na.open.has(line) || !!q;
          const pcs = sum(xs, x => x.qty);
          return `<tr class="group ${open ? "open" : ""}" data-g="${esc(line)}"><td class="l" colspan="4">${esc(line)} <span class="muted" style="font-weight:400">· ${xs.length} SKU(s)</span></td>
            <td>${fmt.int(pcs)}</td><td>${fmt.money(sum(xs, x => x.cost))}</td><td>${fmt.int(sum(xs, x => x.days * x.qty) / pcs)} d</td><td></td></tr>` +
            (open ? xs.sort((a, b) => b.days - a.days).map(x => `<tr class="click" data-m="${esc(x.model)}">
              <td class="l">${esc(x.sku)}<small>${esc(x.color)}</small></td><td>${App.thumb(x.p, { small: true })}</td>
              <td class="l">${esc(x.name)}<small>${esc(x.category)}</small></td><td class="l">${esc(x.collection)}</td>
              <td>${fmt.int(x.qty)}</td><td>${fmt.money(x.cost)}</td><td>${dayBadge(x.days)}</td>
              <td><select data-sku="${esc(x.sku)}" aria-label="Status">${STATUS.map(s => `<option ${s === x.status ? "selected" : ""}>${s}</option>`).join("")}</select></td></tr>`).join("") : "");
        }).join("") || `<tr><td class="empty" colspan="8">Nenhum item pendente de alocação com esses filtros.</td></tr>`}</tbody>
        ${list.length ? `<tfoot><tr class="total"><td class="l" colspan="4">Total</td><td>${fmt.int(sum(list, x => x.qty))}</td><td>${fmt.money(sum(list, x => x.cost))}</td><td></td><td></td></tr></tfoot>` : ""}
      </table></div>`;
      return list;
    };
    let current = draw();
    const tbl = document.getElementById("na-table");
    tbl.onclick = e => {
      if (e.target.closest("select")) return;
      const gr = e.target.closest("tr.group");
      if (gr) { const l = gr.dataset.g; na.open.has(l) ? na.open.delete(l) : na.open.add(l); current = draw(); return; }
      const r = e.target.closest("tr[data-m]");
      if (r) App.openProduct(r.dataset.m);
    };
    tbl.onchange = e => {
      const s = e.target.closest("select[data-sku]");
      if (!s) return;
      const saved = App.store.get(statusKey(), {}) || {};
      saved[s.dataset.sku] = s.value;
      App.store.set(statusKey(), saved);
      const it = items.find(x => x.sku === s.dataset.sku);
      if (it) it.status = s.value;
      App.toast(`Status de ${s.dataset.sku}: ${s.value}`);
    };
    let t;
    el.querySelector("#na-q").oninput = e => { clearTimeout(t); t = setTimeout(() => { na.q = e.target.value.trim(); current = draw(); }, 250); };
    el.querySelector("#na-status").onclick = e => { const b = e.target.closest("button[data-s]"); if (b) { na.status = b.dataset.s; App.render(); } };
    el.querySelector("#na-expand").onclick = e => {
      const all = na.open.size < new Set(items.map(x => x.line)).size;
      na.open = all ? new Set(items.map(x => x.line)) : new Set();
      e.target.textContent = all ? "Recolher tudo" : "Expandir tudo";
      current = draw();
    };
    el.querySelector("#na-csv").onclick = () => App.downloadCsv("pendentes_alocacao", [{ k: "line", label: "Linha" }, { k: "sku", label: "SKU" }, { k: "name", label: "Modelo" }, { k: "color", label: "Cor" },
      { k: "category", label: "Categoria" }, { k: "collection", label: "Coleção" }, { k: "qty", label: "Peças", type: "int" }, { k: "cost", label: "Custo" }, { k: "days", label: "Dias sem alocação", type: "int" }, { k: "status", label: "Status" }], current);
  }

  App.page({
    id: "pendentes", order: 6, title: "Pendente de Alocação",
    subtitle: () => `Peças recebidas no CD e ainda não liberadas para alocação · ${db().dim_date[S.ref].label}`,
    icon: '<path d="M21 8 12 3 3 8v8l9 5 9-5V8Z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
    render: renderUnallocated,
  });

  // ============================================================== VALIDAÇÃO (fact vs source)
  const vs = { tol: 0.005, metric: "sales_qty" };
  function ring(ok, total) {
    const r = 30, c = 2 * Math.PI * r, f = total ? ok / total : 0;
    return `<svg class="val-ring" viewBox="0 0 74 74" aria-hidden="true"><circle cx="37" cy="37" r="${r}" fill="none" stroke="var(--panel-3)" stroke-width="8"/>
      <circle cx="37" cy="37" r="${r}" fill="none" stroke="var(--ok)" stroke-width="8" stroke-linecap="round" stroke-dasharray="${(c * f).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 37 37)"/>
      <text x="37" y="42" text-anchor="middle" font-size="15" font-weight="600" fill="var(--ink)">${ok}/${total}</text></svg>`;
  }
  function renderValidation(el) {
    const D = db(), m = S.ref;
    const res = App.validate(m, vs.tol);
    const ignored = App.FILTERS.filter(f => !["cat", "region"].includes(f.key) && S.f[f.key].length).map(f => f.label);
    if (S.q.trim()) ignored.push("SKU");
    const metric = App.VAL_METRICS.find(v => v.k === vs.metric);
    const months = [];
    for (let mm = Math.max(0, m - 11); mm <= m; mm++) months.push(mm);
    const cats = D.meta.categories.filter(c => !S.f.cat.length || S.f.cat.includes(c));
    const matrix = months.map(mm => App.reconcile(mm, i => sku(i).category, L => L.category));
    const fmtV = v => App.fmtType(metric.type === "money2" ? "money" : metric.type, v);

    el.innerHTML = `
      <div class="grid c3">
        <div class="card"><div class="card-head"><h2>Resultado · ${D.dim_date[m].label}</h2></div>
          <div class="val-summary">${ring(res.ok, res.checks.length)}
            <div style="display:grid;gap:6px">${App.badge("ok", `${res.ok} OK`)}${App.badge("warn", `${res.warn} atenção`)}${App.badge("bad", `${res.bad} falha${res.bad === 1 ? "" : "s"}`)}</div></div>
          <p class="note">OK = diferença abaixo de 0,01% (arredondamento). Atenção = abaixo da tolerância. Falha = acima.</p></div>
        <div class="card"><div class="card-head"><h2>Tolerância</h2></div>
          ${App.seg("vs-tol", [["0.001", "0,1%"], ["0.005", "0,5%"], ["0.01", "1%"]], String(vs.tol))}
          <p class="note">Vale para as conciliações de totais. Nas verificações de qualidade: 0 linhas = OK, até 5 = atenção, mais = falha.</p></div>
        <div class="card"><div class="card-head"><h2>Origem</h2></div>
          <p class="note" style="margin-top:0">Livro-razão do sistema de origem (sintético), na granularidade <b>mês × categoria × região</b>.
          Só os filtros de categoria e região se aplicam aqui.</p>
          ${ignored.length ? `<p class="info-box">Ignorados nesta página: ${esc(ignored.join(", "))}.</p>` : ""}</div>
      </div>

      <div class="card block">
        <div class="card-head"><div><h2>Verificações</h2><p class="note">Totais da fato (modelo estrela) contra a origem, e regras de qualidade sobre todo o histórico.</p></div>
          <button class="btn" id="vs-csv">Exportar CSV</button></div>
        ${App.tableHtml([
          { k: "group", label: "Grupo" },
          { k: "name", label: "Verificação", html: c => `<b>${esc(c.name)}</b><small style="white-space:normal;max-width:420px">${esc(c.desc)}</small>` },
          { k: "fact", label: "Fato", type: "int", html: c => (c.isCount ? fmt.int(c.fact) + " linhas" : App.fmtType(c.type, c.fact)) },
          { k: "source", label: "Origem", type: "int", html: c => (c.isCount ? "–" : App.fmtType(c.type, c.source)) },
          { k: "diff", label: "Diferença", type: "int", html: c => (c.isCount ? "–" : App.fmtType(c.type, c.diff)) },
          { k: "pct", label: "Dif. %", type: "pct", html: c => (c.pct == null ? "–" : fmt.pct(c.pct, 2)) },
          { k: "status", label: "Status", html: c => App.badge(c.status) },
        ], res.checks, { maxHeight: 700 })}
      </div>

      <div class="card block">
        <div class="card-head"><div><h2>Conciliação por categoria e mês</h2><p class="note">Diferença % (fato − origem) ÷ origem. Clique numa célula para ver por região.</p></div>
          ${App.seg("vs-metric", App.VAL_METRICS.map(v => [v.k, v.label.replace(/ \(.*\)| do mês/g, "")]), vs.metric)}</div>
        <div class="table-wrap"><table class="val-matrix">
          <thead><tr><th class="l">Categoria</th>${months.map(mm => `<th>${D.dim_date[mm].label}</th>`).join("")}</tr></thead>
          <tbody>${cats.map(c => `<tr><td class="l">${esc(c)}</td>${months.map((mm, j) => {
            const x = matrix[j].get(c);
            if (!x) return `<td class="muted">–</td>`;
            const f = x.fact[vs.metric], s = x.source[vs.metric], pct = s ? (f - s) / s : f ? 1 : 0;
            const st = App.statusOf(pct, vs.tol);
            return `<td><button class="text-link" data-cell="${mm}§${esc(c)}" title="Fato ${fmtV(f)} · Origem ${fmtV(s)}">${App.badge(st, Math.abs(pct) < 0.0001 ? "0,00%" : fmt.pct(pct, 2))}</button></td>`;
          }).join("")}</tr>`).join("")}</tbody>
        </table></div>
      </div>

      <div class="card block">
        <div class="card-head"><h2>Como a validação funciona</h2></div>
        <ol class="note" style="margin:0;padding-left:18px;font-size:13px;color:var(--ink-2);line-height:1.7">
          <li>O gerador simula o fluxo (compras, recebimento, transferências, vendas, ajustes) e grava a fato e, em paralelo, os totais que a origem informaria.</li>
          <li>Algumas divergências realistas são plantadas de propósito (vendas lançadas depois do corte, reavaliação de custo, ajuste de inventário e um erro de carga).</li>
          <li>Esta página recalcula tudo no navegador e compara: soma da fato × origem, mês a mês, por categoria e região.</li>
          <li>As regras de qualidade checam a própria fato: equação de fluxo, continuidade entre meses, chaves órfãs, duplicidade do grão e saldos negativos.</li>
        </ol>
      </div>`;

    App.onSeg("vs-tol", k => { vs.tol = +k; App.render(); });
    App.onSeg("vs-metric", k => { vs.metric = k; App.render(); });
    el.querySelector("#vs-csv").onclick = () => App.downloadCsv("validacao", [{ k: "group", label: "Grupo" }, { k: "name", label: "Verificação" }, { k: "fact", label: "Fato" },
      { k: "source", label: "Origem" }, { k: "diff", label: "Diferença" }, { k: "pct", label: "Diferença %" }, { k: "status", label: "Status", csv: r => ({ ok: "OK", warn: "Atenção", bad: "Falha" }[r.status]) }], res.checks);
    el.querySelectorAll("[data-cell]").forEach(b => (b.onclick = () => {
      const [mm, c] = b.dataset.cell.split("§");
      const per = App.reconcile(+mm, i => (sku(i).category === c ? loc(i).region : "§skip"), L => (L.category === c ? L.region : "§skip"));
      per.delete("§skip");
      const rows = [...per.entries()].map(([r, x]) => {
        const f = x.fact[vs.metric], s = x.source[vs.metric];
        return { r: r === "—" ? "Em trânsito (sem região)" : r, f, s, d: f - s, p: s ? (f - s) / s : f ? 1 : 0 };
      }).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
      App.openDrawer(`${c} · ${D.dim_date[+mm].label}`, `<p class="note" style="margin-top:0">${esc(metric.label)} por região.</p>` +
        App.tableHtml([{ k: "r", label: "Região" }, { k: "f", label: "Fato", type: metric.type }, { k: "s", label: "Origem", type: metric.type }, { k: "d", label: "Diferença", type: metric.type },
          { k: "p", label: "Status", html: x => App.badge(App.statusOf(x.p, vs.tol), fmt.pct(x.p, 2)) }], rows));
    }));
  }

  App.page({
    id: "validacao", order: 7, title: "Validação",
    subtitle: () => `Fato do modelo estrela contra o sistema de origem · ${db().dim_date[S.ref].label}`,
    icon: '<path d="M12 3 4 6v6c0 4.5 3.4 8.4 8 9 4.6-.6 8-4.5 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
    render: renderValidation,
  });

  // ============================================================== EXPORTAÇÃO
  const DIMS = [
    { k: "category", label: "Categoria", of: i => sku(i).category },
    { k: "subcategory", label: "Subcategoria", of: i => sku(i).subcategory },
    { k: "line", label: "Linha", of: i => sku(i).line },
    { k: "collection", label: "Coleção", of: i => sku(i).collection },
    { k: "collection_type", label: "Tipo de coleção", of: i => sku(i).collection_type },
    { k: "price_band", label: "Faixa de preço", of: i => sku(i).price_band },
    { k: "status", label: "Status", of: i => sku(i).status },
    { k: "model", label: "Modelo", of: i => sku(i).model },
    { k: "sku", label: "SKU", of: i => sku(i).sku },
    { k: "color", label: "Cor", of: i => sku(i).color },
    { k: "region", label: "Região", of: i => loc(i).region },
    { k: "type_label", label: "Tipo de local", of: i => loc(i).type_label },
    { k: "store", label: "Local", of: i => loc(i).name },
  ];
  const MEASURES = [
    { k: "qty", label: "Peças", type: "int" }, { k: "avail", label: "Disponível", type: "int" }, { k: "reserved", label: "Reservado", type: "int" },
    { k: "blocked", label: "Bloqueado", type: "int" }, { k: "cost", label: "Custo", type: "money" }, { k: "salesM", label: "Venda mês (pç)", type: "int" },
    { k: "revM", label: "Receita mês", type: "money" }, { k: "receiptsM", label: "Recebido mês (pç)", type: "int" }, { k: "sales3", label: "Venda 3M (pç)", type: "int" },
    { k: "cogs12", label: "CMV 12M", type: "money" }, { k: "coverage", label: "Cobertura", type: "days" }, { k: "turnover", label: "Giro 12M", type: "turn" },
  ];
  const ex = { dims: ["category", "line"], measures: ["qty", "avail", "cost", "sales3", "coverage", "turnover"], q: "" };
  function renderExport(el) {
    const D = db();
    el.innerHTML = `
      <div class="card block">
        <div class="card-head"><div><h2>Monte a tabela</h2><p class="note">Escolha as dimensões (agrupamento) e as medidas. Os totais são somados por essa combinação, com os filtros globais e o mês de referência (${D.dim_date[S.ref].label}).</p></div></div>
        <h3 class="mini-title">Dimensões</h3>
        <div class="check-grid" id="ex-dims">${DIMS.map(d => `<label><input type="checkbox" value="${d.k}" ${ex.dims.includes(d.k) ? "checked" : ""}>${d.label}</label>`).join("")}</div>
        <h3 class="mini-title" style="margin-top:14px">Medidas</h3>
        <div class="check-grid" id="ex-meas">${MEASURES.map(d => `<label><input type="checkbox" value="${d.k}" ${ex.measures.includes(d.k) ? "checked" : ""}>${d.label}</label>`).join("")}</div>
      </div>
      <div class="card block">
        <div class="toolbar"><input type="search" class="field" id="ex-q" placeholder="Filtrar linhas da tabela…" value="${esc(ex.q)}">
          <div class="tools"><span class="muted" id="ex-info"></span><button class="btn dark" id="ex-csv">
            <svg class="icon" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/></svg>Baixar CSV</button></div></div>
        <div id="ex-table"></div>
      </div>`;
    let rows = [], cols = [], table = null;
    const build = () => {
      const dims = DIMS.filter(d => ex.dims.includes(d.k));
      const meas = MEASURES.filter(x => ex.measures.includes(x.k));
      const map = App.analyze(i => (dims.length ? dims.map(d => d.of(i)).join("§") : "Total"), S.ref);
      rows = [...map.entries()].filter(([, a]) => a.qty || a.salesM || a.sales3).map(([k, a]) => {
        const parts = k.split("§"), r = {};
        if (dims.length) dims.forEach((d, j) => (r[d.k] = parts[j])); else r.total = "Total";
        meas.forEach(x => (r[x.k] = a[x.k]));
        return r;
      });
      cols = [...(dims.length ? dims.map(d => ({ k: d.k, label: d.label })) : [{ k: "total", label: "Agrupamento" }]), ...meas];
      draw();
    };
    const draw = () => {
      const q = ex.q.toLowerCase();
      const list = q ? rows.filter(r => cols.some(c => !c.type && String(r[c.k]).toLowerCase().includes(q))) : rows;
      const totalRow = {};
      cols.forEach((c, j) => {
        if (j === 0) totalRow[c.k] = "Total";
        else if (["int", "money"].includes(c.type)) totalRow[c.k] = sum(list, r => r[c.k] || 0);
      });
      document.getElementById("ex-info").textContent = `${fmt.int(list.length)} linhas · ${cols.length} colunas`;
      table = App.mountTable(document.getElementById("ex-table"), { cols, rows: list, sort: ex.measures.includes("cost") ? "cost" : cols[cols.length - 1].k, pageSize: 50, total: totalRow });
    };
    el.querySelector("#ex-dims").onchange = () => { ex.dims = [...el.querySelectorAll("#ex-dims input:checked")].map(x => x.value); build(); };
    el.querySelector("#ex-meas").onchange = () => {
      ex.measures = [...el.querySelectorAll("#ex-meas input:checked")].map(x => x.value);
      if (!ex.measures.length) { ex.measures = ["qty"]; el.querySelector('#ex-meas input[value="qty"]').checked = true; }
      build();
    };
    let t;
    el.querySelector("#ex-q").oninput = e => { clearTimeout(t); t = setTimeout(() => { ex.q = e.target.value.trim(); draw(); }, 200); };
    el.querySelector("#ex-csv").onclick = () => App.downloadCsv("exportacao", cols, table ? table.rows() : rows);
    build();
  }

  App.page({
    id: "exportacao", order: 8, title: "Exportação",
    subtitle: () => `Tabela dinâmica sobre o modelo estrela com download em CSV · ${db().dim_date[S.ref].label}`,
    icon: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
    render: renderExport,
  });
})();
