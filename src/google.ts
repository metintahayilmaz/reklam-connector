import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { READ, WRITE, safe } from "./util.js";
import type { Env } from "./index.js";

const SCOPES = ["https://www.googleapis.com/auth/analytics.readonly", "https://www.googleapis.com/auth/webmasters"];

const b64url = (data: string | ArrayBuffer) => {
  const s = typeof data === "string" ? data : String.fromCharCode(...new Uint8Array(data));
  return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
};

let cached: { token: string; exp: number } | undefined;

/** Exchanges a service-account key for an OAuth access token (JWT bearer flow), cached per isolate. */
async function accessToken(env: Env): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON!);
  const now = Math.floor(Date.now() / 1000);
  const unsigned =
    b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })) +
    "." +
    b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPES.join(" "), aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${b64url(sig)}` }),
  });
  const body: any = await res.json();
  if (!res.ok) throw new Error(`Google kimlik doğrulama hatası: ${body.error_description || body.error}`);
  cached = { token: body.access_token, exp: Date.now() + body.expires_in * 1000 };
  return cached.token;
}

async function gapi(env: Env, url: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(url, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: { Authorization: `Bearer ${await accessToken(env)}`, "Content-Type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 204) return { ok: true };
  const text = await res.text();
  const body: any = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = body.error?.message || res.statusText;
    const hint =
      res.status === 403
        ? " (Servis hesabı e-postasını GA4 mülkünde 'Görüntüleyici' veya Search Console'da 'Tam' kullanıcı olarak eklediğinizden ve ilgili API'yi Google Cloud'da etkinleştirdiğinizden emin olun.)"
        : "";
    throw new Error(`Google API ${res.status}: ${msg}${hint}`);
  }
  return body;
}

const prop = (id: string) => (id.startsWith("properties/") ? id : `properties/${id}`);

/** Flattens GA4 row format into plain objects keyed by dimension/metric name. */
function flattenReport(r: any) {
  const dims = (r.dimensionHeaders ?? []).map((h: any) => h.name);
  const mets = (r.metricHeaders ?? []).map((h: any) => h.name);
  return {
    row_count: r.rowCount ?? 0,
    rows: (r.rows ?? []).map((row: any) => {
      const o: Record<string, string | number> = {};
      dims.forEach((d: string, i: number) => (o[d] = row.dimensionValues[i].value));
      mets.forEach((m: string, i: number) => (o[m] = Number(row.metricValues[i].value)));
      return o;
    }),
    ...(r.totals ? { totals: r.totals } : {}),
    ...(r.metadata?.currencyCode ? { currency: r.metadata.currencyCode, time_zone: r.metadata.timeZone } : {}),
  };
}

const filterSchema = z
  .record(z.string(), z.any())
  .optional()
  .describe("GA4 FilterExpression JSON. Örn: {filter:{fieldName:'country',stringFilter:{value:'Turkey'}}} veya {andGroup:{expressions:[...]}}");

export function registerGoogleTools(server: McpServer, env: Env) {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) return;

  // ---------- Google Analytics 4 ----------

  server.registerTool(
    "ga4_list_properties",
    {
      title: "GA4 mülklerini listele",
      description: "Servis hesabının erişebildiği tüm Google Analytics 4 hesaplarını ve mülklerini (property_id) listeler.",
      inputSchema: {},
      annotations: READ,
    },
    safe(async () => {
      const body = await gapi(env, "https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200");
      return (body.accountSummaries ?? []).map((a: any) => ({
        account: a.displayName,
        account_id: a.account,
        properties: (a.propertySummaries ?? []).map((p: any) => ({ property_id: p.property.replace("properties/", ""), name: p.displayName })),
      }));
    }),
  );

  server.registerTool(
    "ga4_run_report",
    {
      title: "GA4 raporu çalıştır",
      description:
        "GA4 Data API ile rapor çalıştırır. Sık metrikler: activeUsers, sessions, screenPageViews, conversions, keyEvents, totalRevenue, engagementRate, averageSessionDuration, bounceRate. Sık boyutlar: date, sessionSource, sessionMedium, sessionCampaignName, sessionDefaultChannelGroup, pagePath, landingPage, country, city, deviceCategory, eventName. Geçerli adlar için ga4_get_metadata.",
      inputSchema: {
        property_id: z.string().describe("Sayısal GA4 property ID (ga4_list_properties)"),
        start_date: z.string().default("28daysAgo").describe("YYYY-MM-DD, 'today', 'yesterday', 'NdaysAgo'"),
        end_date: z.string().default("today"),
        compare_start_date: z.string().optional().describe("Karşılaştırma dönemi başlangıcı"),
        compare_end_date: z.string().optional(),
        metrics: z.array(z.string()).min(1).max(10),
        dimensions: z.array(z.string()).max(9).default([]),
        dimension_filter: filterSchema,
        metric_filter: filterSchema,
        order_by: z.string().optional().describe("Sıralanacak metrik veya boyut adı"),
        order_desc: z.boolean().default(true),
        limit: z.number().int().min(1).max(10000).default(100),
        offset: z.number().int().min(0).default(0),
      },
      annotations: READ,
    },
    safe(async (a) => {
      const dateRanges = [{ startDate: a.start_date, endDate: a.end_date }];
      if (a.compare_start_date && a.compare_end_date) dateRanges.push({ startDate: a.compare_start_date, endDate: a.compare_end_date });
      const isMetric = a.order_by && a.metrics.includes(a.order_by);
      const body = await gapi(env, `https://analyticsdata.googleapis.com/v1beta/${prop(a.property_id)}:runReport`, {
        body: {
          dateRanges,
          metrics: a.metrics.map((name) => ({ name })),
          dimensions: a.dimensions.map((name) => ({ name })),
          dimensionFilter: a.dimension_filter,
          metricFilter: a.metric_filter,
          orderBys: a.order_by ? [isMetric ? { metric: { metricName: a.order_by }, desc: a.order_desc } : { dimension: { dimensionName: a.order_by }, desc: a.order_desc }] : undefined,
          limit: a.limit,
          offset: a.offset,
          metricAggregations: ["TOTAL"],
        },
      });
      return flattenReport(body);
    }),
  );

  server.registerTool(
    "ga4_run_realtime_report",
    {
      title: "GA4 gerçek zamanlı rapor",
      description: "Son 30 dakikadaki aktif kullanıcıları ve olayları gösterir. Boyutlar: country, city, deviceCategory, unifiedScreenName, eventName. Metrikler: activeUsers, eventCount, screenPageViews, keyEvents.",
      inputSchema: {
        property_id: z.string(),
        metrics: z.array(z.string()).min(1).default(["activeUsers"]),
        dimensions: z.array(z.string()).default([]),
        limit: z.number().int().min(1).max(1000).default(50),
      },
      annotations: READ,
    },
    safe(async (a) =>
      flattenReport(
        await gapi(env, `https://analyticsdata.googleapis.com/v1beta/${prop(a.property_id)}:runRealtimeReport`, {
          body: { metrics: a.metrics.map((name) => ({ name })), dimensions: a.dimensions.map((name) => ({ name })), limit: a.limit },
        }),
      ),
    ),
  );

  server.registerTool(
    "ga4_get_metadata",
    {
      title: "GA4 boyut/metrik listesi",
      description: "Mülk için kullanılabilir tüm boyut ve metrik adlarını (özel olanlar dahil) döndürür. search ile filtreleyin.",
      inputSchema: { property_id: z.string(), search: z.string().optional().describe("Ad/açıklamada aranacak metin, örn 'campaign'") },
      annotations: READ,
    },
    safe(async ({ property_id, search }) => {
      const body = await gapi(env, `https://analyticsdata.googleapis.com/v1beta/${prop(property_id)}/metadata`);
      const q = search?.toLowerCase();
      const pick = (list: any[]) =>
        list
          .filter((x) => !q || `${x.apiName} ${x.uiName} ${x.description}`.toLowerCase().includes(q))
          .map((x) => ({ name: x.apiName, ui: x.uiName, ...(x.category ? { category: x.category } : {}) }));
      return { dimensions: pick(body.dimensions ?? []), metrics: pick(body.metrics ?? []) };
    }),
  );

  // ---------- Google Search Console ----------

  const GSC = "https://searchconsole.googleapis.com/webmasters/v3";
  const site = (s: string) => encodeURIComponent(s);
  const siteUrl = z.string().describe("Search Console mülkü, örn 'sc-domain:example.com' veya 'https://www.example.com/'");

  server.registerTool(
    "gsc_list_sites",
    {
      title: "Search Console mülklerini listele",
      description: "Servis hesabının erişebildiği Search Console mülklerini ve yetki seviyesini listeler.",
      inputSchema: {},
      annotations: READ,
    },
    safe(async () => (await gapi(env, `${GSC}/sites`)).siteEntry ?? []),
  );

  server.registerTool(
    "gsc_search_analytics",
    {
      title: "Arama performansı",
      description: "Organik Google arama performansı: tıklama, gösterim, CTR, ortalama pozisyon. Sorgu, sayfa, ülke, cihaz ve tarih bazında kırılım. Veriler ~2-3 gün gecikmeli gelir.",
      inputSchema: {
        site_url: siteUrl,
        start_date: z.string().describe("YYYY-MM-DD"),
        end_date: z.string().describe("YYYY-MM-DD"),
        dimensions: z.array(z.enum(["query", "page", "country", "device", "date", "searchAppearance"])).default(["query"]),
        search_type: z.enum(["web", "image", "video", "news", "discover", "googleNews"]).default("web"),
        filters: z
          .array(z.object({ dimension: z.enum(["query", "page", "country", "device", "searchAppearance"]), operator: z.enum(["equals", "notEquals", "contains", "notContains", "includingRegex", "excludingRegex"]), expression: z.string() }))
          .optional()
          .describe("Örn: [{dimension:'page',operator:'contains',expression:'/blog/'}]"),
        row_limit: z.number().int().min(1).max(25000).default(100),
        start_row: z.number().int().min(0).default(0),
      },
      annotations: READ,
    },
    safe(async (a) => {
      const body = await gapi(env, `${GSC}/sites/${site(a.site_url)}/searchAnalytics/query`, {
        body: {
          startDate: a.start_date,
          endDate: a.end_date,
          dimensions: a.dimensions,
          type: a.search_type,
          dimensionFilterGroups: a.filters ? [{ filters: a.filters }] : undefined,
          rowLimit: a.row_limit,
          startRow: a.start_row,
        },
      });
      return (body.rows ?? []).map((r: any) => {
        const o: Record<string, unknown> = {};
        a.dimensions.forEach((d, i) => (o[d] = r.keys[i]));
        return { ...o, clicks: r.clicks, impressions: r.impressions, ctr: Number(r.ctr.toFixed(4)), position: Number(r.position.toFixed(1)) };
      });
    }),
  );

  server.registerTool(
    "gsc_inspect_url",
    {
      title: "URL denetle",
      description: "Bir URL'nin Google dizin durumunu, son tarama tarihini, kanonik URL'yi, mobil uyumluluğu ve zengin sonuç durumunu döndürür.",
      inputSchema: { site_url: siteUrl, url: z.string().url().describe("Denetlenecek tam URL") },
      annotations: READ,
    },
    safe(async ({ site_url, url }) =>
      (await gapi(env, "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", { body: { inspectionUrl: url, siteUrl: site_url, languageCode: "tr" } })).inspectionResult,
    ),
  );

  server.registerTool(
    "gsc_list_sitemaps",
    {
      title: "Site haritalarını listele",
      description: "Mülke gönderilmiş site haritalarını, son okuma tarihini, hata/uyarı sayılarını listeler.",
      inputSchema: { site_url: siteUrl },
      annotations: READ,
    },
    safe(async ({ site_url }) => (await gapi(env, `${GSC}/sites/${site(site_url)}/sitemaps`)).sitemap ?? []),
  );

  server.registerTool(
    "gsc_submit_sitemap",
    {
      title: "Site haritası gönder",
      description: "Search Console'a site haritası gönderir veya yeniden gönderir. Servis hesabının mülkte 'Tam' veya 'Sahip' yetkisi olmalı.",
      inputSchema: { site_url: siteUrl, sitemap_url: z.string().url() },
      annotations: { ...WRITE, idempotentHint: true },
    },
    safe(async ({ site_url, sitemap_url }) => {
      await gapi(env, `${GSC}/sites/${site(site_url)}/sitemaps/${site(sitemap_url)}`, { method: "PUT" });
      return { submitted: sitemap_url };
    }),
  );
}
