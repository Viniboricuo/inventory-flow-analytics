/*
 * Demo Retail Co. - synthetic, deterministic data generator.
 *
 * Builds an inventory star schema in memory:
 *   dim_date, dim_product, dim_store   (dimensions, arrays of objects)
 *   fact_stock, fact_movement          (facts, column store: one typed array per column)
 *   source_ledger                      (what the "source system" reports, used by the validation page)
 *
 * Both facts share the same grain (month x SKU x location), so their rows are aligned:
 * row i of fact_stock and row i of fact_movement describe the same key. The key columns
 * (date_idx, sku_key, store_key) are shared by reference.
 *
 * Everything comes from a seeded PRNG: the same seed always yields the same data.
 * All names (brand, lines, stores, collections) are invented.
 */
(function (root) {
  "use strict";

  // ------------------------------------------------------------------ seeded random
  function makeRandom(seed) {
    let state = (seed >>> 0) || 1;
    function next() {
      // xorshift32 followed by a multiply-mix step
      state ^= state << 13; state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5; state >>>= 0;
      let z = Math.imul(state ^ (state >>> 16), 0x45d9f3b) >>> 0;
      z = Math.imul(z ^ (z >>> 16), 0x45d9f3b) >>> 0;
      return ((z ^ (z >>> 16)) >>> 0) / 4294967296;
    }
    const r = {
      next,
      between: (a, b) => a + (b - a) * next(),
      int: (a, b) => a + Math.floor(next() * (b - a + 1)),
      pick: list => list[Math.floor(next() * list.length)],
      chance: p => next() < p,
      gauss() {
        let u = next();
        while (u <= 1e-12) u = next();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
      },
    };
    r.lognormal = sigma => Math.exp(r.gauss() * sigma - (sigma * sigma) / 2);
    // integer draw around a mean, with random rounding so small means still produce sales
    r.count = (mean, sigma = 0.3) => (mean <= 0 ? 0 : Math.max(0, Math.floor(mean * r.lognormal(sigma) + next())));
    r.sample = (list, k) => {
      const copy = list.slice();
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy.slice(0, k);
    };
    return r;
  }

  // ------------------------------------------------------------------ fixed vocabulary (all invented)
  const BRAND = "Demo Retail Co.";
  const START_YEAR = 2024, START_MONTH = 11, N_MONTHS = 24;   // nov/2024 .. out/2026
  const MONTH_SHORT = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  const MONTH_LONG = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  // seasonality by calendar month (jan..dec): mother's day, winter, black friday, christmas
  const SEASON = [0.86, 0.8, 0.9, 0.92, 1.16, 1.04, 0.96, 1.0, 0.94, 1.0, 1.22, 1.52];

  const CATEGORIES = [
    // subs: [name, min unit cost, max unit cost] in R$
    { key: "CAS", name: "Casa & Cozinha", subs: [["Garrafa térmica", 22, 60], ["Caneca", 7, 20], ["Pote hermético", 5, 18], ["Jogo de talheres", 18, 55]], demand: 1.2 },
    { key: "PAP", name: "Papelaria", subs: [["Caderno", 6, 22], ["Caneta", 1.5, 8], ["Agenda", 10, 30], ["Estojo", 6, 20]], demand: 1.8 },
    { key: "ELE", name: "Eletrônicos", subs: [["Fone de ouvido", 25, 140], ["Carregador", 12, 45], ["Caixa de som", 40, 180], ["Power bank", 30, 90]], demand: 0.8 },
    { key: "ACE", name: "Acessórios", subs: [["Mochila", 35, 120], ["Relógio", 40, 160], ["Carteira", 15, 60], ["Boné", 10, 30]], demand: 0.9 },
    { key: "ESP", name: "Esporte", subs: [["Squeeze", 6, 20], ["Toalha", 10, 35], ["Tapete de yoga", 25, 80], ["Corda de pular", 6, 22]], demand: 1.1 },
    { key: "BEL", name: "Beleza", subs: [["Hidratante", 8, 30], ["Perfume", 35, 120], ["Sabonete líquido", 5, 16], ["Protetor labial", 3, 10]], demand: 1.4 },
  ];

  const LINES = [
    ["Aurora", 1.25, ["CAS", "BEL", "ACE"]], ["Boreal", 1.1, ["ESP", "ELE"]], ["Cítrica", 0.85, ["PAP", "BEL", "CAS"]],
    ["Duna", 1.0, ["ESP", "ACE"]], ["Eclipse", 1.4, ["ELE", "ACE", "BEL"]], ["Fjord", 1.15, ["CAS", "ESP"]],
    ["Granito", 0.95, ["ELE", "CAS"]], ["Horizonte", 1.0, ["PAP", "ACE"]], ["Íris", 0.9, ["BEL", "PAP"]],
    ["Jade", 1.2, ["CAS", "BEL"]], ["Lume", 0.8, ["PAP", "ESP", "CAS"]], ["Maré", 1.05, ["ESP", "ACE"]],
    ["Nimbus", 0.9, ["ELE", "PAP"]], ["Opala", 1.3, ["BEL", "ACE"]],
  ].map(([name, tier, cats], i) => ({
    idx: i, name: "Linha " + name, short: name,
    code: name.normalize("NFD").replace(/[̀-ͯ]/g, "").slice(0, 3).toUpperCase(), tier, cats,
  }));

  const COLORS = ["Preto", "Caramelo", "Off-white", "Verde-oliva", "Azul-petróleo", "Vinho", "Areia", "Grafite", "Rosé", "Mostarda", "Prata", "Dourado"];

  // launch = month index relative to nov/2024 (0); window = months of full-price selling
  const COLLECTIONS = [
    { name: "Essenciais", type: "Permanente", launch: null, window: null, models: 38, breadth: [0.65, 1] },
    { name: "Inverno 2024", type: "Sazonal", launch: -6, window: 4, models: 7, breadth: [0.4, 0.75] },
    { name: "Primavera 2024", type: "Sazonal", launch: -3, window: 4, models: 7, breadth: [0.4, 0.75] },
    { name: "Verão 2025", type: "Sazonal", launch: 0, window: 5, models: 11, breadth: [0.45, 0.8] },
    { name: "Outono 2025", type: "Sazonal", launch: 4, window: 4, models: 9, breadth: [0.4, 0.75] },
    { name: "Inverno 2025", type: "Sazonal", launch: 6, window: 4, models: 10, breadth: [0.4, 0.8] },
    { name: "Primavera 2025", type: "Sazonal", launch: 9, window: 4, models: 9, breadth: [0.4, 0.75] },
    { name: "Cápsula Neon", type: "Cápsula", launch: 10, window: 3, models: 6, breadth: [0.2, 0.45] },
    { name: "Verão 2026", type: "Sazonal", launch: 12, window: 5, models: 12, breadth: [0.45, 0.85] },
    { name: "Cápsula Oceano", type: "Cápsula", launch: 14, window: 3, models: 6, breadth: [0.2, 0.45] },
    { name: "Outono 2026", type: "Sazonal", launch: 16, window: 4, models: 10, breadth: [0.4, 0.8] },
    { name: "Inverno 2026", type: "Sazonal", launch: 18, window: 4, models: 11, breadth: [0.4, 0.8] },
    { name: "Primavera 2026", type: "Sazonal", launch: 21, window: 4, models: 11, breadth: [0.45, 0.85] },
    { name: "Cápsula Festas", type: "Cápsula", launch: 24, window: 2, models: 6, breadth: [0.25, 0.5] },
    { name: "Verão 2027", type: "Sazonal", launch: 25, window: 5, models: 8, breadth: [0.45, 0.85] },
  ];

  const REGIONS = ["Sudeste", "Sul", "Nordeste", "Centro-Oeste", "Norte"];
  const STORE_NAMES = ["Alameda", "Bosque", "Cascata", "Delta", "Estrela", "Farol", "Galeria", "Horto", "Ilha", "Jardim",
    "Lago", "Mirante", "Nascente", "Oásis", "Pátio", "Quinta", "Recanto", "Serra", "Terraço", "Vale", "Brisa", "Coral",
    "Dique", "Enseada", "Fonte", "Gruta", "Hera", "Ipê", "Jacarandá", "Ladeira", "Marina", "Neblina"];
  const STORES_PER_REGION = [12, 7, 6, 4, 3];
  const STORE_FORMATS = ["Rua", "Shopping", "Shopping", "Shopping", "Quiosque", "Outlet"];
  const PRICE_BANDS = ["Até R$ 49", "R$ 50–99", "R$ 100–249", "R$ 250+"];

  // ------------------------------------------------------------------ helpers
  function monthOf(idx) {
    const c = START_MONTH - 1 + idx;
    return { year: START_YEAR + Math.floor(c / 12), month: (((c % 12) + 12) % 12) + 1 };
  }
  const pad = n => String(n).padStart(2, "0");
  const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const priceBand = p => (p < 50 ? 0 : p < 100 ? 1 : p < 250 ? 2 : 3);
  const charm = v => Math.max(9.9, Math.round(v / 10) * 10 - 0.1);   // 129,90 style prices

  // ------------------------------------------------------------------ generator
  function generate(seed = 2026) {
    const R = makeRandom(seed);

    // ---- dim_date (monthly grain: one row per closed month)
    const dim_date = [];
    for (let i = 0; i < N_MONTHS; i++) {
      const { year, month } = monthOf(i);
      dim_date.push({
        date_idx: i, date_key: year * 100 + month, year, month, quarter: Math.ceil(month / 3),
        label: `${MONTH_SHORT[month - 1]}/${String(year).slice(2)}`, label_long: `${MONTH_LONG[month - 1]} de ${year}`,
        first_day: iso(year, month, 1), last_day: iso(year, month, daysIn(year, month)), days: daysIn(year, month),
      });
    }

    // ---- dim_store (distribution centers, receiving area, transit, stores)
    const dim_store = [
      { store_key: 0, code: "CD01", name: "CD Central", type: "CD", type_label: "Centro de distribuição", region: "Sudeste", format: "CD", size: 0 },
      { store_key: 1, code: "CD02", name: "CD Sul", type: "CD", type_label: "Centro de distribuição", region: "Sul", format: "CD", size: 0 },
      { store_key: 2, code: "CD03", name: "CD Nordeste", type: "CD", type_label: "Centro de distribuição", region: "Nordeste", format: "CD", size: 0 },
      { store_key: 3, code: "RC01", name: "CD Central · Recebimento", type: "RECEB", type_label: "Recebimento (pendente de alocação)", region: "Sudeste", format: "CD", size: 0 },
      { store_key: 4, code: "TR01", name: "Em trânsito", type: "TRANSITO", type_label: "Em trânsito", region: "—", format: "—", size: 0 },
    ];
    const CD_OF_REGION = { Sudeste: 0, Sul: 1, Nordeste: 2, "Centro-Oeste": 0, Norte: 0 };
    let nameIdx = 0;
    REGIONS.forEach((region, ri) => {
      for (let k = 0; k < STORES_PER_REGION[ri]; k++) {
        const key = dim_store.length;
        const format = R.pick(STORE_FORMATS);
        const size = +(format === "Quiosque" ? R.between(0.45, 0.7) : format === "Outlet" ? R.between(0.8, 1.2) : R.between(0.75, 1.6)).toFixed(2);
        dim_store.push({
          store_key: key, code: "L" + String(key - 4).padStart(3, "0"), name: "Loja " + STORE_NAMES[nameIdx++],
          type: "LOJA", type_label: "Loja", region, format, size, supplier_cd: CD_OF_REGION[region],
        });
      }
    });
    const stores = dim_store.filter(s => s.type === "LOJA");

    // ---- dim_product (model x color = SKU)
    const dim_product = [];
    const modelNums = new Set();
    COLLECTIONS.forEach((col, ci) => {
      for (let k = 0; k < col.models; k++) {
        const cat = R.pick(CATEGORIES);
        const lineChoices = LINES.filter(l => l.cats.includes(cat.key));
        const line = R.pick(lineChoices);
        const [sub, cMin, cMax] = R.pick(cat.subs);
        let num;
        do { num = R.int(100, 999); } while (modelNums.has(cat.key + num));
        modelNums.add(cat.key + num);
        const model = `${cat.key}-${line.code}-${num}`;
        const launch = col.launch == null ? R.int(-30, 20) : col.launch;
        const baseCost = R.between(cMin, cMax) * line.tier;
        const markup = R.between(2.2, 2.8);
        const pop = R.lognormal(0.55);
        const nColors = R.chance(0.25) ? 1 : R.int(2, 4);
        const colors = R.sample(COLORS, nColors);
        const breadth = R.between(col.breadth[0], col.breadth[1]);
        const carried = stores.filter(() => R.chance(breadth));
        if (!carried.length) carried.push(R.pick(stores));
        const { year, month } = monthOf(launch);
        const launchDay = R.int(1, 25);
        const discontinueAt = col.launch == null && launch < 0 && R.chance(0.2) ? R.int(6, 20) : null;
        colors.forEach((color, vi) => {
          const cost = +(baseCost * R.between(0.96, 1.05)).toFixed(2);
          const price = charm(cost * markup);
          dim_product.push({
            sku_key: dim_product.length,
            sku: `${model}-${pad(COLORS.indexOf(color) + 1)}`,
            model, model_name: `${sub} ${line.short} ${num}`,
            category: cat.name, category_code: cat.key, subcategory: sub,
            line: line.name, collection: col.name, collection_type: col.type,
            color, launch_idx: launch, launch_date: iso(year, month, launchDay),
            window_months: col.window, unit_cost: cost, unit_price: price, price_band: PRICE_BANDS[priceBand(price)],
            status: discontinueAt != null ? "Descontinuado" : launch > N_MONTHS - 1 ? "Pré-lançamento" : "Ativo",
            _sim: {
              cat, pop: pop * (vi === 0 ? 1.15 : R.between(0.55, 1)), stores: carried, discontinueAt,
              problem: R.chance(0.13), quality: R.chance(0.06), seasonal: col.window != null,
            },
          });
        });
      }
    });

    // ---- simulation -> fact rows
    const cols = {
      date_idx: [], sku_key: [], store_key: [],
      qty_open: [], qty_receipt: [], qty_transfer_in: [], qty_transfer_out: [], qty_sales: [], qty_adjust: [],
      sales_value: [], cogs_value: [],
      qty_on_hand: [], qty_reserved: [], qty_blocked: [], cost_value: [],
    };
    const ledger = new Map();   // "m|cat|region" -> totals reported by the source system
    const regionOf = s => (dim_store[s].region === "—" ? "—" : dim_store[s].region);
    function emit(m, p, s, open, rec, tin, tout, sales, adj, close, reserved, blocked, salesValue, costM) {
      if (m < 0 || !(open || rec || tin || tout || sales || adj || close)) return;
      cols.date_idx.push(m); cols.sku_key.push(p.sku_key); cols.store_key.push(s);
      cols.qty_open.push(open); cols.qty_receipt.push(rec); cols.qty_transfer_in.push(tin); cols.qty_transfer_out.push(tout);
      cols.qty_sales.push(sales); cols.qty_adjust.push(adj);
      cols.sales_value.push(Math.round(salesValue * 100) / 100); cols.cogs_value.push(Math.round(sales * costM * 100) / 100);
      cols.qty_on_hand.push(close); cols.qty_reserved.push(reserved); cols.qty_blocked.push(blocked);
      cols.cost_value.push(Math.round(close * costM * 100) / 100);
      const k = `${m}|${p.category}|${regionOf(s)}`;
      let L = ledger.get(k);
      if (!L) ledger.set(k, (L = { date_idx: m, category: p.category, region: regionOf(s), stock_qty: 0, stock_cost: 0, sales_qty: 0, sales_value: 0, receipt_qty: 0 }));
      L.stock_qty += close; L.stock_cost += close * costM; L.sales_qty += sales; L.sales_value += salesValue; L.receipt_qty += rec;
    }

    for (const p of dim_product) {
      const P = p._sim;
      const launch = p.launch_idx;
      const base = P.cat.demand * P.pop * 6;
      const carried = P.stores.map(s => ({ key: s.store_key, size: s.size, cd: s.supplier_cd, outlet: s.format === "Outlet" }));
      const planned = carried.reduce((a, s) => a + base * s.size, 0);           // monthly demand at full life
      const cdShare = [0, 0, 0];
      carried.forEach(s => (cdShare[s.cd] += (base * s.size) / planned));
      const life = (m) => {
        const age = m - launch;
        if (age < 0) return 0;
        let f = age === 0 ? 0.75 : 1;
        if (P.seasonal) f *= age < p.window_months ? 1 : 0.5 * Math.pow(0.78, age - p.window_months);
        else if (P.discontinueAt != null && m >= P.discontinueAt) f *= 0.55 * Math.pow(0.85, m - P.discontinueAt);
        else f *= Math.pow(0.996, age);
        return f;
      };

      const cd = [0, 0, 0];
      let receb = 0;
      const shop = new Array(carried.length).fill(0);
      const pend = new Array(carried.length).fill(0);
      const start = Math.max(launch - 2, -12);
      if (launch < -12) {   // already selling before the window: start from a steady state
        for (let c = 0; c < 3; c++) cd[c] = Math.round(2 * planned * cdShare[c] * life(start));
        carried.forEach((s, i) => (shop[i] = Math.round(1.5 * base * s.size * life(start)) + 1));
      }

      for (let m = start; m < N_MONTHS; m++) {
        const { month } = monthOf(m);
        const season = SEASON[month - 1];
        const age = m - launch;
        const postWindow = P.seasonal && age >= p.window_months;
        const costM = p.unit_cost * (1 - 0.004 * (N_MONTHS - 1 - m));
        const cdOpen = cd.slice(), recebOpen = receb;
        const shopOpen = shop.slice(), pendOpen = pend.reduce((a, b) => a + b, 0);

        // 1) purchases arriving this month
        let buy = 0;
        const cdTotal = cd[0] + cd[1] + cd[2] + receb;
        if (m === launch - 1) {
          const months = P.seasonal ? p.window_months * 0.85 : 3;
          buy = Math.round(planned * months * R.lognormal(0.35));
        } else if (age >= 0 && !P.seasonal && (P.discontinueAt == null || m < P.discontinueAt)) {
          if (cdTotal < 1.3 * planned * season && R.chance(0.9)) buy = Math.round(2.5 * planned * R.lognormal(0.2));
        } else if (P.seasonal && (age === 1 || age === 2) && cdTotal < 0.6 * planned && R.chance(0.45)) {
          buy = Math.round(1.2 * planned);
        }
        const rec = [0, 0, 0];
        if (buy > 0) {
          rec[1] = Math.round(buy * cdShare[1]);
          rec[2] = Math.round(buy * cdShare[2]);
          rec[0] = buy - rec[1] - rec[2];
        }
        let toReceb = 0;
        if (rec[0] > 0 && P.problem && R.chance(0.6)) toReceb = Math.round(rec[0] * R.between(0.15, 0.45));
        const recCentral = rec[0] - toReceb;

        // 2) receiving area releases what was waiting (problem SKUs wait longer)
        const release = recebOpen > 0 && R.chance(P.problem ? 0.22 : 0.7) ? recebOpen : 0;
        receb = recebOpen - release + toReceb;
        cd[0] += recCentral + release; cd[1] += rec[1]; cd[2] += rec[2];

        // 3) allocation CD -> stores (through transit)
        const shipped = new Array(carried.length).fill(0);
        if (age >= 0) {
          const need = carried.map((s, i) => {
            let target;
            if (postWindow) target = s.outlet ? Math.ceil(base * s.size * 1.5) : 0;   // outlets absorb leftovers
            else target = Math.ceil(base * s.size * season * life(m) * 1.5) + 1;
            return Math.max(0, target - shop[i] - pend[i]);
          });
          for (let c = 0; c < 3; c++) {
            const idx = carried.map((s, i) => (s.cd === c ? i : -1)).filter(i => i >= 0);
            const want = idx.reduce((a, i) => a + need[i], 0);
            const avail = Math.max(0, cd[c] - Math.round(cd[c] * 0.03));
            if (!want || !avail) continue;
            const ratio = Math.min(1, avail / want);
            idx.forEach(i => (shipped[i] = Math.floor(need[i] * ratio)));
            cd[c] -= idx.reduce((a, i) => a + shipped[i], 0);
          }
        }
        const tout = [0, 0, 0];
        carried.forEach((s, i) => (tout[s.cd] += shipped[i]));

        // 4) deliveries, sales, shrink
        const delivered = carried.map((s, i) => {
          const now = Math.round(shipped[i] * 0.9);
          const d = pend[i] + now;
          pend[i] = shipped[i] - now;
          return d;
        });
        const priceFactor = postWindow ? 0.6 : month === 11 ? 0.9 : 1;
        carried.forEach((s, i) => {
          const demand = age >= 0 ? R.count(base * s.size * season * life(m), 0.35) : 0;
          const avail = shop[i] + delivered[i];
          const sales = Math.min(demand, avail);
          let adj = 0;
          if (avail - sales > 0 && R.chance(0.03)) adj = -1;
          shop[i] = avail - sales + adj;
          emit(m, p, s.key, shopOpen[i], 0, delivered[i], 0, sales, adj, shop[i], 0, 0, sales * p.unit_price * priceFactor, costM);
        });

        // 5) CD, receiving and transit rows
        for (let c = 0; c < 3; c++) {
          const close = cd[c];
          const blocked = c === 0 && P.quality ? Math.round(close * R.between(0.1, 0.4)) : 0;
          const reserved = Math.min(close - blocked, Math.round(close * R.between(0, 0.06)));
          emit(m, p, c, cdOpen[c], c === 0 ? recCentral : rec[c], c === 0 ? release : 0, tout[c], 0, 0, close, reserved, blocked, 0, costM);
        }
        emit(m, p, 3, recebOpen, toReceb, 0, release, 0, 0, receb, 0, 0, 0, costM);
        const transitClose = pend.reduce((a, b) => a + b, 0);
        const transitIn = tout[0] + tout[1] + tout[2];
        emit(m, p, 4, pendOpen, 0, transitIn, pendOpen + transitIn - transitClose, 0, 0, transitClose, 0, 0, 0, costM);
      }
    }

    // ---- pack facts into typed arrays
    const n = cols.date_idx.length;
    const typed = (name, T) => T.from(cols[name]);
    const keys = { date_idx: typed("date_idx", Uint8Array), sku_key: typed("sku_key", Uint16Array), store_key: typed("store_key", Uint8Array) };
    const fact_movement = {
      n, ...keys,
      qty_open: typed("qty_open", Int32Array), qty_receipt: typed("qty_receipt", Int32Array),
      qty_transfer_in: typed("qty_transfer_in", Int32Array), qty_transfer_out: typed("qty_transfer_out", Int32Array),
      qty_sales: typed("qty_sales", Int32Array), qty_adjust: typed("qty_adjust", Int32Array),
      sales_value: typed("sales_value", Float64Array), cogs_value: typed("cogs_value", Float64Array),
    };
    const fact_stock = {
      n, ...keys,
      qty_on_hand: typed("qty_on_hand", Int32Array), qty_reserved: typed("qty_reserved", Int32Array),
      qty_blocked: typed("qty_blocked", Int32Array), cost_value: typed("cost_value", Float64Array),
    };

    // ---- source ledger + planted discrepancies (what a real reconciliation tends to find)
    const source_ledger = Array.from(ledger.values()).map(L => ({
      ...L, stock_cost: Math.round(L.stock_cost * 100) / 100, sales_value: Math.round(L.sales_value * 100) / 100,
    }));
    const findL = (m, cat, region) => source_ledger.find(L => L.date_idx === m && L.category === cat && L.region === region);
    const last = N_MONTHS - 1;
    const issues = [];
    let L = findL(last, "Eletrônicos", "Sudeste");
    if (L) { const d = Math.max(5, Math.round(L.sales_qty * 0.022)); L.sales_qty += d; L.sales_value += d * 89.9; issues.push("vendas pós-corte"); }
    L = findL(last - 2, "Acessórios", "Sul");
    if (L) { L.stock_cost = Math.round(L.stock_cost * 1.0035 * 100) / 100; issues.push("reavaliação de custo"); }
    L = findL(last, "Papelaria", "Nordeste");
    if (L) { L.stock_qty -= Math.max(3, Math.round(L.stock_qty * 0.002)); issues.push("ajuste de inventário"); }
    // two fact rows whose adjustment did not reach the closing balance (load bug)
    let planted = 0;
    for (let i = 0; i < n && planted < 2; i++) {
      if (fact_movement.date_idx[i] === last - 1 && dim_store[fact_movement.store_key[i]].type === "LOJA" &&
          fact_stock.qty_on_hand[i] > 3 && fact_movement.qty_adjust[i] === 0 && R.chance(0.02)) {
        fact_movement.qty_adjust[i] = -1;
        planted++;
      }
    }

    dim_product.forEach(p => delete p._sim);
    return {
      meta: {
        brand: BRAND, seed, generated_rows: n, months: N_MONTHS,
        categories: CATEGORIES.map(c => c.name), subcategories: Object.fromEntries(CATEGORIES.map(c => [c.name, c.subs.map(s => s[0])])),
        lines: LINES.map(l => l.name), collections: COLLECTIONS.map(c => ({ name: c.name, type: c.type, launch: c.launch, window: c.window })),
        regions: REGIONS, price_bands: PRICE_BANDS, season: SEASON, planted_issues: issues.length + (planted ? 1 : 0),
      },
      dim_date, dim_product, dim_store, fact_stock, fact_movement, source_ledger,
    };
  }

  root.DemoData = { generate, BRAND };
})(typeof window !== "undefined" ? window : globalThis);
