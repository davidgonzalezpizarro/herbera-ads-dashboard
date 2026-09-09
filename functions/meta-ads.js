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
    filter: JSON.stringify([["account_id", "eq", ACCOUNT_ID]]),
    ...extra,
  });
  return `${BASE}?${params.toString()}`;
}

async function fetchRows(fields, extra) {
  const res = await fetch(windsorURL(fields, extra));
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Windsor.ai ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  return json.data || [];
}

const n = (v) => (v === undefined || v === null || Number.isNaN(v) ? 0 : Number(v));
const safeDiv = (a, b) => (b > 0 ? a / b : 0);

const eur = (v) =>
  new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(v || 0);
const int = (v) => new Intl.NumberFormat("es-ES").format(Math.round(v || 0));
const pct = (v) => `${new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 }).format((v || 0) * 100)} %`;
const x = (v) => `${new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 }).format(v || 0)}×`;

function deriveTotals(row) {
  const spend = n(row.spend);
  const clicks = n(row.clicks);
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
    roas: safeDiv(revenue, spend),
    aov: safeDiv(revenue, purchases),
    cpa: safeDiv(spend, purchases),
    cpc: safeDiv(spend, clicks),
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

exports.handler = async (event) => {
  try {
    if (!process.env.WINDSOR_API_KEY) {
      return { statusCode: 500, body: JSON.stringify({ error: "WINDSOR_API_KEY no configurada en Netlify." }) };
    }

    const qs = event.queryStringParameters || {};
    // Default window: current calendar month to date.
    const datePreset = qs.date_preset || "this_month";

    const totalFields = [
      "spend", "clicks", "impressions", "reach", "cpc", "ctr",
      "actions_landing_page_view", "actions_add_to_cart", "actions_initiate_checkout",
      "actions_purchase", "action_values_purchase",
    ];
    const campaignFields = ["campaign", "campaign_objective", ...totalFields];
    const adsetFields = ["adset_name", "campaign", ...totalFields];
    const adFields = ["ad_name", "campaign", "adset_name", ...totalFields];

    const [totalsRows, campaignRows, adsetRows, adRows] = await Promise.all([
      fetchRows(totalFields, { date_preset: datePreset }),
      fetchRows(campaignFields, { date_preset: datePreset }),
      fetchRows(adsetFields, { date_preset: datePreset }),
      fetchRows(adFields, { date_preset: datePreset }),
    ]);

    const totalsRow = totalsRows[0] || {};
    const totals = deriveTotals(totalsRow);

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

    const audiences = adsetRows
      .map((r) => ({ name: r.adset_name, campaign: r.campaign, ...deriveTotals(r) }))
      .filter((a) => a.spend >= 60)
      .sort((a, b) => b.roas - a.roas)
      .slice(0, 6);

    const ads = adRows
      .map((r) => ({ name: r.ad_name, campaign: r.campaign, adset: r.adset_name, ...deriveTotals(r) }))
      .filter((a) => a.spend >= 50)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 4);

    const fmt = (d) => ({
      spend: eur(d.spend), revenue: eur(d.revenue), roas: x(d.roas), aov: eur(d.aov), cpa: eur(d.cpa),
      cpc: eur(d.cpc), ctr: pct(d.ctr), costPerVisit: eur(d.costPerVisit), costPerCart: eur(d.costPerCart),
      costPerCheckout: eur(d.costPerCheckout), clickToVisit: pct(d.clickToVisit), clickToCart: pct(d.clickToCart),
      clickToCheckout: pct(d.clickToCheckout), clickToPurchase: pct(d.clickToPurchase),
      clicks: int(d.clicks), visits: int(d.visits), carts: int(d.carts), checkouts: int(d.checkouts),
      purchases: int(d.purchases),
    });

    const payload = {
      meta: {
        account: "Herbera Cosmetics®",
        datePreset,
        generatedAt: new Date().toISOString(),
      },
      totals: { ...totals, fmt: fmt(totals) },
      campaigns: campaigns.map((c) => ({ ...c, fmt: fmt(c) })),
      audiences: audiences.map((a) => ({ ...a, fmt: fmt(a) })),
      ads: ads.map((a) => ({ ...a, fmt: fmt(a) })),
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
