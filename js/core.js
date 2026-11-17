/*
 * Inventory Flow Analytics - core: state, filters, metrics engine, UI helpers and layout.
 * Pages register themselves with App.page({...}) in the pages-*.js files.
 */
(function () {
  "use strict";
  const App = (window.App = {});

  // ================================================================ formatting
  const nf0 = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nf2 = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
  const brl2 = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const fmt = {
    int: v => (v == null || !isFinite(v) ? "–" : nf0.format(v)),
    dec1: v => (v == null || !isFinite(v) ? "–" : nf1.format(v)),
    dec2: v => (v == null || !isFinite(v) ? "–" : nf2.format(v)),
    money: v => (v == null || !isFinite(v) ? "–" : brl.format(v)),
    money2: v => (v == null || !isFinite(v) ? "–" : brl2.format(v)),
    moneyShort(v) {
      if (v == null || !isFinite(v)) return "–";
      const a = Math.abs(v);
      if (a >= 1e6) return "R$ " + nf2.format(v / 1e6) + " mi";
      if (a >= 1e3) return "R$ " + nf0.format(v / 1e3) + " mil";
      return "R$ " + nf0.format(v);
    },
    pct: (v, d = 1) => (v == null || !isFinite(v) ? "–" : (d === 2 ? nf2 : d === 0 ? nf0 : nf1).format(v * 100) + "%"),
    days: v => (v == null || !isFinite(v) ? "sem venda" : v > 999 ? "> 999 d" : nf0.format(v) + " d"),
    turn: v => (v == null || !isFinite(v) ? "–" : nf1.format(v) + "x"),
    short(v) {
      if (v == null || !isFinite(v)) return "–";
      const a = Math.abs(v);
      if (a >= 1e6) return nf1.format(v / 1e6) + " mi";
      if (a >= 1e4) return nf0.format(v / 1e3) + " mil";
      return nf0.format(v);
    },
  };
  const fmtType = (type, v) => {
    switch (type) {
      case "int": return fmt.int(v);
      case "money": return fmt.money(v);
      case "money2": return fmt.money2(v);
      case "moneyShort": return fmt.moneyShort(v);
      case "pct": return fmt.pct(v);
      case "pct2": return fmt.pct(v, 2);
      case "days": return v == null ? "–" : fmt.days(v);
      case "turn": return fmt.turn(v);
      case "dec1": return fmt.dec1(v);
      default: return v == null ? "" : esc(String(v));
    }
  };
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const delta = (v, invert = false) => {
    if (v == null || !isFinite(v)) return `<span class="delta">–</span>`;
    const up = v >= 0;
    return `<span class="delta ${up ? "up" : "down"}" style="color:var(${(up !== invert) ? "--ok" : "--bad"})">${fmt.pct(Math.abs(v))}</span>`;
  };
  Object.assign(App, { fmt, fmtType, esc, delta });

  // ================================================================ storage (best effort)
  const store = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode: ignore */ } },
  };
  App.store = store;

  // ================================================================ state
  const FILTERS = [
    { key: "cat", label: "Categoria", dim: "product", field: "category" },
    { key: "sub", label: "Subcategoria", dim: "product", field: "subcategory" },
    { key: "line", label: "Linha", dim: "product", field: "line" },
    { key: "coll", label: "Coleção", dim: "product", field: "collection" },
    { key: "band", label: "Faixa de preço", dim: "product", field: "price_band" },
    { key: "status", label: "Status do produto", dim: "product", field: "status" },
    { key: "region", label: "Região", dim: "store", field: "region" },
    { key: "ltype", label: "Tipo de local", dim: "store", field: "type_label" },
    { key: "store", label: "Local", dim: "store", field: "name" },
  ];
  const S = (App.state = { page: "visao-geral", seed: 2026, ref: 23, q: "", f: {} });
  FILTERS.forEach(f => (S.f[f.key] = []));

  // ================================================================ data + indexes
  let DB, F, M, byMonth, skuPass, storePass;
  const nMonths = () => DB.dim_date.length;
  function loadData() {
    const t0 = performance.now();
    DB = App.db = window.DemoData.generate(S.seed);
    F = DB.fact_stock; M = DB.fact_movement;
    const counts = new Array(nMonths()).fill(0);
    for (let i = 0; i < F.n; i++) counts[F.date_idx[i]]++;
    byMonth = counts.map(c => new Int32Array(c));
    const pos = new Array(nMonths()).fill(0);
    for (let i = 0; i < F.n; i++) { const m = F.date_idx[i]; byMonth[m][pos[m]++] = i; }
    App.byMonth = byMonth;
    App.models = groupModels();
    agingCache.clear();
    lastReceipt = null;
    App.genMs = Math.round(performance.now() - t0);
    if (S.ref >= nMonths()) S.ref = nMonths() - 1;
  }
  function groupModels() {
    const map = new Map();
    DB.dim_product.forEach(p => {
      let g = map.get(p.model);
      if (!g) map.set(p.model, (g = { model: p.model, name: p.model_name, first: p, skus: [] }));
      g.skus.push(p.sku_key);
    });
    return map;
  }

  // ================================================================ filters -> masks
  const valueOf = (f, row) => row[f.field];
  function computeMasks() {
    const q = S.q.trim().toLowerCase();
    skuPass = new Uint8Array(DB.dim_product.length);
    DB.dim_product.forEach((p, i) => {
      let ok = FILTERS.every(f => f.dim !== "product" || !S.f[f.key].length || S.f[f.key].includes(valueOf(f, p)));
      if (ok && q) ok = q.split(/[,;]\s*/).some(t => t && (p.sku.toLowerCase().includes(t) || p.model_name.toLowerCase().includes(t)));
      skuPass[i] = ok ? 1 : 0;
    });
    storePass = new Uint8Array(DB.dim_store.length);
    DB.dim_store.forEach((s, i) => {
      storePass[i] = FILTERS.every(f => f.dim !== "store" || !S.f[f.key].length || S.f[f.key].includes(valueOf(f, s))) ? 1 : 0;
    });
    App.skuPass = skuPass; App.storePass = storePass;
  }
  const pass = i => skuPass[F.sku_key[i]] === 1 && storePass[F.store_key[i]] === 1;
  App.pass = pass;
  App.activeFilterCount = () => FILTERS.reduce((a, f) => a + (S.f[f.key].length ? 1 : 0), 0) + (S.q.trim() ? 1 : 0);
  App.filterSummary = () => {
    const parts = FILTERS.filter(f => S.f[f.key].length).map(f => `${f.label}: ${S.f[f.key].length > 2 ? S.f[f.key].length + " itens" : S.f[f.key].join(", ")}`);
    if (S.q.trim()) parts.push(`SKU: ${S.q.trim()}`);
    return parts.join(" · ");
  };

  // ================================================================ metrics engine
  const blank = () => ({ qty: 0, avail: 0, reserved: 0, blocked: 0, cost: 0, salesM: 0, revM: 0, receiptsM: 0, tinM: 0, toutM: 0, adjM: 0,
    sales3: 0, sales12: 0, cogs12: 0, rev12: 0, cost12: 0, months: 0, days3: 0 });
  /**
   * One pass over the 12 months up to `m`. keyFn(row) -> group key (or null to skip).
   * Returns Map key -> stock at m, flows of month m, 3-month sales, 12-month COGS and average stock cost,
   * plus derived coverage (days) and turnover (annualized COGS / average stock at cost).
   */
  function analyze(keyFn, m = S.ref, opts = {}) {
    const usePass = opts.ignoreFilters ? () => true : (opts.pass || pass);
    const out = new Map();
    const first = Math.max(0, m - 11);
    let days3 = 0;
    for (let mm = Math.max(0, m - 2); mm <= m; mm++) days3 += DB.dim_date[mm].days;
    for (let mm = first; mm <= m; mm++) {
      const rows = byMonth[mm];
      for (let r = 0; r < rows.length; r++) {
        const i = rows[r];
        if (!usePass(i)) continue;
        const k = keyFn(i);
        if (k == null) continue;
        let a = out.get(k);
        if (!a) out.set(k, (a = blank()));
        a.cost12 += F.cost_value[i]; a.cogs12 += M.cogs_value[i]; a.sales12 += M.qty_sales[i]; a.rev12 += M.sales_value[i];
        if (mm >= m - 2) a.sales3 += M.qty_sales[i];
        if (mm === m) {
          const on = F.qty_on_hand[i];
          a.qty += on; a.reserved += F.qty_reserved[i]; a.blocked += F.qty_blocked[i];
          a.avail += on - F.qty_reserved[i] - F.qty_blocked[i]; a.cost += F.cost_value[i];
          a.salesM += M.qty_sales[i]; a.revM += M.sales_value[i]; a.receiptsM += M.qty_receipt[i];
          a.tinM += M.qty_transfer_in[i]; a.toutM += M.qty_transfer_out[i]; a.adjM += M.qty_adjust[i];
        }
      }
    }
    const months = m - first + 1;
    out.forEach(a => {
      a.months = months; a.days3 = days3;
      a.avgCost12 = a.cost12 / months;
      a.turnover = a.avgCost12 > 0 ? (a.cogs12 * (12 / months)) / a.avgCost12 : null;
      a.coverage = a.sales3 > 0 ? a.qty / (a.sales3 / days3) : null;
      a.unitCost = a.qty ? a.cost / a.qty : null;
    });
    return out;
  }
  const total = (m = S.ref, opts) => analyze(() => 1, m, opts).get(1) || Object.assign(blank(), { coverage: null, turnover: null, avgCost12: 0 });
  /** Monthly series (all months) of stock + flows, grouped by key. */
  function monthly(keyFn = () => 1, opts = {}) {
    const usePass = opts.pass || pass;
    const out = new Map();
    for (let mm = 0; mm < nMonths(); mm++) {
      const rows = byMonth[mm];
      for (let r = 0; r < rows.length; r++) {
        const i = rows[r];
        if (!usePass(i)) continue;
        const k = keyFn(i);
        if (k == null) continue;
        let s = out.get(k);
        if (!s) out.set(k, (s = Array.from({ length: nMonths() }, () => ({ qty: 0, cost: 0, sales: 0, rev: 0, cogs: 0, receipts: 0, adj: 0 }))));
        const x = s[mm];
        x.qty += F.qty_on_hand[i]; x.cost += F.cost_value[i]; x.sales += M.qty_sales[i]; x.rev += M.sales_value[i];
        x.cogs += M.cogs_value[i]; x.receipts += M.qty_receipt[i]; x.adj += M.qty_adjust[i];
      }
    }
    return out;
  }
  Object.assign(App, { analyze, total, monthly });

  // ---- aging (days since launch at the end of the reference month)
  const AGING = ["0–30 d", "31–60 d", "61–90 d", "91–180 d", "181–365 d", "> 365 d", "Pré-lançamento"];
  const AGING_LIMITS = [30, 60, 90, 180, 365, Infinity];
  const agingCache = new Map();
  /**
   * Aging bucket per SKU at the end of month m: days since the SKU's last purchase receipt
   * (FIFO-style proxy for the age of the stock on hand). SKUs with no receipt inside the data window
   * fall back to the launch date; SKUs not launched yet are "Pré-lançamento".
   */
  let lastReceipt = null;   // lastReceipt[m][sku] = month index of the last receipt up to m (or 255)
  function buildLastReceipt() {
    const nP = DB.dim_product.length, cur = new Uint8Array(nP).fill(255);
    lastReceipt = [];
    for (let mm = 0; mm < nMonths(); mm++) {
      for (const i of byMonth[mm]) if (M.qty_receipt[i] > 0) cur[F.sku_key[i]] = mm;
      lastReceipt.push(cur.slice());
    }
  }
  function skuAgeDays(k, m) {
    const p = DB.dim_product[k];
    const end = Date.parse(DB.dim_date[m].last_day + "T23:59:59Z");
    if (p.launch_idx > m) return -1;
    const lr = lastReceipt[m][k];
    const start = lr === 255 ? Date.parse(p.launch_date + "T00:00:00Z") : Date.parse(DB.dim_date[lr].first_day + "T00:00:00Z") + 14 * 86400000;
    return Math.max(0, (end - start) / 86400000);
  }
  function agingIndex(m = S.ref) {
    if (agingCache.has(m)) return agingCache.get(m);
    if (!lastReceipt) buildLastReceipt();
    const arr = new Uint8Array(DB.dim_product.length);
    for (let k = 0; k < arr.length; k++) {
      const days = skuAgeDays(k, m);
      arr[k] = days < 0 ? 6 : AGING_LIMITS.findIndex(l => days <= l);
    }
    agingCache.set(m, arr);
    return arr;
  }
  App.skuAgeDays = (k, m = S.ref) => { if (!lastReceipt) buildLastReceipt(); return skuAgeDays(k, m); };
  const ageDays = (p, m = S.ref) => Math.round((Date.parse(DB.dim_date[m].last_day + "T23:59:59Z") - Date.parse(p.launch_date + "T00:00:00Z")) / 86400000);
  Object.assign(App, { AGING, agingIndex, ageDays });

  // shorthand accessors for row -> dimension
  App.rowSku = i => DB.dim_product[F.sku_key[i]];
  App.rowStore = i => DB.dim_store[F.store_key[i]];
  App.monthLabel = m => DB.dim_date[m].label;

  // ================================================================ validation engine
  const VAL_METRICS = [
    { k: "stock_qty", label: "Estoque final (peças)", fact: i => F.qty_on_hand[i], type: "int" },
    { k: "stock_cost", label: "Valor do estoque (custo)", fact: i => F.cost_value[i], type: "money2" },
    { k: "sales_qty", label: "Vendas do mês (peças)", fact: i => M.qty_sales[i], type: "int" },
    { k: "sales_value", label: "Receita do mês (R$)", fact: i => M.sales_value[i], type: "money2" },
    { k: "receipt_qty", label: "Recebimentos do mês (peças)", fact: i => M.qty_receipt[i], type: "int" },
  ];
  const statusOf = (pct, tol) => (Math.abs(pct) < 0.0001 ? "ok" : Math.abs(pct) < tol ? "warn" : "bad");
  const countStatus = n => (n === 0 ? "ok" : n <= 5 ? "warn" : "bad");
  /** Pass function for validation: only category and region (the grain of the source ledger). */
  function valPass() {
    const cats = S.f.cat, regs = S.f.region;
    return i => (!cats.length || cats.includes(DB.dim_product[F.sku_key[i]].category)) &&
      (!regs.length || regs.includes(DB.dim_store[F.store_key[i]].region));
  }
  const ledgerPass = L => (!S.f.cat.length || S.f.cat.includes(L.category)) && (!S.f.region.length || S.f.region.includes(L.region));
  function reconcile(m, keyOfRow, keyOfLedger) {
    const vp = valPass();
    const res = new Map();
    const get = k => { let x = res.get(k); if (!x) res.set(k, (x = { fact: {}, source: {} })); VAL_METRICS.forEach(v => { x.fact[v.k] ??= 0; x.source[v.k] ??= 0; }); return x; };
    for (const i of byMonth[m]) {
      if (!vp(i)) continue;
      const x = get(keyOfRow(i));
      VAL_METRICS.forEach(v => (x.fact[v.k] += v.fact(i)));
    }
    DB.source_ledger.forEach(L => {
      if (L.date_idx !== m || !ledgerPass(L)) return;
      const x = get(keyOfLedger(L));
      VAL_METRICS.forEach(v => (x.source[v.k] += L[v.k]));
    });
    return res;
  }
  let valCache = null;
  function validate(m = S.ref, tol = 0.005) {
    const sig = [S.seed, m, tol, S.f.cat.join("|"), S.f.region.join("|")].join("#");
    if (valCache && valCache.sig === sig) return valCache.res;
    const checks = [];
    const tot = reconcile(m, () => 1, () => 1).get(1) || { fact: {}, source: {} };
    VAL_METRICS.forEach(v => {
      const f = tot.fact[v.k] || 0, s = tot.source[v.k] || 0;
      const diff = f - s, pct = s ? diff / s : f ? 1 : 0;
      checks.push({ group: "Conciliação com a origem", name: v.label, desc: `Soma na fato vs. total informado pelo sistema de origem em ${DB.dim_date[m].label}.`,
        fact: f, source: s, diff, pct, type: v.type, status: statusOf(pct, tol) });
    });
    // data quality over the full history (rows filtered by category/region only)
    const vp = valPass();
    let flow = 0, neg = 0, over = 0, orphan = 0, dup = 0, cont = 0;
    const seen = new Set();
    let prev = new Map();
    for (let mm = 0; mm < nMonths(); mm++) {
      const cur = new Map();
      for (const i of byMonth[mm]) {
        if (!vp(i)) continue;
        const sk = F.sku_key[i], st = F.store_key[i];
        if (sk >= DB.dim_product.length || st >= DB.dim_store.length || F.date_idx[i] >= nMonths()) orphan++;
        const key = (mm * 65536 + sk) * 256 + st;
        if (seen.has(key)) dup++; else seen.add(key);
        const on = F.qty_on_hand[i];
        if (M.qty_open[i] + M.qty_receipt[i] + M.qty_transfer_in[i] - M.qty_transfer_out[i] - M.qty_sales[i] + M.qty_adjust[i] !== on) flow++;
        if (on < 0) neg++;
        if (F.qty_reserved[i] + F.qty_blocked[i] > on) over++;
        const ck = sk * 256 + st;
        if (mm > 0 && (prev.get(ck) || 0) !== M.qty_open[i]) cont++;
        prev.delete(ck);
        cur.set(ck, on);
      }
      prev.forEach(v => { if (v !== 0) cont++; });
      prev = cur;
    }
    const q = (name, desc, n) => checks.push({ group: "Qualidade do modelo", name, desc, fact: n, source: 0, diff: n, pct: null, type: "int", status: countStatus(n), isCount: true });
    q("Equação de fluxo", "Abertura + entradas − saídas ± ajustes = fechamento, linha a linha, em todo o histórico.", flow);
    q("Continuidade entre meses", "Abertura do mês = fechamento do mês anterior para o mesmo SKU × local.", cont);
    q("Integridade referencial", "Linhas da fato com chave sem correspondência em dim_date, dim_product ou dim_store.", orphan);
    q("Unicidade do grão", "Linhas duplicadas para mês × SKU × local.", dup);
    q("Estoque negativo", "Linhas com saldo final menor que zero.", neg);
    q("Reservado + bloqueado ≤ saldo", "Quantidade comprometida maior que o saldo físico.", over);
    const res = { checks, ok: checks.filter(c => c.status === "ok").length, warn: checks.filter(c => c.status === "warn").length, bad: checks.filter(c => c.status === "bad").length };
    valCache = { sig, res };
    return res;
  }
  Object.assign(App, { VAL_METRICS, validate, reconcile, statusOf });
  App.badge = (status, text) => `<span class="badge ${status}">${esc(text ?? ({ ok: "OK", warn: "Atenção", bad: "Falha" }[status] || status))}</span>`;

  // ================================================================ colors + charts
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  function hexToRgb(h) {
    h = h.replace("#", "");
    if (h.length === 3) h = h.split("").map(c => c + c).join("");
    return [0, 2, 4].map(o => parseInt(h.slice(o, o + 2), 16));
  }
  function mix(a, b, t) {   // t = weight of a
    const A = hexToRgb(a.slice(0, 7)), B = hexToRgb(b.slice(0, 7));
    return "#" + A.map((v, i) => Math.round(v * t + B[i] * (1 - t)).toString(16).padStart(2, "0")).join("");
  }
  const alpha = (hex, a) => { const [r, g, b] = hexToRgb(hex.slice(0, 7)); return `rgba(${r},${g},${b},${a})`; };
  const ramp = n => Array.from({ length: n }, (_, i) => mix(css("--s1"), css("--panel"), 0.18 + (0.82 * i) / Math.max(1, n - 1)));
  const CAT_COLORS = () => [css("--s1"), css("--s3"), "#d08a1e", "#6a64c9", "#8a8a85"];
  Object.assign(App, { css, mix, alpha, ramp, CAT_COLORS });

  let charts = [];
  function destroyCharts() { charts.forEach(c => c.destroy()); charts = []; }
  function chart(id, cfg) {
    const el = document.getElementById(id);
    if (!el) return null;
    if (!window.Chart) {
      el.parentElement.innerHTML = `<div class="chart-off">Biblioteca de gráficos indisponível (sem internet?).<br>Use “Ver tabela”.</div>`;
      return null;
    }
    const c = new window.Chart(el, cfg);
    charts.push(c);
    return c;
  }
  function chartOptions({ horizontal = false, stacked = false, fmtVal = fmt.int, fmtAxis = fmt.short, legend = false, y2 = null, tooltip = {} } = {}) {
    const ink3 = css("--ink-3"), grid = css("--grid"), axis = css("--axis");
    const valueAxis = { stacked, beginAtZero: true, grid: { color: grid }, border: { display: false }, ticks: { color: ink3, callback: v => fmtAxis(v) } };
    const catAxis = { stacked, grid: { display: false }, border: { color: axis }, ticks: { color: ink3, autoSkip: true, maxRotation: 0 } };
    const scales = horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis };
    if (y2) scales.y2 = { position: "right", beginAtZero: true, grid: { display: false }, border: { display: false }, ticks: { color: ink3, callback: v => y2(v) } };
    return {
      indexAxis: horizontal ? "y" : "x", responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: legend, labels: { color: css("--ink-2"), boxWidth: 10, boxHeight: 10 } },
        tooltip: {
          backgroundColor: css("--panel"), titleColor: css("--ink"), bodyColor: css("--ink-2"), borderColor: css("--line"), borderWidth: 1,
          padding: 10, boxPadding: 4, usePointStyle: true,
          callbacks: { label: ctx => ` ${ctx.dataset.label}: ${(ctx.dataset.fmt || fmtVal)(ctx.parsed[horizontal ? "x" : "y"])}`, ...tooltip },
        },
      },
      scales,
    };
  }
  Object.assign(App, { chart, chartOptions, destroyCharts });
  function setChartDefaults() {
    if (!window.Chart) return;
    window.Chart.defaults.font.family = "Geist, ui-sans-serif, system-ui, sans-serif";
    window.Chart.defaults.font.size = 12;
    window.Chart.defaults.color = css("--ink-3");
  }

  // ================================================================ html helpers
  App.legend = items => `<div class="legend">${items.map(([t, c, dash]) =>
    `<span><i class="${dash ? "dash" : ""}" style="${dash ? `border-color:${c}` : `background:${c}`}"></i>${esc(t)}</span>`).join("")}</div>`;
  App.spark = (vals, color = "var(--s1)") => {
    const v = vals.map(x => (x == null || !isFinite(x) ? null : x));
    const nums = v.filter(x => x != null);
    if (nums.length < 2) return `<svg class="spark" viewBox="0 0 100 28"></svg>`;
    const min = Math.min(...nums), max = Math.max(...nums), span = max - min || 1;
    const pts = v.map((x, i) => (x == null ? null : [(i / (v.length - 1)) * 100, 25 - ((x - min) / span) * 22])).filter(Boolean);
    const last = pts[pts.length - 1];
    return `<svg class="spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
      <polyline points="${pts.map(p => p.map(n => n.toFixed(1)).join(",")).join(" ")}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
      <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.2" fill="${color}" vector-effect="non-scaling-stroke"/></svg>`;
  };
  App.heatBg = (t, varName = "--s1") => `background:color-mix(in srgb, var(${varName}) ${Math.round(8 + 72 * Math.max(0, Math.min(1, t)))}%, var(--panel-2));${t > 0.62 ? "color:#fff" : ""}`;
  App.coverageBg = t => {
    if (t == null) return "background:var(--panel-2)";
    t = Math.max(0, Math.min(1, t));
    return t < 0.5 ? `background:color-mix(in srgb, var(--cov-mid) ${Math.round(t * 200)}%, var(--cov-low))`
      : `background:color-mix(in srgb, var(--cov-high) ${Math.round((t - 0.5) * 200)}%, var(--cov-mid))`;
  };
  App.tableHtml = (cols, rows, { total = null, cls = "", maxHeight = null } = {}) => `
    <div class="table-wrap" ${maxHeight ? `style="max-height:${maxHeight}px"` : ""}><table class="${cls}">
      <thead><tr>${cols.map(c => `<th class="${c.type && c.type !== "text" ? "" : "l"}">${esc(c.label)}</th>`).join("")}</tr></thead>
      <tbody>${rows.length ? rows.map(r => `<tr>${cols.map(c => `<td class="${c.type && c.type !== "text" ? "" : "l"}">${c.html ? c.html(r) : fmtType(c.type, r[c.k])}</td>`).join("")}</tr>`).join("")
        : `<tr><td class="empty" colspan="${cols.length}">Nada para mostrar com os filtros atuais.</td></tr>`}</tbody>
      ${total ? `<tfoot><tr class="total">${cols.map(c => `<td class="${c.type && c.type !== "text" ? "" : "l"}">${total[c.k] === undefined ? "" : fmtType(c.type, total[c.k])}</td>`).join("")}</tr></tfoot>` : ""}
    </table></div>`;

  /** Interactive table: sortable headers, pagination, row click, CSV of all rows. */
  App.mountTable = (el, { cols, rows, pageSize = 50, sort = null, dir = -1, onRow = null, total = null, maxHeight = 560, rowKey = null }) => {
    const st = { sort, dir, page: 0 };
    function sorted() {
      if (!st.sort) return rows;
      const c = cols.find(x => x.k === st.sort);
      const num = c && c.type && c.type !== "text";
      return rows.slice().sort((a, b) => {
        const x = a[st.sort], y = b[st.sort];
        if (num) return ((x ?? -Infinity) - (y ?? -Infinity)) * st.dir;
        return String(x ?? "").localeCompare(String(y ?? ""), "pt-BR") * st.dir;
      });
    }
    function draw() {
      const all = sorted();
      const pages = Math.max(1, Math.ceil(all.length / pageSize));
      st.page = Math.min(st.page, pages - 1);
      const slice = all.slice(st.page * pageSize, (st.page + 1) * pageSize);
      el.innerHTML = `<div class="table-wrap"><table><thead><tr>${cols.map(c => `<th class="${c.type && c.type !== "text" ? "" : "l"}">${esc(c.label)}</th>`).join("")}</tr></thead><tbody></tbody></table></div>
        <div class="pager"><span>${fmt.int(all.length)} linhas${pages > 1 ? ` · página ${st.page + 1} de ${pages}` : ""}</span>
        ${pages > 1 ? `<div class="btns"><button class="btn" data-p="-1" ${st.page ? "" : "disabled"}>Anterior</button><button class="btn" data-p="1" ${st.page < pages - 1 ? "" : "disabled"}>Próxima</button></div>` : ""}</div>`;
      const wrap = el.querySelector(".table-wrap");
      wrap.style.maxHeight = maxHeight + "px";
      const ths = el.querySelectorAll("th");
      ths.forEach((th, ci) => {
        th.classList.add("sortable");
        if (cols[ci].k === st.sort) th.classList.add(st.dir > 0 ? "asc" : "desc");
        th.onclick = () => { if (st.sort === cols[ci].k) st.dir *= -1; else { st.sort = cols[ci].k; st.dir = cols[ci].type && cols[ci].type !== "text" ? -1 : 1; } draw(); };
      });
      const tb = el.querySelector("tbody");
      tb.innerHTML = slice.length ? slice.map((r, ri) => `<tr class="${onRow ? "click" : ""}" data-i="${ri}">${cols.map(c =>
        `<td class="${c.type && c.type !== "text" ? "" : "l"}">${c.html ? c.html(r) : fmtType(c.type, r[c.k])}</td>`).join("")}</tr>`).join("")
        : `<tr><td class="empty" colspan="${cols.length}">Nada para mostrar com os filtros atuais.</td></tr>`;
      if (total) el.querySelector("table").insertAdjacentHTML("beforeend",
        `<tfoot><tr class="total">${cols.map(c => `<td class="${c.type && c.type !== "text" ? "" : "l"}">${total[c.k] === undefined ? "" : fmtType(c.type, total[c.k])}</td>`).join("")}</tr></tfoot>`);
      if (onRow) tb.onclick = e => { const tr = e.target.closest("tr[data-i]"); if (tr && !e.target.closest("select,button,input")) onRow(slice[+tr.dataset.i]); };
      el.querySelectorAll("[data-p]").forEach(b => (b.onclick = () => { st.page += +b.dataset.p; draw(); }));
    }
    draw();
    return { redraw: draw, rows: () => sorted() };
  };

  // ================================================================ CSV (client-side)
  App.downloadCsv = (name, cols, rows) => {
    const cell = (c, v) => {
      if (v == null) return "";
      if (typeof v === "number") return c.type === "int" ? String(Math.round(v)) : String(Math.round(v * 100) / 100).replace(".", ",");
      const s = String(v);
      return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.map(c => c.label).join(";"), ...rows.map(r => cols.map(c => cell(c, c.csv ? c.csv(r) : r[c.k])).join(";"))];
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${name}_${DB.dim_date[S.ref].date_key}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    App.toast(`CSV gerado no navegador: ${fmt.int(rows.length)} linhas (separador “;”).`);
  };
  App.toast = msg => {
    document.querySelectorAll(".toast").forEach(t => t.remove());
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  };

  // ================================================================ placeholders (no product photos)
  const ICONS = {
    "Casa & Cozinha": '<path d="M5 7h11v9a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z"/><path d="M16 9h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M8 3v2M12 3v2"/>',
    Papelaria: '<rect x="5" y="3" width="13" height="18" rx="2"/><path d="M9 3v18M12 8h3M12 12h3"/>',
    Eletrônicos: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/>',
    Acessórios: '<rect x="5" y="7" width="14" height="14" rx="3"/><path d="M9 7V5a3 3 0 0 1 6 0v2M5 13h14M11 13v2h2v-2"/>',
    Esporte: '<path d="M10 3h4v3l2 3v10a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V9l2-3z"/><path d="M8 12h8M8 16h8"/>',
    Beleza: '<rect x="7" y="9" width="10" height="12" rx="2"/><path d="M10 9V6h4v3M12 3v3M12 13v4"/>',
  };
  App.thumb = (p, { small = false, tag = "" } = {}) => {
    const hue = (DB.meta.lines.indexOf(p.line) * 47) % 360;
    return `<div class="thumb ${small ? "small" : ""}" style="--tint:hsl(${hue} 45% 45%)" aria-hidden="true">
      <svg viewBox="0 0 24 24">${ICONS[p.category] || '<rect x="5" y="5" width="14" height="14" rx="3"/>'}</svg>${tag ? `<span class="tag">${tag}</span>` : ""}</div>`;
  };

  // ================================================================ drawer + product detail
  App.openDrawer = (title, html, onMount) => {
    App.closeDrawer();
    const bg = document.createElement("div");
    bg.className = "drawer-bg";
    bg.innerHTML = `<aside class="drawer" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="drawer-head"><h2>${esc(title)}</h2><button class="btn square" data-close aria-label="Fechar">✕</button></div>
      <div class="drawer-body">${html}</div></aside>`;
    bg.addEventListener("click", e => { if (e.target === bg || e.target.closest("[data-close]")) App.closeDrawer(); });
    document.body.appendChild(bg);
    if (onMount) onMount(bg.querySelector(".drawer-body"));
  };
  App.closeDrawer = () => document.querySelectorAll(".drawer-bg").forEach(d => d.remove());
  document.addEventListener("keydown", e => { if (e.key === "Escape") { App.closeDrawer(); closePop(); } });

  App.openProduct = model => {
    const g = App.models.get(model);
    if (!g) return;
    const p = g.first;
    const skuSet = new Set(g.skus);
    const own = i => skuSet.has(F.sku_key[i]);
    const byStore = analyze(i => F.store_key[i], S.ref, { pass: own });
    const bySku = analyze(i => F.sku_key[i], S.ref, { pass: own });
    const tot = analyze(() => 1, S.ref, { pass: own }).get(1) || blank();
    const hist = monthly(() => 1, { pass: own }).get(1) || [];
    const locs = [...byStore.entries()].filter(([, a]) => a.qty > 0).sort((a, b) => b[1].qty - a[1].qty);
    const maxQ = Math.max(1, ...locs.map(([, a]) => a.qty));
    const status = a => {
      if (a.coverage == null) return ["neutral", "sem venda"];
      return a.coverage < 20 ? ["bad", "ruptura próxima"] : a.coverage > 120 ? ["warn", "excesso"] : ["ok", "saudável"];
    };
    const html = `<div class="pd">
      <div class="pd-top">
        ${App.thumb(p)}
        <div>
          <div class="pd-title">${esc(g.name)}</div>
          <div class="pd-sub">${esc(p.model)} · ${esc(p.line)} · ${esc(p.collection)}</div>
          <div class="pd-price">${fmt.money2(p.unit_price)}<small>preço de venda · custo ${fmt.money2(p.unit_cost)} · ${esc(p.price_band)}</small></div>
          <dl class="pd-attrs">
            <dt>Categoria</dt><dd>${esc(p.category)} · ${esc(p.subcategory)}</dd>
            <dt>Lançamento</dt><dd>${new Date(p.launch_date + "T12:00:00").toLocaleDateString("pt-BR")} (${fmt.int(ageDays(p))} dias)</dd>
            <dt>Idade do estoque</dt><dd>${App.skuAgeDays(p.sku_key) < 0 ? "pré-lançamento" : fmt.int(App.skuAgeDays(p.sku_key)) + " dias desde a última entrada"}</dd>
            <dt>Status</dt><dd>${esc(p.status)}</dd>
            <dt>Variações</dt><dd>${g.skus.length} cor(es)</dd>
          </dl>
        </div>
      </div>
      <div class="pd-stats">
        <div class="pd-stat"><span>Peças</span><b>${fmt.int(tot.qty)}</b><small>${fmt.moneyShort(tot.cost)} a custo</small></div>
        <div class="pd-stat"><span>Disponível</span><b>${fmt.int(tot.avail)}</b><small>${fmt.int(tot.reserved + tot.blocked)} comprometidas</small></div>
        <div class="pd-stat"><span>Cobertura</span><b>${fmt.days(tot.coverage)}</b><small>venda 3M: ${fmt.int(tot.sales3)}</small></div>
        <div class="pd-stat"><span>Giro 12M</span><b>${fmt.turn(tot.turnover)}</b><small>CMV ${fmt.moneyShort(tot.cogs12)}</small></div>
      </div>
      <h3>Estoque mensal (peças) · ${DB.dim_date[0].label} → ${DB.dim_date[nMonths() - 1].label}</h3>
      <div style="height:44px">${App.spark(hist.map(x => x.qty))}</div>
      <h3>Estoque por local · ${DB.dim_date[S.ref].label}</h3>
      <div class="detail-list" style="max-height:none">${locs.length ? locs.map(([k, a]) => {
        const s = DB.dim_store[k], [cls, txt] = s.type === "LOJA" ? status(a) : ["neutral", s.type_label];
        return `<div class="loc-row"><div class="nm">${esc(s.name)}<span>${esc(s.region)} · ${esc(s.format)}</span></div>
          <div class="bar-track"><span class="bar-total" style="width:${(a.qty / maxQ) * 100}%"><span class="bar-fill" style="display:block;height:100%;width:${a.qty ? (a.avail / a.qty) * 100 : 0}%"></span></span></div>
          <div style="text-align:right"><b class="num">${fmt.int(a.qty)}</b><br>${App.badge(cls, txt)}</div></div>`;
      }).join("") : `<p class="empty">Sem estoque no mês de referência.</p>`}</div>
      <h3>Variações (cores)</h3>
      ${App.tableHtml([{ k: "sku", label: "SKU" }, { k: "color", label: "Cor" }, { k: "qty", label: "Peças", type: "int" }, { k: "avail", label: "Disponível", type: "int" },
        { k: "sales3", label: "Venda 3M", type: "int" }, { k: "coverage", label: "Cobertura", type: "days" }],
        g.skus.map(k => { const a = bySku.get(k) || blank(); const sp = DB.dim_product[k]; return { sku: sp.sku, color: sp.color, ...a }; }))}
      <p class="note">O detalhe mostra todos os locais, sem os filtros da página. Imagem: ícone genérico da categoria (o projeto não usa fotos).</p>
    </div>`;
    App.openDrawer(g.name, html);
  };

  // ================================================================ pages + router
  const PAGES = [];
  App.page = def => { PAGES.push(def); PAGES.sort((a, b) => a.order - b.order); };
  function readHash() {
    const h = location.hash.replace(/^#\/?/, "");   // URLSearchParams decodes the query itself ("&" inside values stays safe)
    const [page, query] = h.split("?");
    const params = new URLSearchParams(query || "");
    S.page = PAGES.some(p => p.id === page) ? page : "visao-geral";
    FILTERS.forEach(f => (S.f[f.key] = params.get(f.key) ? params.get(f.key).split("|") : []));
    S.q = params.get("q") || "";
    const seed = parseInt(params.get("seed"), 10);
    const ref = parseInt(params.get("ref"), 10);
    return { seed: isFinite(seed) ? seed : 2026, ref: isFinite(ref) ? ref : null };
  }
  function hashFor(page = S.page) {
    const p = new URLSearchParams();
    FILTERS.forEach(f => S.f[f.key].length && p.set(f.key, S.f[f.key].join("|")));
    if (S.q.trim()) p.set("q", S.q.trim());
    if (S.seed !== 2026) p.set("seed", S.seed);
    if (DB && S.ref !== nMonths() - 1) p.set("ref", S.ref);
    const qs = p.toString();
    return "#/" + page + (qs ? "?" + qs : "");
  }
  const syncHash = () => history.replaceState(null, "", hashFor());
  App.go = (page, opts = {}) => {
    if (opts.filters) Object.entries(opts.filters).forEach(([k, v]) => (S.f[k] = v));
    if (opts.filters) computeMasks();
    if (page === S.page) { syncHash(); render(); window.scrollTo({ top: 0 }); return; }
    location.hash = hashFor(page);
  };
  App.refresh = () => { computeMasks(); syncHash(); renderChrome(); render(); };

  function onHash() {
    const { seed, ref } = readHash();
    if (!DB || seed !== S.seed) { S.seed = seed; loadData(); }
    S.ref = ref == null || ref >= nMonths() || ref < 0 ? nMonths() - 1 : ref;
    computeMasks();
    renderChrome();
    render();
    window.scrollTo({ top: 0 });
  }

  // ---- layout pieces
  function renderNav() {
    const val = validate(S.ref);
    const issues = val.warn + val.bad;
    document.getElementById("nav").innerHTML = `<div class="nav-module">
      <div class="nav-head"><i class="dot" aria-hidden="true"></i><span>Estoque Central</span></div>
      ${PAGES.map(p => `<a href="${hashFor(p.id)}" data-page="${p.id}" class="${p.id === S.page ? "active" : ""}" title="${esc(p.title)}">
        <svg class="icon" viewBox="0 0 24 24">${p.icon}</svg><span>${esc(p.title)}</span>
        ${p.id === "validacao" && issues ? `<em class="nav-badge" title="Verificações com atenção ou falha">${issues}</em>` : ""}</a>`).join("")}
    </div>`;
  }
  function renderStatus() {
    document.getElementById("data-status").innerHTML = `<b><i class="ok-dot" aria-hidden="true"></i>Dados sintéticos · semente ${S.seed}</b>
      <span>${fmt.int(F.n)} linhas na fato · gerado em ${App.genMs} ms</span><span>Fechamento ${DB.dim_date[nMonths() - 1].label}</span>`;
  }
  function renderRefMonth() {
    const sel = document.getElementById("ref-month");
    sel.innerHTML = DB.dim_date.slice().reverse().map(d => `<option value="${d.date_idx}">${d.label_long.replace(/^./, c => c.toUpperCase())}</option>`).join("");
    sel.value = S.ref;
    sel.onchange = () => { S.ref = +sel.value; syncHash(); renderChrome(); render(); };
  }
  function renderQuick() {
    const el = document.getElementById("quick");
    const cats = DB.meta.categories;
    const lt = [["Lojas", "Loja"], ["CDs", "Centro de distribuição"]];
    el.innerHTML = cats.map(c => `<button class="quick-chip ${S.f.cat.includes(c) ? "on" : ""}" data-k="cat" data-v="${esc(c)}">${esc(c)}</button>`).join("") +
      `<span class="quick-sep"></span>` +
      lt.map(([t, v]) => `<button class="quick-chip ${S.f.ltype.includes(v) ? "on" : ""}" data-k="ltype" data-v="${esc(v)}">${t}</button>`).join("");
    el.onclick = e => {
      const b = e.target.closest(".quick-chip");
      if (!b) return;
      const arr = S.f[b.dataset.k], v = b.dataset.v;
      S.f[b.dataset.k] = arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v];
      App.refresh();
    };
    const n = App.activeFilterCount();
    document.getElementById("btn-filters").innerHTML = `<svg class="icon" viewBox="0 0 24 24"><path d="M3 5h18M6 12h12M10 19h4"/></svg><span>Filtros</span>${n ? `<span class="count">${n}</span>` : ""}`;
  }

  // ---- filter panel with multi-select popovers (options cascade from the other filters)
  let openPop = null, draft = null;
  function optionsFor(f) {
    const counts = new Map();
    const others = FILTERS.filter(o => o.dim === f.dim && o.key !== f.key);
    const rows = f.dim === "product" ? DB.dim_product : DB.dim_store;
    rows.forEach(r => {
      if (others.some(o => S.f[o.key].length && !S.f[o.key].includes(r[o.field]))) return;
      counts.set(r[f.field], (counts.get(r[f.field]) || 0) + 1);
    });
    S.f[f.key].forEach(v => counts.has(v) || counts.set(v, 0));
    return [...counts.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]), "pt-BR"));
  }
  function renderFilterPanel() {
    const panel = document.getElementById("filter-panel");
    panel.innerHTML = `<div class="fp-head"><b>Filtros</b><span>Valem para todas as páginas e ficam no link (dá para compartilhar).</span>
        <button class="fp-close" data-a="close" aria-label="Fechar">✕</button></div>
      <div class="fp-grid">
        ${FILTERS.map(f => {
          const v = S.f[f.key];
          return `<div class="fsel ${v.length ? "on" : ""}" data-k="${f.key}"><button type="button"><span><span class="lbl">${esc(f.label)}</span>
            <span class="val">${v.length ? esc(v.length > 2 ? v.length + " selecionados" : v.join(", ")) : "Todos"}</span></span><span class="caret">▼</span></button></div>`;
        }).join("")}
        <div class="fsel ${S.q.trim() ? "on" : ""}"><button type="button" style="cursor:text"><span style="width:100%"><span class="lbl">SKU ou modelo</span>
          <input id="f-q" class="val" style="border:0;background:transparent;outline:none;width:100%;padding:0" placeholder="ex.: CAS-AUR, Caneca" value="${esc(S.q)}"></span></button></div>
      </div>
      <div class="fp-foot"><button class="btn" data-a="clear">Limpar filtros</button><button class="btn dark" data-a="close">Concluir</button></div>`;
    panel.querySelectorAll(".fsel[data-k] > button").forEach(b => (b.onclick = e => { e.stopPropagation(); togglePop(b.parentElement); }));
    let t;
    panel.querySelector("#f-q").oninput = e => { clearTimeout(t); t = setTimeout(() => { S.q = e.target.value; App.refresh(); }, 300); };
    panel.querySelectorAll("[data-a]").forEach(b => (b.onclick = () => {
      if (b.dataset.a === "clear") { FILTERS.forEach(f => (S.f[f.key] = [])); S.q = ""; App.refresh(); renderFilterPanel(); }
      else showPanel(false);
    }));
  }
  function togglePop(box) {
    if (openPop && openPop.box === box) return closePop(true);
    closePop(true);
    const f = FILTERS.find(x => x.key === box.dataset.k);
    draft = new Set(S.f[f.key]);
    const pop = document.createElement("div");
    pop.className = "pop";
    pop.innerHTML = `<input type="search" placeholder="Buscar ${esc(f.label.toLowerCase())}…"><div class="opts"></div>
      <div class="pop-foot"><button data-a="none">Limpar</button><button class="go" data-a="ok">Aplicar</button></div>`;
    const opts = optionsFor(f);
    const list = pop.querySelector(".opts");
    const draw = term => {
      const t = term.toLowerCase();
      list.innerHTML = opts.filter(([v]) => String(v).toLowerCase().includes(t)).map(([v, n]) =>
        `<label><input type="checkbox" value="${esc(v)}" ${draft.has(v) ? "checked" : ""}>${esc(v)}<small>${n}</small></label>`).join("") || `<p class="empty">Nenhuma opção.</p>`;
    };
    draw("");
    pop.querySelector("input[type=search]").oninput = e => draw(e.target.value);
    list.onchange = e => { if (e.target.checked) draft.add(e.target.value); else draft.delete(e.target.value); };
    pop.querySelector("[data-a=none]").onclick = () => { draft.clear(); draw(pop.querySelector("input[type=search]").value); };
    pop.querySelector("[data-a=ok]").onclick = () => closePop(true);
    pop.addEventListener("click", e => e.stopPropagation());
    box.appendChild(pop);
    openPop = { box, f, pop };
    pop.querySelector("input[type=search]").focus();
  }
  function closePop(apply) {
    if (!openPop) return;
    const { f, pop } = openPop;
    pop.remove();
    openPop = null;
    if (apply && draft) {
      const next = [...draft];
      const changed = next.length !== S.f[f.key].length || next.some(v => !S.f[f.key].includes(v));
      if (changed) { S.f[f.key] = next; App.refresh(); renderFilterPanel(); }
    }
    draft = null;
  }
  function showPanel(show) {
    const panel = document.getElementById("filter-panel");
    if (show) renderFilterPanel(); else closePop(true);
    panel.hidden = !show;
    document.getElementById("btn-filters").setAttribute("aria-expanded", String(show));
  }
  document.addEventListener("click", e => {
    if (openPop && !openPop.box.contains(e.target)) closePop(true);
    const panel = document.getElementById("filter-panel");
    if (panel && !panel.hidden && !panel.contains(e.target) && !e.target.closest("#btn-filters")) showPanel(false);
  });

  // ---- KPI strip (shared by every page)
  function renderKpis() {
    const m = S.ref, d = DB.dim_date[m];
    const t = total(m);
    const prev = m > 0 ? total(m - 1) : null, yoy = m >= 12 ? total(m - 12) : null;
    const byType = analyze(i => (DB.dim_store[F.store_key[i]].type === "LOJA" ? "L" : "C"), m);
    const lojas = byType.get("L"), cds = byType.get("C");
    const ag = agingIndex(m);
    let over90 = 0, totalAvail = 0, pre = 0;
    for (const i of byMonth[m]) {
      if (!pass(i)) continue;
      const a = F.qty_on_hand[i] - F.qty_reserved[i] - F.qty_blocked[i];
      const b = ag[F.sku_key[i]];
      if (b === 6) { pre += F.qty_on_hand[i]; continue; }
      totalAvail += a;
      if (b >= 3) over90 += a;
    }
    const val = validate(m);
    const nChecks = val.checks.length;
    document.getElementById("kpis").innerHTML = `
      <button class="kpi" data-go="historico" title="Ver a evolução no Histórico"><h3>Custo do estoque · ${d.label}</h3>
        <div class="value">${fmt.moneyShort(t.cost)}</div>
        <div class="foot">${prev ? delta(prev.cost ? t.cost / prev.cost - 1 : null, true) + " vs mês anterior" : ""}${yoy ? `<br>${delta(yoy.cost ? t.cost / yoy.cost - 1 : null, true)} vs ${DB.dim_date[m - 12].label}` : ""}</div></button>
      <button class="kpi" data-go="visao-geral" data-anchor="vg-coverage" title="Ver cobertura por categoria"><h3>Cobertura · dias</h3>
        <div class="value">${t.coverage == null ? "–" : fmt.int(t.coverage)} <small>dias</small></div>
        <div class="rows"><div><span>Lojas</span><b>${fmt.days(lojas && lojas.coverage)}</b></div><div><span>CDs (vs. venda da rede)</span><b>${cds && t.sales3 ? fmt.days(cds.qty / (t.sales3 / t.days3)) : "–"}</b></div></div></button>
      <button class="kpi" data-go="colecoes" title="Ver giro por linha"><h3>Giro · 12 meses</h3>
        <div class="value">${fmt.turn(t.turnover)}</div>
        <div class="foot">CMV ${fmt.moneyShort(t.cogs12 * (12 / t.months))} ÷ estoque médio ${fmt.moneyShort(t.avgCost12)}</div></button>
      <button class="kpi" data-go="base-foto" data-age="3" title="Ver produtos acima de 90 dias"><h3>Acima de 90 dias · disponível</h3>
        <div class="value">${fmt.pct(totalAvail ? over90 / totalAvail : null, 0)}</div>
        <div class="meter"><div style="width:${totalAvail ? (over90 / totalAvail) * 100 : 0}%"></div></div>
        <div class="foot">${fmt.int(over90)} peças · ${fmt.int(pre)} em pré-lançamento</div></button>
      <button class="kpi" data-go="validacao" title="Abrir a validação contra a origem"><h3>Validação · origem</h3>
        <div class="value">${val.ok}<small> / ${nChecks} OK</small></div>
        <div class="foot">${val.bad ? App.badge("bad", val.bad + " falha" + (val.bad > 1 ? "s" : "")) + " " : ""}${val.warn ? App.badge("warn", val.warn + " atenção") : ""}${!val.bad && !val.warn ? App.badge("ok", "tudo conciliado") : ""}</div></button>`;
    document.querySelectorAll("#kpis [data-go]").forEach(b => (b.onclick = () => {
      if (b.dataset.age) App.galleryAge = "3-5";
      App.pendingAnchor = b.dataset.anchor || null;
      App.go(b.dataset.go);
    }));
  }

  function renderChrome() {
    renderNav(); renderQuick(); renderStatus(); renderKpis();
    const sel = document.getElementById("ref-month");
    if (sel.options.length !== nMonths()) renderRefMonth();
    sel.value = S.ref;
  }
  function render() {
    destroyCharts();
    setChartDefaults();
    App.closeDrawer();
    const page = PAGES.find(p => p.id === S.page) || PAGES[0];
    document.title = `${page.title} · Fluxo de Estoque · ${DB.meta.brand}`;
    document.getElementById("page-title").textContent = page.title;
    const sum = App.filterSummary();
    document.getElementById("page-subtitle").textContent = (typeof page.subtitle === "function" ? page.subtitle() : page.subtitle) + (sum ? ` · Filtros: ${sum}` : "");
    document.querySelectorAll("#nav a").forEach(a => a.classList.toggle("active", a.dataset.page === page.id));
    const el = document.getElementById("content");
    el.innerHTML = "";
    page.render(el);
    if (App.pendingAnchor) {
      const target = document.getElementById(App.pendingAnchor);
      App.pendingAnchor = null;
      if (target) setTimeout(() => target.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    }
  }
  App.render = render;
  App.rerenderKpis = renderKpis;

  // "Ver tabela" toggles: <button class="pill-btn" data-toggle="id"> swaps #id-chart and #id-table
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-toggle]");
    if (!b) return;
    const c = document.getElementById(b.dataset.toggle + "-chart"), t = document.getElementById(b.dataset.toggle + "-table");
    if (!c || !t) return;
    const showTable = t.hidden;
    t.hidden = !showTable; c.hidden = showTable;
    b.textContent = showTable ? "Ver gráfico" : "Ver tabela";
  });

  // ================================================================ boot
  function applyCollapsed(c) {
    document.getElementById("shell").classList.toggle("collapsed", c);
    const b = document.getElementById("btn-collapse");
    b.setAttribute("aria-expanded", String(!c));
    b.title = c ? "Expandir menu" : "Recolher menu";
  }
  function boot() {
    App.FILTERS = FILTERS;
    applyCollapsed(!!store.get("ifa-collapsed", false));
    document.getElementById("btn-collapse").onclick = () => {
      const c = !document.getElementById("shell").classList.contains("collapsed");
      applyCollapsed(c); store.set("ifa-collapsed", c);
      setTimeout(() => charts.forEach(ch => ch.resize()), 220);
    };
    document.getElementById("btn-theme").onclick = () => {
      const dark = css("--bg").toLowerCase() === "#0c0c0d";
      const next = dark ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem("ifa-theme", next); } catch (e) { /* ignore */ }
      render();
    };
    document.getElementById("btn-seed").onclick = () => {
      S.seed = S.seed === 2026 ? 7 : S.seed + 1;
      loadData();
      S.ref = nMonths() - 1;
      location.hash = hashFor();
      App.toast(`Novo conjunto sintético gerado (semente ${S.seed}). A semente 2026 é a padrão.`);
    };
    document.getElementById("btn-filters").onclick = e => {
      e.stopPropagation();
      showPanel(document.getElementById("filter-panel").hidden);
    };
    window.addEventListener("hashchange", onHash);
    if (window.matchMedia) window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => render());
    onHash();
  }
  document.addEventListener("DOMContentLoaded", boot);
})();
