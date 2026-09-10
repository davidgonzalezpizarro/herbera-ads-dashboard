// Netlify Function — live Meta Ads (Herbera) data via Windsor.ai
// No npm dependencies: uses the global `fetch` available on Netlify's Node 18+ runtime.

const ACCOUNT_ID = "10151594856848774"; // Herbera Cosmetics® Meta Ads account
const BASE = "https://connectors.windsor.ai/facebook";

const OBJECTIVE_LABEL = {
  OUTCOME_SALES: "Ventas",
  OUTCOME_LEADS: "Leads",
  OUTCOME_AWARENESS: "Notoriedad",
  OUTCOME_TRAFFIC: "Tráfico",
  OUTCOME_ENGAGEMENT: "Interacción",
  OUTCOME_APP_PROMOTION: "Promoción de app",
};

function windsorURL(fields, extra) {
  const key = process.env.WINDSOR_API_KEY;
  const params = new URLSearchParams({
    api_key: key,
    fields: fields.join(","),
    select_accounts: ACCOUNT_ID, // scope every query to Herbera only — without this Windsor
    // aggregates across every Meta account connected to this API key, which is far
    // slower and can leak other accounts' numbers into the totals. NOTE: "account_id"
    // is only a data field in Windsor's API, not a filter — the real filter param is
    // "select_accounts" (confirmed against windsor.ai/api-documentation/).
    ...extra,
  });
  return `${BASE}?${params.toString()}`;
}

