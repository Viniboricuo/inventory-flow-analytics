/* Inventory Flow Analytics - analysis pages: overview, group summary, collections/themes, history. */
(function () {
  "use strict";
  const App = window.App;
  const { fmt, esc } = App;
  const S = App.state;
  const db = () => App.db;
  const F = () => App.db.fact_stock;
  const sku = i => App.db.dim_product[App.db.fact_stock.sku_key[i]];
  const loc = i => App.db.dim_store[App.db.fact_stock.store_key[i]];

  /** Card with a chart, optional "Ver tabela" toggle and header actions. */
  App.chartCard = (id, title, { note = "", legend = "", cls = "", table = "", actions = "", block = true } = {}) => `
    <div class="card ${block ? "block" : ""}" id="${id}">
      <div class="card-head"><div><h2>${title}</h2>${note ? `<p class="note">${note}</p>` : ""}</div>
        <div class="head-actions">${actions}${table ? `<button class="pill-btn" data-toggle="${id}">Ver tabela</button>` : ""}</div></div>
      ${legend}
      <div id="${id}-chart" class="chart ${cls}"><canvas id="${id}-c" role="img" aria-label="${esc(title)}"></canvas></div>
      ${table ? `<div id="${id}-table" hidden>${table}</div>` : ""}
    </div>`;
  const seg = (id, items, active) => `<div class="seg" id="${id}" role="group">${items.map(([k, t]) =>
    `<button data-k="${k}" class="${k === active ? "on" : ""}">${t}</button>`).join("")}</div>`;
  App.seg = seg;
  const onSeg = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.onclick = e => { const b = e.target.closest("button[data-k]"); if (b) fn(b.dataset.k); };
  };
  App.onSeg = onSeg;
  const monthIdx = (y, m) => db().dim_date.findIndex(d => d.year === y && d.month === m);
  const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

  // ============================================================== VISÃO GERAL
  const vg = { coverage: "band", top: "cost" };

  function highlights() {
    const m = S.ref, ag = App.agingIndex(m), D = db();
    const byCatOld = new Map();
    let oldTotal = 0;
    for (const i of App.byMonth[m]) {
      if (!App.pass(i) || ag[F().sku_key[i]] < 4 || ag[F().sku_key[i]] === 6) continue;
      const a = F().qty_on_hand[i] - F().qty_reserved[i] - F().qty_blocked[i];
      oldTotal += a;
      byCatOld.set(sku(i).category, (byCatOld.get(sku(i).category) || 0) + a);
    }
    const out = [];
    const topOld = [...byCatOld.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topOld && oldTotal) out.push({ txt: `${topOld[0]} concentra ${fmt.pct(topOld[1] / oldTotal, 0)} das peças com mais de 180 dias`, sub: `${fmt.int(oldTotal)} peças disponíveis acima de 180 dias`, go: () => { App.galleryAge = "4-5"; App.go("galeria"); } });
    const byLine = App.analyze(i => sku(i).line, m);
    const lineCov = [...byLine.entries()].filter(([, a]) => a.coverage != null && a.qty > 50).sort((a, b) => b[1].coverage - a[1].coverage)[0];
    if (lineCov) out.push({ txt: `${lineCov[0]}: ${fmt.int(lineCov[1].coverage)} dias de cobertura`, sub: `maior cobertura entre as linhas · giro ${fmt.turn(lineCov[1].turnover)}`, go: () => App.go("linhas") });
    const rec = App.analyze(i => (loc(i).type === "RECEB" ? 1 : null), m).get(1);
    if (rec && rec.qty) out.push({ txt: `${fmt.moneyShort(rec.cost)} parados no recebimento`, sub: `${fmt.int(rec.qty)} peças ainda sem alocação`, go: () => App.go("pendentes") });
    const val = App.validate(m);
    out.push(val.bad + val.warn
      ? { txt: `${val.bad + val.warn} verificação(ões) pedem revisão`, sub: `${val.ok} de ${val.checks.length} conciliadas com a origem`, go: () => App.go("validacao") }
      : { txt: "Fato conciliada com a origem", sub: `${val.checks.length} verificações OK`, go: () => App.go("validacao") });
    const byModel = App.analyze(i => sku(i).model, m);
    const topModel = [...byModel.entries()].sort((a, b) => b[1].cost - a[1].cost)[0];
    if (topModel) out.push({ txt: `${App.models.get(topModel[0]).name} lidera o custo em estoque`, sub: `${fmt.moneyShort(topModel[1].cost)} · ${fmt.int(topModel[1].qty)} peças`, go: () => App.openProduct(topModel[0]) });
    return out;
  }

  function renderOverview(el) {
    const D = db(), m = S.ref, ref = D.dim_date[m];
    const s1 = App.css("--s1"), s2 = App.css("--s2");
    const hl = highlights();

    // cost evolution: ref year vs previous year
    const y = ref.year;
    const series = App.monthly().get(1) || [];
    const costOf = (yy, mo) => { const k = monthIdx(yy, mo); return k >= 0 && k <= m ? series[k].cost : null; };
    const cur = MONTHS.map((_, i) => costOf(y, i + 1)), prev = MONTHS.map((_, i) => costOf(y - 1, i + 1));
    const costRows = MONTHS.map((mo, i) => ({ mes: mo, cur: cur[i], prev: prev[i], yoy: cur[i] != null && prev[i] ? cur[i] / prev[i] - 1 : null }));

    // composition by category
    const byCat = App.analyze(i => sku(i).category, m);
    const tot = App.total(m);
    const cats = D.meta.categories.filter(c => byCat.has(c));
    const catMonthly = App.monthly(i => sku(i).category);
    const first = Math.max(0, m - 11);
    const sparkRows = cats.map(c => {
      const s = (catMonthly.get(c) || []).slice(first, m + 1).map(x => x.cost);
      return { c, s, now: s[s.length - 1], var: s[0] ? s[s.length - 1] / s[0] - 1 : null };
    }).sort((a, b) => b.now - a.now);
    const comp = cats.map(c => { const a = byCat.get(c); return { c, pPieces: tot.qty ? a.qty / tot.qty : 0, pCost: tot.cost ? a.cost / tot.cost : 0, unit: a.qty ? a.cost / a.qty : null, qty: a.qty, cost: a.cost }; })
      .sort((a, b) => b.pCost - a.pCost);

    // aged stock (> 180 days) over 12 months
    const agedSeries = [];
    let agedNow = { c181: 0, c365: 0 };
    for (let mm = first; mm <= m; mm++) {
      const ag = App.agingIndex(mm);
      let v = 0, a181 = 0, a365 = 0;
      for (const i of App.byMonth[mm]) {
        if (!App.pass(i)) continue;
        const b = ag[F().sku_key[i]];
        if (b === 4 || b === 5) {
          const on = F().qty_on_hand[i];
          const c = on ? F().cost_value[i] * (on - F().qty_reserved[i] - F().qty_blocked[i]) / on : 0;
          v += c; if (b === 4) a181 += c; else a365 += c;
        }
      }
      agedSeries.push(v);
      if (mm === m) agedNow = { c181: a181, c365: a365 };
    }
    const agedTotal = agedNow.c181 + agedNow.c365;

    // aging matrix: category x bucket (available pieces)
    const ag = App.agingIndex(m);
    const agingMat = new Map(cats.map(c => [c, new Array(7).fill(0)]));
    for (const i of App.byMonth[m]) {
      if (!App.pass(i)) continue;
      const row = agingMat.get(sku(i).category);
      if (row) row[ag[F().sku_key[i]]] += F().qty_on_hand[i] - F().qty_reserved[i] - F().qty_blocked[i];
    }
    const preLaunch = [...agingMat.values()].reduce((a, r) => a + r[6], 0);
    const rampC = App.ramp(6);

    el.innerHTML = `
      <section class="highlights" aria-label="Destaques">${hl.map((h, i) => `<button class="highlight" data-i="${i}"><b>${esc(h.txt)}</b><span>${esc(h.sub)}</span></button>`).join("")}</section>

      ${App.chartCard("vg-cost", `Evolução do custo do estoque · ${y} x ${y - 1}`, {
        note: "Fechamento mensal a custo. Passe o mouse para ver a variação contra o ano anterior.", cls: "tall",
        legend: App.legend([[String(y), s1], [`${y - 1} (tracejado)`, s2, true]]),
        table: App.tableHtml([{ k: "mes", label: "Mês" }, { k: "cur", label: String(y), type: "money" }, { k: "prev", label: String(y - 1), type: "money" }, { k: "yoy", label: "% vs ano anterior", type: "pct" }], costRows),
      })}

      <h2 class="section-title">Composição por categoria</h2>
      <div class="comp-row">
        <div class="card">
          <div class="card-head"><h2>Acima de 180 dias</h2></div>
          <div class="stat-big">${fmt.moneyShort(agedTotal)}</div>
          <div class="note" style="margin-top:4px">${fmt.pct(tot.cost ? agedTotal / tot.cost : null)} do custo do estoque em ${ref.label} (peças disponíveis)</div>
          <div style="height:48px;margin:14px 0 6px">${App.spark(agedSeries)}</div>
          <div class="note" style="margin:0">${agedSeries[0] ? App.delta(agedTotal / agedSeries[0] - 1, true) + " em 12 meses" : ""}</div>
          <div class="stat-lines"><div><span>181–365 dias</span><b>${fmt.moneyShort(agedNow.c181)}</b></div><div><span>Mais de 365 dias</span><b>${fmt.moneyShort(agedNow.c365)}</b></div></div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Custo por categoria · 12 meses</h2><button class="pill-btn" data-toggle="vg-spark">Ver tabela</button></div>
          <div id="vg-spark-chart" class="spark-list">
            <div class="spark-head"><span>Categoria</span><span>${D.dim_date[first].label} → ${ref.label}</span><span>Atual</span><span>Variação</span></div>
            ${sparkRows.map(r => `<div class="spark-row"><span>${esc(r.c)}</span>${App.spark(r.s)}<b>${fmt.moneyShort(r.now)}</b><span>${App.delta(r.var, true)}</span></div>`).join("")}
          </div>
          <div id="vg-spark-table" hidden>${App.tableHtml([{ k: "c", label: "Categoria" }, ...D.dim_date.slice(first, m + 1).map((d, j) => ({ k: "m" + j, label: d.label, type: "moneyShort" }))],
            sparkRows.map(r => Object.assign({ c: r.c }, ...r.s.map((v, j) => ({ ["m" + j]: v })))))}</div>
        </div>
        ${App.chartCard("vg-share", `Peças x custo · ${ref.label}`, {
          block: false, cls: "short", note: "Custo maior que peças = item caro; o contrário = volume barato.",
          legend: App.legend([["% das peças", s2], ["% do custo", s1]]),
          table: App.tableHtml([{ k: "c", label: "Categoria" }, { k: "qty", label: "Peças", type: "int" }, { k: "pPieces", label: "% peças", type: "pct" }, { k: "cost", label: "Custo", type: "money" }, { k: "pCost", label: "% custo", type: "pct" }, { k: "unit", label: "Custo médio", type: "money2" }], comp),
        })}
      </div>

      ${App.chartCard("vg-aging", "Aging · peças disponíveis por tempo desde a última entrada", {
        note: "Idade = dias desde o último recebimento de compra do SKU (aproximação FIFO). Clique numa faixa para abrir esses produtos na Galeria de Produtos.", cls: "",
        legend: App.legend(App.AGING.slice(0, 6).map((a, i) => [a, rampC[i]])),
        table: App.tableHtml([{ k: "c", label: "Categoria" }, ...App.AGING.map((a, i) => ({ k: "b" + i, label: a, type: "int" }))],
          cats.map(c => Object.assign({ c }, ...agingMat.get(c).map((v, i) => ({ ["b" + i]: v }))))),
      })}

      <div class="card block" id="vg-coverage">
        <div class="card-head"><div><h2>Cobertura (dias)</h2>
          <p class="note">Estoque do mês ÷ venda média diária dos últimos 3 meses. Verde = menor, vermelho = maior.</p></div>
          ${seg("vg-cov-mode", [["band", "Faixa de preço"], ["region", "Região"], ["ctype", "Tipo de coleção"]], vg.coverage)}</div>
        <div id="vg-cov-body"></div>
      </div>

      <div class="card block" id="vg-top">
        <div class="card-head"><div><h2>Top 10 modelos</h2><p class="note">Ranking por modelo (todas as cores somadas). Clique para ver o detalhe.</p></div>
          <div class="head-actions">${seg("vg-top-mode", [["cost", "Custo em estoque"], ["rev", "Venda 3M"], ["cov", "Maior cobertura"], ["turn", "Menor giro"]], vg.top)}
          <button class="btn" id="vg-top-csv">CSV</button></div></div>
        <div id="vg-top-body" class="rank"></div>
      </div>
      <p class="note">${fmt.int(preLaunch)} peças de coleções em pré-lançamento ficam fora do aging.</p>`;

    el.querySelectorAll(".highlight").forEach(b => (b.onclick = () => hl[+b.dataset.i].go()));

    // charts
    App.chart("vg-cost-c", {
      type: "line",
      data: { labels: MONTHS, datasets: [
        { label: String(y), data: cur, borderColor: s1, backgroundColor: App.alpha(s1, 0.08), fill: true, tension: 0.3, pointRadius: 3, borderWidth: 2, fmt: fmt.money },
        { label: String(y - 1), data: prev, borderColor: s2, borderDash: [5, 4], tension: 0.3, pointRadius: 0, borderWidth: 2, fmt: fmt.money },
      ] },
      options: App.chartOptions({ fmtAxis: fmt.moneyShort, fmtVal: fmt.money, tooltip: {
        afterBody: items => { const i = items[0].dataIndex; return costRows[i].yoy == null ? "" : `vs ${y - 1}: ${costRows[i].yoy >= 0 ? "+" : ""}${fmt.pct(costRows[i].yoy)}`; } } }),
    });
    App.chart("vg-share-c", {
      type: "bar",
      data: { labels: comp.map(c => c.c), datasets: [
        { label: "% das peças", data: comp.map(c => c.pPieces), backgroundColor: s2, borderRadius: 4, fmt: v => fmt.pct(v) },
        { label: "% do custo", data: comp.map(c => c.pCost), backgroundColor: s1, borderRadius: 4, fmt: v => fmt.pct(v) },
      ] },
      options: App.chartOptions({ horizontal: true, fmtAxis: v => fmt.pct(v, 0), tooltip: { afterBody: it => `custo médio ${fmt.money2(comp[it[0].dataIndex].unit)}` } }),
    });
    const agingChart = App.chart("vg-aging-c", {
      type: "bar",
      data: { labels: cats, datasets: App.AGING.slice(0, 6).map((a, b) => ({ label: a, data: cats.map(c => agingMat.get(c)[b]), backgroundColor: rampC[b], borderRadius: 3 })) },
      options: Object.assign(App.chartOptions({ horizontal: true, stacked: true }), {
        onClick: (evt, els) => { if (!els.length) return; App.galleryAge = els[0].datasetIndex + "-" + els[0].datasetIndex; App.galleryCat = cats[els[0].index]; App.go("galeria"); },
        onHover: (evt, els) => { evt.native.target.style.cursor = els.length ? "pointer" : "default"; },
      }),
    });
    if (agingChart) agingChart.options.interaction = { mode: "nearest", intersect: true };

    drawCoverage();
    drawTop();
    onSeg("vg-cov-mode", k => { vg.coverage = k; document.querySelectorAll("#vg-cov-mode button").forEach(b => b.classList.toggle("on", b.dataset.k === k)); drawCoverage(); });
    onSeg("vg-top-mode", k => { vg.top = k; document.querySelectorAll("#vg-top-mode button").forEach(b => b.classList.toggle("on", b.dataset.k === k)); drawTop(); });
    document.getElementById("vg-top-csv").onclick = () => App.downloadCsv("top10", [{ k: "pos", label: "Posição", type: "int" }, { k: "model", label: "Modelo" }, { k: "name", label: "Nome" },
      { k: "line", label: "Linha" }, { k: "qty", label: "Peças", type: "int" }, { k: "cost", label: "Custo" }, { k: "rev3", label: "Venda 3M R$" }, { k: "coverage", label: "Cobertura dias" }, { k: "turnover", label: "Giro" }], topRows());
  }

  function drawCoverage() {
    const D = db(), m = S.ref, body = document.getElementById("vg-cov-body");
    if (!body) return;
    const colOf = { band: i => sku(i).price_band, region: i => (loc(i).region === "—" ? null : loc(i).region), ctype: i => sku(i).collection_type }[vg.coverage];
    const cols = { band: D.meta.price_bands, region: D.meta.regions, ctype: ["Permanente", "Sazonal", "Cápsula"] }[vg.coverage];
    const cells = App.analyze(i => { const c = colOf(i); return c == null ? null : sku(i).category + "§" + c; }, m);
    const rows = App.analyze(i => (colOf(i) == null ? null : sku(i).category), m);
    const colsTot = App.analyze(i => colOf(i), m);
    const all = [...cells.values()].map(a => a.coverage).filter(v => v != null && v > 0);
    const lo = Math.log(Math.min(...all, 30)), hi = Math.log(Math.max(...all, 60));
    const t = v => (v == null ? null : (Math.log(Math.max(v, 1)) - lo) / (hi - lo || 1));
    const cell = (a, isTot = false) => !a || !a.qty ? `<div class="heat-cell static" style="background:var(--panel-2);color:var(--ink-3)">–</div>`
      : `<div class="heat-cell static ${isTot ? "total" : ""}" style="${isTot ? "" : App.coverageBg(t(a.coverage))}" title="${fmt.int(a.qty)} peças · venda 3M ${fmt.int(a.sales3)}">
          <span>${a.coverage == null ? "sem venda" : a.coverage > 999 ? "> 999" : fmt.int(a.coverage)}</span><small>${fmt.short(a.qty)} pç</small></div>`;
    const cats = D.meta.categories.filter(c => rows.has(c));
    body.innerHTML = `<div class="heat" style="grid-template-columns:120px repeat(${cols.length + 1}, minmax(0,1fr))">
      <div></div>${cols.map(c => `<div class="heat-col">${esc(c)}</div>`).join("")}<div class="heat-col">Total</div>
      ${cats.map(c => `<div class="heat-rowname">${esc(c)}</div>${cols.map(k => cell(cells.get(c + "§" + k))).join("")}${cell(rows.get(c), true)}`).join("")}
      <div class="heat-rowname"><b>Total</b></div>${cols.map(k => cell(colsTot.get(k), true)).join("")}${cell(App.total(m), true)}
    </div>${vg.coverage === "region" ? `<p class="note">Por região: lojas + CD da região; em trânsito fica fora.</p>` : ""}`;
  }

  function topRows() {
    const m = S.ref;
    const by = App.analyze(i => sku(i).model, m);
    const rows = [...by.entries()].map(([model, a]) => {
      const g = App.models.get(model);
      const p = g.first;
      return { model, name: g.name, line: p.line, collection: p.collection, launch: p.launch_idx, qty: a.qty, cost: a.cost, rev3: 0, sales3: a.sales3, coverage: a.coverage, turnover: a.turnover, avgCost12: a.avgCost12 };
    });
    // revenue of the last 3 months per model
    const rev = new Map();
    for (let mm = Math.max(0, m - 2); mm <= m; mm++) for (const i of App.byMonth[mm]) {
      if (!App.pass(i)) continue;
      const k = sku(i).model;
      rev.set(k, (rev.get(k) || 0) + App.db.fact_movement.sales_value[i]);
    }
    rows.forEach(r => (r.rev3 = rev.get(r.model) || 0));
    const live = rows.filter(r => r.launch <= m && r.qty >= 10);
    let sorted;
    if (vg.top === "cost") sorted = rows.sort((a, b) => b.cost - a.cost);
    else if (vg.top === "rev") sorted = rows.sort((a, b) => b.rev3 - a.rev3);
    else if (vg.top === "cov") sorted = live.sort((a, b) => (b.coverage ?? 1e9) - (a.coverage ?? 1e9));
    else sorted = live.filter(r => r.avgCost12 > 500).sort((a, b) => (a.turnover ?? 0) - (b.turnover ?? 0));
    return sorted.slice(0, 10).map((r, i) => ({ ...r, pos: i + 1 }));
  }
  function drawTop() {
    const body = document.getElementById("vg-top-body");
    if (!body) return;
    const rows = topRows();
    const val = { cost: r => r.cost, rev: r => r.rev3, cov: r => r.coverage ?? 0, turn: r => (r.turnover ? 1 / r.turnover : 0) }[vg.top];
    const max = Math.max(1e-9, ...rows.map(val));
    const main = r => ({ cost: fmt.moneyShort(r.cost), rev: fmt.moneyShort(r.rev3), cov: fmt.days(r.coverage), turn: fmt.turn(r.turnover) }[vg.top]);
    const second = r => ({ cost: `${fmt.int(r.qty)} peças`, rev: `${fmt.int(r.sales3)} peças vendidas`, cov: `${fmt.int(r.qty)} peças · venda 3M ${fmt.int(r.sales3)}`, turn: `estoque médio ${fmt.moneyShort(r.avgCost12)}` }[vg.top]);
    body.innerHTML = rows.length ? rows.map(r => `<button class="rank-row" data-m="${esc(r.model)}">
        <span class="rank-pos">${r.pos}</span>
        <span class="rank-name"><b>${esc(r.name)}</b><span>${esc(r.model)} · ${esc(r.line)} · ${esc(r.collection)}</span></span>
        <span class="bar-track"><span class="bar-fill" style="width:${(val(r) / max) * 100}%"></span></span>
        <span class="rank-val">${main(r)}<small>${second(r)}</small></span></button>`).join("")
      : `<p class="empty">Nada para mostrar com os filtros atuais.</p>`;
    body.onclick = e => { const b = e.target.closest(".rank-row"); if (b) App.openProduct(b.dataset.m); };
  }

  App.page({
    id: "visao-geral", order: 1, title: "Visão Geral",
    subtitle: () => `Fechamento de ${db().dim_date[S.ref].label_long} · custo, aging, cobertura, giro e Top 10`,
    icon: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    render: renderOverview,
  });

  // ============================================================== MATRIZ DE FLUXO
  const rg = { metric: "qty", sel: null };
  const STAGES = [
    { k: "receb", label: "Recebimento", hint: "pendente de alocação" },
    { k: "cdav", label: "CD · disponível" },
    { k: "cdres", label: "CD · reservado" },
    { k: "cdblk", label: "CD · bloqueado", hint: "qualidade" },
    { k: "trans", label: "Em trânsito" },
    { k: "loja", label: "Lojas" },
  ];
  function stageSplit(i) {
    const t = loc(i).type, on = F().qty_on_hand[i];
    if (t === "RECEB") return [["receb", on]];
    if (t === "TRANSITO") return [["trans", on]];
    if (t === "LOJA") return [["loja", on]];
    const r = F().qty_reserved[i], b = F().qty_blocked[i];
    return [["cdav", on - r - b], ["cdres", r], ["cdblk", b]];
  }
  function renderGroups(el) {
    const D = db(), m = S.ref;
    const cats = D.meta.categories;
    const cell = new Map(); // stage§cat -> {qty, cost, byStore: Map}
    const add = (k, store, q, c) => {
      let x = cell.get(k);
      if (!x) cell.set(k, (x = { qty: 0, cost: 0, byStore: new Map() }));
      x.qty += q; x.cost += c;
      const s = x.byStore.get(store) || { qty: 0, cost: 0 };
      s.qty += q; s.cost += c;
      x.byStore.set(store, s);
    };
    for (const i of App.byMonth[m]) {
      if (!App.pass(i)) continue;
      const on = F().qty_on_hand[i];
      if (!on) continue;
      const unit = F().cost_value[i] / on, c = sku(i).category, st = F().store_key[i];
      stageSplit(i).forEach(([k, q]) => {
        if (!q) return;
        [k + "§" + c, k + "§*", "*§" + c, "*§*"].forEach(key => add(key, st, q, q * unit));
      });
    }
    const v = x => (x ? (rg.metric === "qty" ? x.qty : x.cost) : 0);
    const f = x => (rg.metric === "qty" ? fmt.int(x) : fmt.moneyShort(x));
    const max = Math.max(1, ...STAGES.flatMap(s => cats.map(c => v(cell.get(s.k + "§" + c)))));

    // available by category / region
    const byCat = App.analyze(i => sku(i).category, m);
    const byReg = App.analyze(i => (loc(i).region === "—" ? null : loc(i).region), m);
    const stores = App.analyze(i => (loc(i).type === "LOJA" ? loc(i).region : null), m);
    const storeCount = new Map();
    for (const i of App.byMonth[m]) if (App.pass(i) && loc(i).type === "LOJA" && F().qty_on_hand[i] > 0) {
      const r = loc(i).region; if (!storeCount.has(r)) storeCount.set(r, new Set()); storeCount.get(r).add(F().store_key[i]);
    }
    const availTotal = [...byCat.values()].reduce((a, x) => a + x.avail, 0);
    const s1 = App.css("--s1");

    // location x category table
    const byLocCat = App.analyze(i => F().store_key[i] + "§" + sku(i).category, m);
    const locRows = D.dim_store.map(s => {
      const r = { name: s.name, type: s.type_label, region: s.region, total: 0 };
      cats.forEach(c => { const a = byLocCat.get(s.store_key + "§" + c); r[c] = a ? a.qty : 0; r.total += r[c]; });
      return r;
    }).filter(r => r.total > 0);

    el.innerHTML = `
      <div class="card block">
        <div class="card-head"><div><h2>Estoque por etapa e categoria · ${D.dim_date[m].label}</h2>
          <p class="note">Quanto mais escuro, maior o valor. Clique numa célula para ver os locais.</p></div>
          ${seg("rg-metric", [["qty", "Peças"], ["cost", "Custo (R$)"]], rg.metric)}</div>
        <div class="heat-layout">
          <div class="heat" style="grid-template-columns:130px repeat(${cats.length + 1}, minmax(0,1fr))">
            <div></div>${cats.map(c => `<div class="heat-col">${esc(c)}</div>`).join("")}<div class="heat-col">Total</div>
            ${STAGES.map(s => `<div class="heat-rowname" title="${esc(s.hint || "")}">${esc(s.label)}</div>
              ${cats.map(c => { const x = cell.get(s.k + "§" + c), val = v(x);
                return `<button class="heat-cell" data-k="${s.k}§${esc(c)}" style="${App.heatBg(Math.sqrt(val / max))}">${val ? f(val) : "–"}</button>`; }).join("")}
              <button class="heat-cell total" data-k="${s.k}§*">${f(v(cell.get(s.k + "§*")))}</button>`).join("")}
            <div class="heat-rowname"><b>Total</b></div>${cats.map(c => `<button class="heat-cell total" data-k="*§${esc(c)}">${f(v(cell.get("*§" + c)))}</button>`).join("")}
            <button class="heat-cell total" data-k="*§*"><b>${f(v(cell.get("*§*")))}</b></button>
          </div>
          <div class="detail-pane" id="rg-detail"></div>
        </div>
        <button class="pill-btn" id="rg-tbl-btn" style="margin-top:14px">Ver tabela por local</button>
        <div id="rg-tbl" hidden style="margin-top:12px"></div>
      </div>

      <div class="grid c3">
        <div class="card"><div class="card-head"><h2>Estoque disponível</h2></div>
          <div class="big-number">${fmt.int(availTotal)}</div>
          <p class="note">Peças livres (sem reserva nem bloqueio) em todos os locais filtrados, fechamento de ${D.dim_date[m].label}.</p>
          <div class="stat-lines"><div><span>Reservado</span><b>${fmt.int([...byCat.values()].reduce((a, x) => a + x.reserved, 0))}</b></div>
            <div><span>Bloqueado (qualidade)</span><b>${fmt.int([...byCat.values()].reduce((a, x) => a + x.blocked, 0))}</b></div></div></div>
        ${App.chartCard("rg-cat", "Disponível por categoria", { block: false, cls: "short",
          table: App.tableHtml([{ k: "c", label: "Categoria" }, { k: "avail", label: "Disponível", type: "int" }], cats.filter(c => byCat.has(c)).map(c => ({ c, avail: byCat.get(c).avail }))) })}
        ${App.chartCard("rg-reg", "Disponível por região", { block: false, cls: "short", note: "Lojas + CD da região.",
          table: App.tableHtml([{ k: "r", label: "Região" }, { k: "avail", label: "Disponível", type: "int" }], D.meta.regions.filter(r => byReg.has(r)).map(r => ({ r, avail: byReg.get(r).avail }))) })}
      </div>

      <div class="card block">
        <div class="card-head"><div><h2>Lojas por região</h2><p class="note">Só estoque em loja. Cobertura = estoque ÷ venda diária 3M; giro = CMV 12M ÷ estoque médio.</p></div></div>
        ${App.tableHtml([{ k: "r", label: "Região" }, { k: "n", label: "Lojas c/ estoque", type: "int" }, { k: "qty", label: "Peças", type: "int" }, { k: "cost", label: "Custo", type: "money" },
          { k: "salesM", label: `Venda ${D.dim_date[m].label}`, type: "int" }, { k: "coverage", label: "Cobertura", type: "days" }, { k: "turnover", label: "Giro 12M", type: "turn" }],
          D.meta.regions.filter(r => stores.has(r)).map(r => ({ r, n: storeCount.get(r)?.size || 0, ...stores.get(r) })))}
      </div>`;

    const detail = key => {
      rg.sel = key;
      el.querySelectorAll(".heat-cell").forEach(b => b.classList.toggle("sel", b.dataset.k === key));
      const [st, c] = key.split("§");
      const x = cell.get(key);
      const stName = st === "*" ? "Todas as etapas" : STAGES.find(s => s.k === st).label;
      const list = x ? [...x.byStore.entries()].map(([k, a]) => ({ s: D.dim_store[k], ...a })).sort((a, b) => v(b) - v(a)) : [];
      const mx = Math.max(1, ...list.map(v));
      document.getElementById("rg-detail").innerHTML = `<h3>${esc(stName)} · ${c === "*" ? "todas as categorias" : esc(c)}</h3>
        <p>${x ? `${fmt.int(x.qty)} peças · ${fmt.moneyShort(x.cost)} em ${list.length} local(is)` : "Sem estoque."}</p>
        <div class="detail-list">${list.slice(0, 40).map(a => `<div class="detail-row"><div class="nm">${esc(a.s.name)}<span>${esc(a.s.type_label)} · ${esc(a.s.region)}</span></div>
          <div class="bar-track"><span class="bar-fill" style="width:${(v(a) / mx) * 100}%"></span></div>
          <div class="vv">${f(v(a))}<small>${rg.metric === "qty" ? fmt.moneyShort(a.cost) : fmt.int(a.qty) + " pç"}</small></div></div>`).join("")}</div>
        ${list.length > 40 ? `<p class="note">Mostrando 40 de ${list.length} locais.</p>` : ""}`;
    };
    el.querySelectorAll(".heat-cell[data-k]").forEach(b => (b.onclick = () => detail(b.dataset.k)));
    detail(rg.sel && cell.has(rg.sel) ? rg.sel : "loja§*");
    onSeg("rg-metric", k => { rg.metric = k; App.render(); });
    let tableMounted = false;
    document.getElementById("rg-tbl-btn").onclick = e => {
      const t = document.getElementById("rg-tbl");
      t.hidden = !t.hidden;
      e.target.textContent = t.hidden ? "Ver tabela por local" : "Ocultar tabela por local";
      if (!tableMounted) {
        tableMounted = true;
        App.mountTable(t, { cols: [{ k: "name", label: "Local" }, { k: "type", label: "Tipo" }, { k: "region", label: "Região" }, ...cats.map(c => ({ k: c, label: c, type: "int" })), { k: "total", label: "Total", type: "int" }],
          rows: locRows, sort: "total", pageSize: 60, total: Object.assign({ name: "Total" }, ...[...cats, "total"].map(c => ({ [c]: locRows.reduce((a, r) => a + r[c], 0) }))) });
      }
    };
    App.chart("rg-cat-c", { type: "bar", data: { labels: cats.filter(c => byCat.has(c)), datasets: [{ label: "Disponível", data: cats.filter(c => byCat.has(c)).map(c => byCat.get(c).avail), backgroundColor: s1, borderRadius: 4 }] }, options: App.chartOptions() });
    const regs = D.meta.regions.filter(r => byReg.has(r));
    App.chart("rg-reg-c", { type: "bar", data: { labels: regs, datasets: [{ label: "Disponível", data: regs.map(r => byReg.get(r).avail), backgroundColor: s1, borderRadius: 4 }] }, options: App.chartOptions({ horizontal: true }) });
  }

  App.page({
    id: "matriz-fluxo", order: 2, title: "Matriz de Fluxo",
    subtitle: () => `Onde está o estoque: etapa do fluxo × categoria, regiões e lojas · ${db().dim_date[S.ref].label}`,
    icon: '<path d="M3 3v18h18"/><path d="M7 16v-5M12 16V7M17 16v-8"/>',
    render: renderGroups,
  });

  // ============================================================== LINHAS E COLEÇÕES
  const ct = { cat: "*", rsCat: null };
  function renderCollections(el) {
    const D = db(), m = S.ref;
    const inCat = i => ct.cat === "*" || sku(i).category === ct.cat;
    const passC = i => App.pass(i) && inCat(i);
    const byCatAll = App.analyze(i => sku(i).category, m);
    const byLine = App.analyze(i => sku(i).line, m, { pass: passC });
    const lines = [...byLine.entries()].filter(([, a]) => a.qty > 0).sort((a, b) => b[1].qty - a[1].qty);
    const maxLine = Math.max(1, ...lines.map(([, a]) => a.qty));
    const totalQty = lines.reduce((a, [, x]) => a + x.qty, 0);

    // collections
    const byColl = App.analyze(i => sku(i).collection, m, { pass: passC });
    const collMeta = new Map(D.meta.collections.map(c => [c.name, c]));
    const ended = [], upcoming = [];
    byColl.forEach((a, name) => {
      const c = collMeta.get(name);
      if (!c || c.launch == null || !a.qty) return;
      if (c.launch > m) upcoming.push({ name, c, a, inMonths: c.launch - m });
      else if (c.launch + c.window <= m) ended.push({ name, c, a, since: m - (c.launch + c.window) });
    });
    ended.sort((x, y) => y.a.cost - x.a.cost);
    upcoming.sort((x, y) => x.inMonths - y.inMonths);
    const launchLabel = idx => {
      const d = D.dim_date[idx];
      if (d) return d.label;
      const last = D.dim_date[D.dim_date.length - 1];
      const mo = ((last.month - 1 + (idx - last.date_idx)) % 12) + 1, yr = last.year + Math.floor((last.month - 1 + (idx - last.date_idx)) / 12);
      return `${MONTHS[mo - 1]}/${String(yr).slice(2)}`;
    };
    const maxEnded = Math.max(1, ...ended.map(e => e.a.cost));
    const seasonCard = (e, isEnded) => {
      const lvl = isEnded ? (e.a.cost > maxEnded * 0.5 ? ["hot", "alto"] : e.a.cost > maxEnded * 0.15 ? ["warn", "médio"] : ["neutral", "baixo"]) : ["neutral", `em ${e.inMonths} ${e.inMonths > 1 ? "meses" : "mês"}`];
      return `<div class="season-card"><div class="season-top"><b>${esc(e.name)}</b><span class="badge ${lvl[0]}">${lvl[1]}</span></div>
        <div class="season-sub">${esc(e.c.type)} · ${isEnded ? `janela encerrou ${e.since ? `há ${e.since} ${e.since > 1 ? "meses" : "mês"}` : "neste mês"}` : `lançamento ${launchLabel(e.c.launch)}`}</div>
        <div class="season-num"><span>${fmt.int(e.a.qty)} <small>peças</small></span><small>${fmt.moneyShort(e.a.cost)}${isEnded ? ` · cobertura ${fmt.days(e.a.coverage)}` : " · no CD"}</small></div></div>`;
    };

    // aging by line
    const ag = App.agingIndex(m);
    const agLine = new Map();
    for (const i of App.byMonth[m]) {
      if (!passC(i)) continue;
      const l = sku(i).line;
      if (!agLine.has(l)) agLine.set(l, new Array(7).fill(0));
      agLine.get(l)[ag[F().sku_key[i]]] += F().qty_on_hand[i] - F().qty_reserved[i] - F().qty_blocked[i];
    }

    // R$ by category / subcategory
    const bySub = App.analyze(i => sku(i).category + "§" + sku(i).subcategory, m);
    const catsR = [...byCatAll.entries()].sort((a, b) => b[1].cost - a[1].cost);
    if (!ct.rsCat || !byCatAll.has(ct.rsCat)) ct.rsCat = catsR[0] && catsR[0][0];

    el.innerHTML = `
      <div class="chips" id="ct-cats"><button data-c="*" class="${ct.cat === "*" ? "on" : ""}">Todas <small>${fmt.short([...byCatAll.values()].reduce((a, x) => a + x.qty, 0))}</small></button>
        ${D.meta.categories.filter(c => byCatAll.has(c)).map(c => `<button data-c="${esc(c)}" class="${ct.cat === c ? "on" : ""}">${esc(c)} <small>${fmt.short(byCatAll.get(c).qty)}</small></button>`).join("")}</div>
      <div class="grid c2" style="align-items:start">
        <div class="card">
          <div class="card-head"><div><h2>Estoque por linha</h2><p class="note">${fmt.int(totalQty)} peças em ${lines.length} linhas. Barra clara = total; escura = disponível. Clique para ver o histórico.</p></div></div>
          <div class="bar-list">${lines.map(([name, a]) => `<div class="bar-row click" data-line="${esc(name)}" title="Giro ${fmt.turn(a.turnover)} · cobertura ${fmt.days(a.coverage)}">
            <span class="name">${esc(name)}</span>
            <span class="bar-track"><span class="bar-total" style="width:${(a.qty / maxLine) * 100}%"><span class="bar-fill" style="display:block;height:100%;width:${a.qty ? (a.avail / a.qty) * 100 : 0}%"></span></span></span>
            <span class="val">${fmt.int(a.qty)}<small>${fmt.moneyShort(a.cost)}</small></span></div>`).join("") || `<p class="empty">Sem estoque.</p>`}</div>
        </div>
        <div style="display:grid;gap:16px">
          <div class="card">
            <div class="card-head"><h2>Coleções sazonais e cápsulas</h2></div>
            <div class="season-cols">
              <div><h3 class="mini-title">Fora da janela de venda · ainda com estoque</h3><div class="season-list">${ended.map(e => seasonCard(e, true)).join("") || `<p class="empty">Nenhuma.</p>`}</div></div>
              <div><h3 class="mini-title">Próximos lançamentos</h3><div class="season-list">${upcoming.map(e => seasonCard(e, false)).join("") || `<p class="empty">Nenhum no período.</p>`}</div></div>
            </div>
          </div>
          ${App.chartCard("ct-scatter", "Cobertura x giro por linha", { block: false, cls: "short", note: "Tamanho = custo em estoque. Canto inferior direito = estoque parado.",
            table: App.tableHtml([{ k: "n", label: "Linha" }, { k: "coverage", label: "Cobertura", type: "days" }, { k: "turnover", label: "Giro", type: "turn" }, { k: "cost", label: "Custo", type: "money" }],
              lines.map(([n, a]) => ({ n, ...a }))) })}
        </div>
      </div>

      <div class="card block">
        <div class="card-head"><div><h2>Aging por linha · peças disponíveis</h2><p class="note">Cor relativa à linha: onde se concentra o estoque de cada linha.</p></div></div>
        <div class="heat" style="grid-template-columns:130px repeat(7, minmax(0,1fr))">
          <div></div>${App.AGING.map(a => `<div class="heat-col">${a}</div>`).join("")}
          ${lines.map(([name]) => { const r = agLine.get(name) || new Array(7).fill(0), mx = Math.max(1, ...r);
            return `<div class="heat-rowname">${esc(name)}</div>${r.map(v => `<div class="heat-cell static" style="${App.heatBg(v / mx)};min-height:30px">${v ? fmt.int(v) : "–"}</div>`).join("")}`; }).join("")}
        </div>
      </div>

      <div class="card block">
        <div class="card-head"><div><h2>Estoque em R$ por categoria e subcategoria</h2><p class="note">Custo do fechamento de ${D.dim_date[m].label}. Clique numa categoria para abrir as subcategorias.</p></div></div>
        <div class="two-cols">
          <div><h3 class="mini-title">Categorias</h3><div class="bar-list">${catsR.map(([c, a]) => `<div class="bar-row click" data-rs="${esc(c)}" aria-current="${c === ct.rsCat}">
            <span class="name">${esc(c)}</span><span class="bar-track"><span class="bar-fill" style="width:${(a.cost / catsR[0][1].cost) * 100}%"></span></span>
            <span class="val">${fmt.moneyShort(a.cost)}<small>${fmt.int(a.qty)} pç</small></span></div>`).join("")}</div></div>
          <div><h3 class="mini-title">Subcategorias · ${esc(ct.rsCat || "")}</h3><div class="bar-list" id="ct-subs"></div></div>
        </div>
      </div>`;

    const subs = [...bySub.entries()].filter(([k]) => k.startsWith(ct.rsCat + "§")).map(([k, a]) => [k.split("§")[1], a]).sort((a, b) => b[1].cost - a[1].cost);
    const mxs = Math.max(1, ...subs.map(([, a]) => a.cost));
    document.getElementById("ct-subs").innerHTML = subs.map(([n, a]) => `<div class="bar-row"><span class="name">${esc(n)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${(a.cost / mxs) * 100}%;opacity:.75"></span></span><span class="val">${fmt.moneyShort(a.cost)}<small>giro ${fmt.turn(a.turnover)}</small></span></div>`).join("");

    el.querySelector("#ct-cats").onclick = e => { const b = e.target.closest("button[data-c]"); if (b) { ct.cat = b.dataset.c; App.render(); } };
    el.querySelectorAll("[data-line]").forEach(r => (r.onclick = () => { App.historyLine = r.dataset.line; App.go("historico"); }));
    el.querySelectorAll("[data-rs]").forEach(r => (r.onclick = () => { ct.rsCat = r.dataset.rs; App.render(); }));

    const s1 = App.css("--s1");
    const pts = lines.filter(([, a]) => a.coverage != null);
    const maxCost = Math.max(1, ...pts.map(([, a]) => a.cost));
    App.chart("ct-scatter-c", {
      type: "bubble",
      data: { datasets: [{ label: "Linhas", data: pts.map(([n, a]) => ({ x: a.coverage, y: a.turnover, r: 4 + 14 * Math.sqrt(a.cost / maxCost), n, cost: a.cost })),
        backgroundColor: App.alpha(s1, 0.35), borderColor: s1, borderWidth: 1 }] },
      options: Object.assign(App.chartOptions(), {
        interaction: { mode: "nearest", intersect: true },
        scales: {
          x: { title: { display: true, text: "Cobertura (dias)", color: App.css("--ink-3") }, grid: { color: App.css("--grid") }, ticks: { color: App.css("--ink-3") } },
          y: { title: { display: true, text: "Giro 12M (x)", color: App.css("--ink-3") }, grid: { color: App.css("--grid") }, ticks: { color: App.css("--ink-3") }, beginAtZero: true },
        },
        plugins: { legend: { display: false }, tooltip: { backgroundColor: App.css("--panel"), titleColor: App.css("--ink"), bodyColor: App.css("--ink-2"), borderColor: App.css("--line"), borderWidth: 1,
          callbacks: { label: c => ` ${c.raw.n}: ${fmt.int(c.raw.x)} dias · ${fmt.turn(c.raw.y)} · ${fmt.moneyShort(c.raw.cost)}` } } },
      }),
    });
  }

  App.page({
    id: "linhas", order: 3, title: "Linhas e Coleções",
    subtitle: () => `Linhas, coleções sazonais, aging e estoque em R$ · ${db().dim_date[S.ref].label}`,
    icon: '<path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
    render: renderCollections,
  });

  // ============================================================== HISTÓRICO
  const hs = { metric: "cost", from: null, to: null };
  function renderHistory(el) {
    const D = db(), N = D.dim_date.length;
    if (App.historyLine !== undefined) { hs.line = App.historyLine; App.historyLine = undefined; }
    if (hs.to == null || hs.to >= N) hs.to = S.ref;
    if (hs.from == null || hs.from > hs.to) hs.from = Math.max(0, hs.to - 17);
    const passL = i => App.pass(i) && (!hs.line || sku(i).line === hs.line);
    const ser = App.monthly(() => 1, { pass: passL }).get(1) || D.dim_date.map(() => ({ qty: 0, cost: 0, sales: 0, rev: 0, cogs: 0, receipts: 0, adj: 0 }));
    const rows = [];
    for (let m = hs.from; m <= hs.to; m++) {
      const x = ser[m];
      let s3 = 0, d3 = 0, cogs = 0, cst = 0, n = 0;
      for (let k = Math.max(0, m - 2); k <= m; k++) { s3 += ser[k].sales; d3 += D.dim_date[k].days; }
      for (let k = Math.max(0, m - 11); k <= m; k++) { cogs += ser[k].cogs; cst += ser[k].cost; n++; }
      rows.push({ m, label: D.dim_date[m].label, qty: x.qty, cost: x.cost, sales: x.sales, rev: x.rev, receipts: x.receipts, adj: x.adj,
        coverage: s3 ? x.qty / (s3 / d3) : null, turnover: cst ? (cogs * 12 / n) / (cst / n) : null });
    }
    const lineSeries = App.monthly(i => sku(i).line);
    const lineList = [...lineSeries.entries()].map(([n, s]) => {
      const v = s.slice(hs.from, hs.to + 1).map(x => (hs.metric === "qty" ? x.qty : x.cost));
      return { n, v, now: v[v.length - 1], var: v[0] ? v[v.length - 1] / v[0] - 1 : null };
    }).sort((a, b) => b.now - a.now);
    const opt = sel => D.dim_date.map(d => `<option value="${d.date_idx}" ${d.date_idx === sel ? "selected" : ""}>${d.label}</option>`).join("");
    const isQty = hs.metric === "qty";
    const s1 = App.css("--s1"), s2 = App.css("--s2"), s3c = App.css("--s3");
    const tableCols = [{ k: "label", label: "Mês" }, { k: "qty", label: "Estoque (peças)", type: "int" }, { k: "cost", label: "Estoque (custo)", type: "money" },
      { k: "receipts", label: "Recebimentos", type: "int" }, { k: "sales", label: "Vendas (peças)", type: "int" }, { k: "rev", label: "Receita", type: "money" },
      { k: "coverage", label: "Cobertura", type: "days" }, { k: "turnover", label: "Giro 12M", type: "turn" }];

    el.innerHTML = `
      <div class="card block">
        <div class="toolbar" style="margin:0">
          <div class="tools">
            <select class="field" id="hs-line" aria-label="Linha"><option value="">Todas as linhas</option>${D.meta.lines.map(l => `<option ${l === hs.line ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
            <label class="muted">de <select class="field" id="hs-from">${opt(hs.from)}</select></label>
            <label class="muted">até <select class="field" id="hs-to">${opt(hs.to)}</select></label>
          </div>
          <div class="tools">${seg("hs-metric", [["cost", "Custo (R$)"], ["qty", "Peças"]], hs.metric)}
            <button class="btn" id="hs-csv">Exportar CSV</button></div>
        </div>
      </div>
      ${App.chartCard("hs-stock", `Evolução do estoque${hs.line ? " · " + esc(hs.line) : ""}`, { cls: "tall",
        note: "Barras = estoque no fechamento; linha = vendas do mês (eixo da direita).",
        legend: App.legend([[isQty ? "Estoque (peças)" : "Estoque (custo)", s1], [isQty ? "Vendas (peças)" : "Receita (R$)", s3c]]),
        table: App.tableHtml(tableCols, rows) })}
      <div class="grid c2">
        ${App.chartCard("hs-flow", "Entradas x saídas", { block: false, note: "Recebimentos de compra contra vendas, em peças.",
          legend: App.legend([["Recebimentos", s2], ["Vendas", s1]]) })}
        ${App.chartCard("hs-kpi", "Cobertura e giro", { block: false, note: "Cobertura em dias (esquerda) e giro anualizado (direita).",
          legend: App.legend([["Cobertura (dias)", s1], ["Giro 12M", s3c]]) })}
      </div>
      <div class="card block">
        <div class="card-head"><div><h2>Histórico por linha</h2><p class="note">${D.dim_date[hs.from].label} → ${D.dim_date[hs.to].label}. Clique numa linha para focar os gráficos acima.</p></div>
          ${hs.line ? `<button class="pill-btn" id="hs-clear">Mostrar todas</button>` : ""}</div>
        <div class="spark-list">
          <div class="spark-head"><span>Linha</span><span>Período</span><span>Atual</span><span>Variação</span></div>
          ${lineList.map(l => `<div class="spark-row" data-line="${esc(l.n)}" style="cursor:pointer;${l.n === hs.line ? "background:var(--panel-2);box-shadow:inset 3px 0 0 var(--s1)" : ""}">
            <span>${esc(l.n)}</span>${App.spark(l.v)}<b>${isQty ? fmt.short(l.now) : fmt.moneyShort(l.now)}</b><span>${App.delta(l.var, true)}</span></div>`).join("")}
        </div>
      </div>`;

    const set = (k, v) => { hs[k] = v; App.render(); };
    el.querySelector("#hs-line").onchange = e => set("line", e.target.value || null);
    el.querySelector("#hs-from").onchange = e => { hs.from = +e.target.value; if (hs.from > hs.to) hs.to = hs.from; App.render(); };
    el.querySelector("#hs-to").onchange = e => { hs.to = +e.target.value; if (hs.to < hs.from) hs.from = hs.to; App.render(); };
    onSeg("hs-metric", k => set("metric", k));
    el.querySelectorAll("[data-line]").forEach(r => (r.onclick = () => set("line", r.dataset.line === hs.line ? null : r.dataset.line)));
    const clr = el.querySelector("#hs-clear");
    if (clr) clr.onclick = () => set("line", null);
    el.querySelector("#hs-csv").onclick = () => App.downloadCsv("historico" + (hs.line ? "_" + hs.line.replace(/\s+/g, "-") : ""), tableCols, rows);

    const labels = rows.map(r => r.label);
    App.chart("hs-stock-c", {
      data: { labels, datasets: [
        { type: "bar", label: isQty ? "Estoque" : "Estoque (custo)", data: rows.map(r => (isQty ? r.qty : r.cost)), backgroundColor: App.alpha(s1, 0.8), borderRadius: 4, yAxisID: "y", order: 2, fmt: isQty ? fmt.int : fmt.money },
        { type: "line", label: isQty ? "Vendas" : "Receita", data: rows.map(r => (isQty ? r.sales : r.rev)), borderColor: s3c, backgroundColor: s3c, tension: 0.3, pointRadius: 2, borderWidth: 2, yAxisID: "y2", order: 1, fmt: isQty ? fmt.int : fmt.money },
      ] },
      options: App.chartOptions({ fmtAxis: isQty ? fmt.short : fmt.moneyShort, y2: isQty ? fmt.short : fmt.moneyShort }),
    });
    App.chart("hs-flow-c", {
      type: "bar",
      data: { labels, datasets: [
        { label: "Recebimentos", data: rows.map(r => r.receipts), backgroundColor: s2, borderRadius: 3 },
        { label: "Vendas", data: rows.map(r => r.sales), backgroundColor: s1, borderRadius: 3 },
      ] },
      options: App.chartOptions(),
    });
    App.chart("hs-kpi-c", {
      type: "line",
      data: { labels, datasets: [
        { label: "Cobertura", data: rows.map(r => r.coverage), borderColor: s1, tension: 0.3, pointRadius: 2, borderWidth: 2, yAxisID: "y", fmt: v => fmt.int(v) + " dias" },
        { label: "Giro 12M", data: rows.map(r => r.turnover), borderColor: s3c, tension: 0.3, pointRadius: 2, borderWidth: 2, yAxisID: "y2", fmt: fmt.turn },
      ] },
      options: App.chartOptions({ fmtAxis: v => fmt.int(v), y2: v => fmt.dec1(v) + "x" }),
    });
  }

  App.page({
    id: "historico", order: 4, title: "Histórico",
    subtitle: () => `Série mensal de estoque, fluxo, cobertura e giro · ${db().dim_date[0].label} a ${db().dim_date[db().dim_date.length - 1].label}`,
    icon: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
    render: renderHistory,
  });
})();