async function fetchRows(fields, extra, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(windsorURL(fields, extra), { signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Windsor.ai ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = await res.json();
    return json.data || [];
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error(`Windsor.ai request timed out after ${timeoutMs}ms (fields: ${fields.slice(0, 3).join(",")}...)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const n = (v) => (v === undefined || v === null || Number.isNaN(v) ? 0 : Number(v));
const safeDiv = (a, b) => (b > 0 ? a / b : 0);

const eur = (v) =>
  new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(v || 0);
const int = (v) => new Intl.NumberFormat("es-ES").format(Math.round(v || 0));
const pct = (v) => `${new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 }).format((v || 0) * 100)} %`;
const x = (v) => `${new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 }).format(v || 0)}×`;
const num2 = (v) => new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 }).format(v || 0);

function deriveTotals(row) {
  const spend = n(row.spend);
  const clicks = n(row.clicks);
  const impressions = n(row.impressions);
  const revenue = n(row.action_values_purchase);
  const purchases = n(row.actions_purchase);
  const visits = n(row.actions_landing_page_view);
  const carts = n(row.actions_add_to_cart);
  const checkouts = n(row.actions_initiate_checkout);
  return {
    spend,
    clicks,
    revenue,
    purchases,
    visits,
    carts,
    checkouts,
    frequency: n(row.frequency),
    impressions,
    roas: safeDiv(revenue, spend),
    aov: safeDiv(revenue, purchases),
    cpa: safeDiv(spend, purchases),
    cpc: safeDiv(spend, clicks),
    cpm: safeDiv(spend, impressions) * 1000,
    ctr: n(row.ctr),
    costPerVisit: safeDiv(spend, visits),
    costPerCart: safeDiv(spend, carts),
    costPerCheckout: safeDiv(spend, checkouts),
    clickToVisit: safeDiv(visits, clicks),
    clickToCart: safeDiv(carts, clicks),
    clickToCheckout: safeDiv(checkouts, clicks),
    clickToPurchase: safeDiv(purchases, clicks),
  };
}

const fmt = (d) => ({
  spend: eur(d.spend), revenue: eur(d.revenue), roas: x(d.roas), aov: eur(d.aov), cpa: eur(d.cpa),
  cpc: eur(d.cpc), cpm: eur(d.cpm), ctr: pct(d.ctr), costPerVisit: eur(d.costPerVisit), costPerCart: eur(d.costPerCart),
  costPerCheckout: eur(d.costPerCheckout), clickToVisit: pct(d.clickToVisit), clickToCart: pct(d.clickToCart),
  clickToCheckout: pct(d.clickToCheckout), clickToPurchase: pct(d.clickToPurchase),
  clicks: int(d.clicks), visits: int(d.visits), carts: int(d.carts), checkouts: int(d.checkouts),
  purchases: int(d.purchases), frequency: num2(d.frequency),
});

// ---------- calendar-month date ranges ----------
// Windsor.ai has no "last_month" preset, so every window here is built from
// exact date_from/date_to. offsetMonths=0 with "toDate" gives the current
// month up to today (partial); any other offset gives a full calendar month.
function monthRange(offsetMonths, toDate) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetMonths, 1));
  const end = toDate
    ? now
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetMonths + 1, 0));
  const toISO = (d) => d.toISOString().slice(0, 10);
  return { date_from: toISO(start), date_to: toISO(end) };
}
function monthLabel(range) {
  return new Date(`${range.date_from}T00:00:00Z`).toLocaleDateString("es-ES", { month: "short", timeZone: "UTC" });
}

// ---------- month-over-month deltas ----------

function fmtPct(v) {
  const s = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(Math.abs(v) * 100);
  return `${v >= 0 ? "+" : "−"}${s} %`;
}
function fmtPp(vPoints) {
  const s = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(Math.abs(vPoints));
  return `${vPoints >= 0 ? "+" : "−"}${s} pp`;
}

// goodDir: "up" (higher is better), "down" (lower is better), "neutral" (no judgement, just informative)
function buildDelta(curr, prev, { mode = "pct", goodDir = "up" } = {}) {
  if (prev === null || prev === undefined) return null;
  let v, text;
  if (mode === "pct") {
    if (!prev) return null; // avoid meaningless/divide-by-zero % from a zero baseline
    v = (curr - prev) / prev;
    text = fmtPct(v);
  } else {
    v = curr - prev; // pp mode: curr/prev are 0..1 ratios, express the gap in points
    text = fmtPp(v * 100);
  }
  const dir = v > 0.0005 ? "up" : v < -0.0005 ? "down" : "flat";
  const good = goodDir === "neutral" || dir === "flat" ? null : dir === goodDir;
  return { text, dir, good };
}

function buildDeltas(totals, prevTotals) {
  return {
    revenue: buildDelta(totals.revenue, prevTotals.revenue, { goodDir: "up" }),
    spend: buildDelta(totals.spend, prevTotals.spend, { goodDir: "neutral" }),
    roas: buildDelta(totals.roas, prevTotals.roas, { goodDir: "up" }),
    aov: buildDelta(totals.aov, prevTotals.aov, { goodDir: "up" }),
    frequency: buildDelta(totals.frequency, prevTotals.frequency, { goodDir: "neutral" }),
    clicks: buildDelta(totals.clicks, prevTotals.clicks, { goodDir: "neutral" }),
    cpc: buildDelta(totals.cpc, prevTotals.cpc, { goodDir: "down" }),
    visits: buildDelta(totals.visits, prevTotals.visits, { goodDir: "up" }),
    costPerVisit: buildDelta(totals.costPerVisit, prevTotals.costPerVisit, { goodDir: "down" }),
    clickToVisit: buildDelta(totals.clickToVisit, prevTotals.clickToVisit, { mode: "pp", goodDir: "up" }),
    carts: buildDelta(totals.carts, prevTotals.carts, { goodDir: "up" }),
    costPerCart: buildDelta(totals.costPerCart, prevTotals.costPerCart, { goodDir: "down" }),
    clickToCart: buildDelta(totals.clickToCart, prevTotals.clickToCart, { mode: "pp", goodDir: "up" }),
    checkouts: buildDelta(totals.checkouts, prevTotals.checkouts, { goodDir: "up" }),
    costPerCheckout: buildDelta(totals.costPerCheckout, prevTotals.costPerCheckout, { goodDir: "down" }),
    clickToCheckout: buildDelta(totals.clickToCheckout, prevTotals.clickToCheckout, { mode: "pp", goodDir: "up" }),
    purchases: buildDelta(totals.purchases, prevTotals.purchases, { goodDir: "up" }),
    cpa: buildDelta(totals.cpa, prevTotals.cpa, { goodDir: "down" }),
    clickToPurchase: buildDelta(totals.clickToPurchase, prevTotals.clickToPurchase, { mode: "pp", goodDir: "up" }),
  };
}

// ---------- automatic "scale / consider pausing" insights ----------
// Flags rows that clearly beat or lag the account-average cost per purchase,
// with a minimum spend/volume bar so small samples don't produce noisy calls.

const SCALE_THRESHOLD = 0.6; // CPA <= 60% of account avg  → "40%+ cheaper"
const PAUSE_THRESHOLD = 1.5; // CPA >= 150% of account avg → "50%+ more expensive"

function buildInsights(totals, rows, { minSpend, minPurchasesForScale }) {
  const avgCpa = totals.purchases > 0 ? totals.cpa : 0;
  const withVolume = rows.filter((a) => a.spend >= minSpend);

  const scale = avgCpa > 0
    ? withVolume
        .filter((a) => a.purchases >= minPurchasesForScale && a.cpa > 0 && a.cpa <= avgCpa * SCALE_THRESHOLD)
        .sort((a, b) => a.cpa - b.cpa)
        .slice(0, 5)
        .map((a) => ({
          name: a.name,
          campaign: a.campaign,
          cpa: eur(a.cpa),
          cheaperPct: Math.round((1 - a.cpa / avgCpa) * 100),
          purchases: int(a.purchases),
          spend: eur(a.spend),
        }))
    : [];

  const zeroPurchaseHighSpend = withVolume.filter((a) => a.purchases === 0);
  const expensiveVsAvg = avgCpa > 0
    ? withVolume.filter((a) => a.purchases > 0 && a.cpa >= avgCpa * PAUSE_THRESHOLD)
    : [];

  const pause = [...expensiveVsAvg, ...zeroPurchaseHighSpend]
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 5)
    .map((a) => ({
      name: a.name,
      campaign: a.campaign,
      purchases: int(a.purchases),
      spend: eur(a.spend),
      cpa: a.purchases > 0 ? eur(a.cpa) : null,
      moreExpensivePct: a.purchases > 0 && avgCpa > 0 ? Math.round((a.cpa / avgCpa - 1) * 100) : null,
    }));

  return { avgCpa: eur(avgCpa), minSpend: eur(minSpend), scale, pause };
}

// ---------- ranked leaderboards ----------

function buildLeaderboards(rows, minSpend) {
  const withVolume = rows.filter((a) => a.spend >= minSpend);
  const withPurchases = withVolume.filter((a) => a.purchases > 0);

  const bestCpa = [...withPurchases]
    .sort((a, b) => a.cpa - b.cpa)
    .slice(0, 5)
    .map((a) => ({ name: a.name, campaign: a.campaign, value: eur(a.cpa), detail: `${int(a.purchases)} compras · ${eur(a.spend)} invertidos` }));

  const bestRoas = [...withPurchases]
    .sort((a, b) => b.roas - a.roas)
    .slice(0, 5)
    .map((a) => ({ name: a.name, campaign: a.campaign, value: x(a.roas), detail: `${eur(a.revenue)} facturados · ${eur(a.spend)} invertidos` }));

  const bestAov = [...withPurchases]
    .filter((a) => a.purchases >= 3)
    .sort((a, b) => b.aov - a.aov)
    .slice(0, 5)
    .map((a) => ({ name: a.name, campaign: a.campaign, value: eur(a.aov), detail: `${int(a.purchases)} compras · ${eur(a.revenue)} facturados` }));

  return { bestCpa, bestRoas, bestAov };
}

exports.handler = async (event) => {
  try {
    if (!process.env.WINDSOR_API_KEY) {
      return { statusCode: 500, body: JSON.stringify({ error: "WINDSOR_API_KEY no configurada en Netlify." }) };
    }

    const qs = event.queryStringParameters || {};
    // "current" = current calendar month to date (default). "last_complete" = the
    // last full calendar month, compared against the one before it.
    const period = qs.period === "last_complete" ? "last_complete" : "current";
    const mainOffset = period === "last_complete" ? -1 : 0;
    const mainIsPartial = period === "current";

    const mainRange = monthRange(mainOffset, mainIsPartial);
    const compareRange = monthRange(mainOffset - 1, false);
    const trendRange3 = monthRange(mainOffset - 2, false);

    const totalFields = [
      "spend", "clicks", "impressions", "reach", "cpc", "ctr", "frequency",
      "actions_landing_page_view", "actions_add_to_cart", "actions_initiate_checkout",
      "actions_purchase", "action_values_purchase",
    ];
    const campaignFields = ["campaign", "campaign_objective", ...totalFields];
    const adsetFields = ["adset_name", "campaign", ...totalFields];
    const adFields = ["ad_name", "campaign", "adset_name", "thumbnail_url", ...totalFields];

    const [totalsRows, campaignRows, adsetRows, adRows, prevTotalsRows, trend3Rows] = await Promise.all([
      fetchRows(totalFields, mainRange),
      fetchRows(campaignFields, mainRange),
      fetchRows(adsetFields, mainRange),
      fetchRows(adFields, mainRange),
      fetchRows(totalFields, compareRange),
      fetchRows(totalFields, trendRange3),
    ]);

    const totals = deriveTotals(totalsRows[0] || {});
    const prevTotals = deriveTotals(prevTotalsRows[0] || {});
    const trend3Totals = deriveTotals(trend3Rows[0] || {});

    const campaigns = campaignRows
      .map((r) => {
        const d = deriveTotals(r);
        return {
          name: r.campaign,
          objective: OBJECTIVE_LABEL[r.campaign_objective] || r.campaign_objective || "",
          ...d,
        };
      })
      .sort((a, b) => b.spend - a.spend);

    const maxCampSpend = Math.max(1, ...campaigns.map((c) => c.spend));
    const maxCampRevenue = Math.max(1, ...campaigns.map((c) => c.revenue));
    campaigns.forEach((c) => {
      c.spendPct = (100 * c.spend) / maxCampSpend;
      c.revenuePct = (100 * c.revenue) / maxCampRevenue;
    });

    const allAudiences = adsetRows.map((r) => ({ name: r.adset_name, campaign: r.campaign, ...deriveTotals(r) }));

    const AUDIENCE_MIN_SPEND = 60;
    const CAMPAIGN_MIN_SPEND = 100;

    const audiences = allAudiences
      .filter((a) => a.spend >= AUDIENCE_MIN_SPEND)
      .sort((a, b) => b.roas - a.roas)
      .slice(0, 6);

    const ads = adRows
      .map((r) => ({
        name: r.ad_name,
        campaign: r.campaign,
        adset: r.adset_name,
        image: r.thumbnail_url || null,
        ...deriveTotals(r),
      }))
      .filter((a) => a.spend > 0)
      .sort((a, b) => (b.purchases - a.purchases) || (b.revenue - a.revenue));

    const mapFmt = (arr) => arr.map((it) => ({ ...it, fmt: fmt(it) }));

    const prevMonthLabel = monthLabel(compareRange);

    let dayOfMonth = null;
    let daysInMonth = null;
    if (mainIsPartial) {
      const now = new Date();
      dayOfMonth = now.getUTCDate();
      daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    }

    const trend = [
      { label: monthLabel(trendRange3), ...trend3Totals, isProvisional: false },
      { label: monthLabel(compareRange), ...prevTotals, isProvisional: false },
      { label: monthLabel(mainRange), ...totals, isProvisional: mainIsPartial },
    ].map((t) => ({
      label: t.label,
      isProvisional: t.isProvisional,
      cpa: t.purchases > 0 ? t.cpa : null,
      roas: t.spend > 0 ? t.roas : null,
      cpc: t.clicks > 0 ? t.cpc : null,
      fmtCpa: t.purchases > 0 ? eur(t.cpa) : "—",
      fmtRoas: t.spend > 0 ? x(t.roas) : "—",
      fmtCpc: t.clicks > 0 ? eur(t.cpc) : "—",
    }));

    const payload = {
      meta: {
        account: "Herbera Cosmetics®",
        period,
        range: mainRange,
        compareRange,
        prevMonthLabel,
        isPartial: mainIsPartial,
        dayOfMonth,
        daysInMonth,
        generatedAt: new Date().toISOString(),
        author: "David González Pizarro — Consultor Ecommerce",
      },
      totals: {
        ...totals,
        fmt: fmt(totals),
        deltas: buildDeltas(totals, prevTotals),
      },
      campaigns: mapFmt(campaigns),
      audiences: mapFmt(audiences),
      ads: mapFmt(ads),
      insights: buildInsights(totals, allAudiences, { minSpend: AUDIENCE_MIN_SPEND, minPurchasesForScale: 3 }),
      campaignInsights: buildInsights(totals, campaigns, { minSpend: CAMPAIGN_MIN_SPEND, minPurchasesForScale: 3 }),
      leaderboards: buildLeaderboards(allAudiences, AUDIENCE_MIN_SPEND),
      thresholds: { audienceMinSpend: eur(AUDIENCE_MIN_SPEND), campaignMinSpend: eur(CAMPAIGN_MIN_SPEND) },
      trend,
    };

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=120", // 2 min edge cache so repeated loads don't hammer the API
      },
      body: JSON.stringify(payload),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err && err.message ? err.message : err) }) };
  }
};
