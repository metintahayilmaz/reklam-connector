import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DELETE, READ, UPDATE, WRITE, safe } from "./util.js";
import type { Env } from "./index.js";

type Params = Record<string, unknown>;

class MetaClient {
  private base: string;
  constructor(private token: string, version: string) {
    this.base = `https://graph.facebook.com/${version}`;
  }

  private encode(params: Params): URLSearchParams {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      p.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    p.set("access_token", this.token);
    return p;
  }

  private async handle(res: Response) {
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || body.error) {
      const e = body.error ?? {};
      const hint =
        e.code === 190
          ? " (Token geçersiz/süresi dolmuş: META_ACCESS_TOKEN secret'ını yenileyin.)"
          : e.code === 17 || e.code === 80004
            ? " (Meta API hız limiti: biraz bekleyip tekrar deneyin.)"
            : e.code === 100
              ? " (Geçersiz parametre: alan adlarını ve ID'leri kontrol edin.)"
              : "";
      throw new Error(
        `Meta API ${res.status}: ${e.error_user_msg || e.message || "bilinmeyen hata"}` +
          (e.error_user_title ? ` [${e.error_user_title}]` : "") +
          (e.code ? ` (code ${e.code}${e.error_subcode ? "/" + e.error_subcode : ""})` : "") +
          hint,
      );
    }
    return body;
  }

  get(path: string, params: Params = {}) {
    return fetch(`${this.base}/${path}?${this.encode(params)}`).then((r) => this.handle(r));
  }
  post(path: string, params: Params = {}) {
    return fetch(`${this.base}/${path}`, { method: "POST", body: this.encode(params) }).then((r) => this.handle(r));
  }
  delete(path: string) {
    return fetch(`${this.base}/${path}?${this.encode({})}`, { method: "DELETE" }).then((r) => this.handle(r));
  }
}

const act = (id: string) => (id.startsWith("act_") ? id : `act_${id}`);

const page = (body: any) => ({
  data: body.data,
  next_cursor: body.paging?.next ? body.paging?.cursors?.after : undefined,
  ...(body.summary ? { summary: body.summary } : {}),
});

const status = z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]);
const limit = z.number().int().min(1).max(500).default(50).describe("Sayfa başına kayıt (1-500)");
const after = z.string().optional().describe("Önceki yanıttaki next_cursor değeri (sonraki sayfa için)");
const money = (what: string) =>
  z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `${what} — hesabın para biriminin EN KÜÇÜK biriminde (kuruş/cent). Örn: günlük 250 TL = 25000. Önce meta_list_ad_accounts ile para birimini kontrol edin.`,
    );

const CAMPAIGN_FIELDS = "id,name,status,effective_status,objective,daily_budget,lifetime_budget,budget_remaining,bid_strategy,start_time,stop_time,created_time";
const ADSET_FIELDS = "id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,optimization_goal,billing_event,bid_amount,bid_strategy,start_time,end_time,targeting";
const AD_FIELDS = "id,name,adset_id,campaign_id,status,effective_status,creative{id,name,thumbnail_url},created_time";
const INSIGHT_FIELDS = "campaign_name,adset_name,ad_name,impressions,reach,frequency,clicks,inline_link_clicks,ctr,cpc,cpm,spend,actions,cost_per_action_type,purchase_roas";

export function registerMetaTools(server: McpServer, env: Env) {
  if (!env.META_ACCESS_TOKEN) return;
  const meta = new MetaClient(env.META_ACCESS_TOKEN, env.META_API_VERSION || "v24.0");

  // ---------- Okuma ----------

  server.registerTool(
    "meta_list_ad_accounts",
    {
      title: "Meta reklam hesaplarını listele",
      description: "Token'ın erişebildiği tüm Meta (Facebook/Instagram) reklam hesaplarını; ID, ad, para birimi, saat dilimi, durum ve toplam harcama ile döndürür. Diğer Meta araçları için account_id buradan alınır.",
      inputSchema: {},
      annotations: READ,
    },
    safe(async () =>
      page(
        await meta.get("me/adaccounts", {
          fields: "id,name,account_status,currency,timezone_name,amount_spent,balance,spend_cap,business{id,name}",
          limit: 200,
        }),
      ),
    ),
  );

  server.registerTool(
    "meta_list_pages",
    {
      title: "Facebook sayfalarını listele",
      description: "Token'ın erişebildiği Facebook sayfalarını ve bağlı Instagram hesaplarını döndürür. Reklam kreatifi oluştururken page_id ve instagram_user_id buradan alınır.",
      inputSchema: {},
      annotations: READ,
    },
    safe(async () => page(await meta.get("me/accounts", { fields: "id,name,category,instagram_business_account{id,username}", limit: 100 }))),
  );

  server.registerTool(
    "meta_list_campaigns",
    {
      title: "Kampanyaları listele",
      description: "Bir reklam hesabındaki kampanyaları bütçe, hedef ve durum bilgileriyle listeler.",
      inputSchema: {
        account_id: z.string().describe("Reklam hesabı ID'si (act_123... veya 123...)"),
        statuses: z.array(z.enum(["ACTIVE", "PAUSED", "ARCHIVED", "DELETED", "WITH_ISSUES", "IN_PROCESS"])).optional().describe("effective_status filtresi. Boş = ARCHIVED/DELETED hariç hepsi"),
        limit,
        after,
      },
      annotations: READ,
    },
    safe(async ({ account_id, statuses, limit, after }) =>
      page(
        await meta.get(`${act(account_id)}/campaigns`, {
          fields: CAMPAIGN_FIELDS,
          effective_status: statuses,
          limit,
          after,
        }),
      ),
    ),
  );

  server.registerTool(
    "meta_list_adsets",
    {
      title: "Reklam setlerini listele",
      description: "Bir hesap veya kampanyadaki reklam setlerini (bütçe, hedefleme, optimizasyon) listeler. parent_id olarak act_ ile başlayan hesap ID'si ya da kampanya ID'si verin.",
      inputSchema: {
        parent_id: z.string().describe("Reklam hesabı (act_...) veya kampanya ID'si"),
        statuses: z.array(z.enum(["ACTIVE", "PAUSED", "ARCHIVED", "DELETED", "CAMPAIGN_PAUSED", "WITH_ISSUES"])).optional(),
        include_targeting: z.boolean().default(false).describe("Hedefleme detaylarını dahil et (yanıtı büyütür)"),
        limit,
        after,
      },
      annotations: READ,
    },
    safe(async ({ parent_id, statuses, include_targeting, limit, after }) =>
      page(
        await meta.get(`${parent_id}/adsets`, {
          fields: include_targeting ? ADSET_FIELDS : ADSET_FIELDS.replace(",targeting", ""),
          effective_status: statuses,
          limit,
          after,
        }),
      ),
    ),
  );

  server.registerTool(
    "meta_list_ads",
    {
      title: "Reklamları listele",
      description: "Bir hesap, kampanya veya reklam setindeki reklamları kreatif bilgisiyle listeler.",
      inputSchema: {
        parent_id: z.string().describe("Reklam hesabı (act_...), kampanya veya reklam seti ID'si"),
        statuses: z.array(z.enum(["ACTIVE", "PAUSED", "ARCHIVED", "DELETED", "ADSET_PAUSED", "CAMPAIGN_PAUSED", "DISAPPROVED", "PENDING_REVIEW", "WITH_ISSUES"])).optional(),
        limit,
        after,
      },
      annotations: READ,
    },
    safe(async ({ parent_id, statuses, limit, after }) =>
      page(await meta.get(`${parent_id}/ads`, { fields: AD_FIELDS, effective_status: statuses, limit, after })),
    ),
  );

  server.registerTool(
    "meta_get_object",
    {
      title: "Meta nesnesi getir",
      description: "Herhangi bir Meta nesnesini (kampanya, reklam seti, reklam, kreatif, hesap, sayfa) ID ile istenen alanlarla getirir.",
      inputSchema: {
        id: z.string(),
        fields: z.string().optional().describe("Virgülle ayrılmış alanlar, örn: 'id,name,status,daily_budget,targeting'"),
      },
      annotations: READ,
    },
    safe(({ id, fields }) => meta.get(id, { fields })),
  );

  server.registerTool(
    "meta_get_insights",
    {
      title: "Performans raporu (Insights)",
      description:
        "Hesap/kampanya/reklam seti/reklam için harcama, gösterim, tıklama, CTR, CPC, dönüşüm, ROAS vb. metrikleri döndürür. Kırılım (yaş, cinsiyet, platform, ülke) ve günlük zaman serisi desteklenir.",
      inputSchema: {
        object_id: z.string().describe("act_... hesap ID'si veya kampanya/reklam seti/reklam ID'si"),
        level: z.enum(["account", "campaign", "adset", "ad"]).optional().describe("Sonuçların gruplanacağı seviye. Örn: hesap ID'si + level=campaign = kampanya bazında tablo"),
        date_preset: z
          .enum(["today", "yesterday", "this_month", "last_month", "this_quarter", "maximum", "last_3d", "last_7d", "last_14d", "last_28d", "last_30d", "last_90d", "last_week_mon_sun", "this_week_mon_today", "last_year", "this_year"])
          .optional()
          .describe("Hazır tarih aralığı. since/until verilirse yok sayılır. İkisi de yoksa last_7d."),
        since: z.string().optional().describe("Başlangıç YYYY-MM-DD"),
        until: z.string().optional().describe("Bitiş YYYY-MM-DD"),
        time_increment: z.union([z.literal("monthly"), z.literal("all_days"), z.number().int().min(1).max(90)]).optional().describe("1 = günlük seri, 7 = haftalık, 'monthly' = aylık"),
        fields: z.string().optional().describe(`Virgülle ayrılmış metrikler. Varsayılan: ${INSIGHT_FIELDS}`),
        breakdowns: z
          .array(z.enum(["age", "gender", "country", "region", "publisher_platform", "platform_position", "device_platform", "impression_device", "hourly_stats_aggregated_by_advertiser_time_zone"]))
          .optional(),
        filtering: z.array(z.object({ field: z.string(), operator: z.string(), value: z.any() })).optional().describe("Örn: [{field:'campaign.effective_status',operator:'IN',value:['ACTIVE']}]"),
        sort: z.array(z.string()).optional().describe("Örn: ['spend_descending']"),
        limit,
        after,
      },
      annotations: READ,
    },
    safe(async (a) =>
      page(
        await meta.get(`${a.object_id}/insights`, {
          level: a.level,
          fields: a.fields || INSIGHT_FIELDS,
          ...(a.since && a.until ? { time_range: { since: a.since, until: a.until } } : { date_preset: a.date_preset || "last_7d" }),
          time_increment: a.time_increment,
          breakdowns: a.breakdowns?.join(","),
          filtering: a.filtering,
          sort: a.sort,
          limit: a.limit,
          after: a.after,
        }),
      ),
    ),
  );

  server.registerTool(
    "meta_search_targeting",
    {
      title: "Hedefleme seçeneklerini ara",
      description: "Reklam seti hedeflemesi için ilgi alanı, davranış, iş unvanı veya konum ID'lerini arar. Dönen id/name değerleri targeting JSON'unda kullanılır.",
      inputSchema: {
        type: z.enum(["adinterest", "adgeolocation", "adworkposition", "adeducationschool", "adlocale", "behaviors"]).describe("adinterest=ilgi alanı, adgeolocation=şehir/bölge/ülke, behaviors=davranışlar"),
        q: z.string().optional().describe("Arama terimi (behaviors için gerekmez)"),
        location_types: z.array(z.enum(["country", "region", "city", "zip", "neighborhood"])).optional().describe("adgeolocation için"),
        limit: z.number().int().min(1).max(100).default(25),
      },
      annotations: READ,
    },
    safe(async ({ type, q, location_types, limit }) => {
      if (type === "behaviors") return page(await meta.get("search", { type: "adTargetingCategory", class: "behaviors", limit }));
      return page(await meta.get("search", { type, q, location_types, limit }));
    }),
  );

  server.registerTool(
    "meta_estimate_reach",
    {
      title: "Erişim tahmini",
      description: "Verilen hedefleme için tahmini kitle büyüklüğünü döndürür. Reklam seti oluşturmadan önce hedeflemeyi doğrulamak için kullanın.",
      inputSchema: {
        account_id: z.string(),
        targeting: z.record(z.string(), z.any()).describe("Targeting spec JSON, örn: {geo_locations:{countries:['TR']},age_min:25,age_max:45}"),
        optimization_goal: z.string().optional().describe("Örn: LINK_CLICKS, REACH, OFFSITE_CONVERSIONS"),
      },
      annotations: READ,
    },
    safe(({ account_id, targeting, optimization_goal }) =>
      meta.get(`${act(account_id)}/delivery_estimate`, { targeting_spec: targeting, optimization_goal: optimization_goal || "REACH" }),
    ),
  );

  server.registerTool(
    "meta_list_instagram_accounts",
    {
      title: "Instagram hesaplarını listele",
      description:
        "Reklam hesabında reklam yayınlamak için kullanılabilen Instagram hesaplarını ve her Facebook sayfasına bağlı Instagram hesabını kontrol eder. Kreatiflerdeki instagram_user_id buradan alınır. Boş dönerse hesap sayfaya bağlı değildir veya sistem kullanıcısına atanmamıştır.",
      inputSchema: { account_id: z.string() },
      annotations: READ,
    },
    safe(async ({ account_id }) => {
      const [adAccount, pages] = await Promise.allSettled([
        meta.get(`${act(account_id)}/instagram_accounts`, { fields: "id,username" }),
        meta.get("me/accounts", { fields: "id,name,instagram_business_account{id,username},connected_instagram_account{id,username}", limit: 100 }),
      ]);
      const err = (r: PromiseRejectedResult) => String(r.reason?.message ?? r.reason);
      return {
        ad_account_instagram_accounts: adAccount.status === "fulfilled" ? adAccount.value.data : { error: err(adAccount) },
        page_links: pages.status === "fulfilled" ? pages.value.data : { error: err(pages) },
      };
    }),
  );

  server.registerTool(
    "meta_list_audiences",
    {
      title: "Özel kitleleri listele",
      description: "Reklam hesabındaki özel (custom) ve benzer (lookalike) kitleleri listeler. Hedeflemede custom_audiences için ID'ler buradan alınır.",
      inputSchema: { account_id: z.string(), limit, after },
      annotations: READ,
    },
    safe(async ({ account_id, limit, after }) =>
      page(
        await meta.get(`${act(account_id)}/customaudiences`, {
          fields: "id,name,subtype,approximate_count_lower_bound,approximate_count_upper_bound,delivery_status,time_created",
          limit,
          after,
        }),
      ),
    ),
  );

  server.registerTool(
    "meta_list_pixels",
    {
      title: "Pikselleri listele",
      description: "Reklam hesabına bağlı Meta pikselleri (dataset) listeler. Dönüşüm kampanyalarında promoted_object.pixel_id için kullanılır.",
      inputSchema: { account_id: z.string() },
      annotations: READ,
    },
    safe(async ({ account_id }) => page(await meta.get(`${act(account_id)}/adspixels`, { fields: "id,name,last_fired_time" }))),
  );

  // ---------- Oluşturma ----------

  server.registerTool(
    "meta_create_campaign",
    {
      title: "Kampanya oluştur",
      description:
        "Yeni kampanya oluşturur. Güvenlik için varsayılan durum PAUSED'dır; yayına almak için meta_set_status kullanın. Kampanya bütçesi (CBO) için daily_budget veya lifetime_budget verin; vermezseniz bütçe reklam seti seviyesinde belirlenir.",
      inputSchema: {
        account_id: z.string(),
        name: z.string(),
        objective: z.enum(["OUTCOME_AWARENESS", "OUTCOME_TRAFFIC", "OUTCOME_ENGAGEMENT", "OUTCOME_LEADS", "OUTCOME_APP_PROMOTION", "OUTCOME_SALES"]),
        status: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED"),
        special_ad_categories: z.array(z.enum(["NONE", "EMPLOYMENT", "HOUSING", "CREDIT", "ISSUES_ELECTIONS_POLITICS", "ONLINE_GAMBLING_AND_GAMING", "FINANCIAL_PRODUCTS_SERVICES"])).default([]),
        daily_budget: money("Kampanya günlük bütçesi (CBO)"),
        lifetime_budget: money("Kampanya toplam bütçesi (CBO, stop_time gerekir)"),
        bid_strategy: z.enum(["LOWEST_COST_WITHOUT_CAP", "LOWEST_COST_WITH_BID_CAP", "COST_CAP", "LOWEST_COST_WITH_MIN_ROAS"]).optional(),
        start_time: z.string().optional().describe("ISO 8601, örn 2026-11-01T09:00:00+0300"),
        stop_time: z.string().optional(),
      },
      annotations: WRITE,
    },
    safe(async ({ account_id, ...rest }) => {
      const res = await meta.post(`${act(account_id)}/campaigns`, rest);
      return { ...res, note: `Kampanya ${rest.status} durumunda oluşturuldu.` };
    }),
  );

  server.registerTool(
    "meta_create_adset",
    {
      title: "Reklam seti oluştur",
      description:
        "Kampanyaya reklam seti ekler (hedefleme, bütçe, optimizasyon, yerleşim). Varsayılan durum PAUSED. Kampanyada CBO yoksa daily_budget veya lifetime_budget zorunludur. Hedefleme ID'leri için meta_search_targeting kullanın.",
      inputSchema: {
        account_id: z.string(),
        campaign_id: z.string(),
        name: z.string(),
        targeting: z
          .record(z.string(), z.any())
          .describe(
            "Targeting spec. Örn: {geo_locations:{countries:['TR'],cities:[{key:'2347399'}]},age_min:25,age_max:54,genders:[2],flexible_spec:[{interests:[{id:'6003139266461',name:'Kahve'}]}],publisher_platforms:['facebook','instagram']}. Yerleşimleri belirtmezseniz Advantage+ yerleşim kullanılır.",
          ),
        optimization_goal: z
          .enum(["REACH", "IMPRESSIONS", "LINK_CLICKS", "LANDING_PAGE_VIEWS", "OFFSITE_CONVERSIONS", "LEAD_GENERATION", "POST_ENGAGEMENT", "THRUPLAY", "CONVERSATIONS", "VALUE", "APP_INSTALLS", "PROFILE_VISIT"])
          .describe("Kampanya hedefiyle uyumlu olmalı"),
        billing_event: z.enum(["IMPRESSIONS", "LINK_CLICKS", "THRUPLAY"]).default("IMPRESSIONS"),
        daily_budget: money("Reklam seti günlük bütçesi"),
        lifetime_budget: money("Reklam seti toplam bütçesi (end_time gerekir)"),
        bid_amount: money("Teklif tavanı (bid cap / cost cap stratejilerinde)"),
        bid_strategy: z.enum(["LOWEST_COST_WITHOUT_CAP", "LOWEST_COST_WITH_BID_CAP", "COST_CAP", "LOWEST_COST_WITH_MIN_ROAS"]).optional(),
        promoted_object: z.record(z.string(), z.any()).optional().describe("Dönüşüm/lead için. Örn: {pixel_id:'123',custom_event_type:'PURCHASE'} veya {page_id:'123'}"),
        destination_type: z.enum(["WEBSITE", "MESSENGER", "WHATSAPP", "INSTAGRAM_DIRECT", "ON_AD", "APP"]).optional(),
        start_time: z.string().optional().describe("ISO 8601"),
        end_time: z.string().optional().describe("ISO 8601"),
        status: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED"),
      },
      annotations: WRITE,
    },
    safe(async ({ account_id, ...rest }) => meta.post(`${act(account_id)}/adsets`, rest)),
  );

  server.registerTool(
    "meta_upload_image",
    {
      title: "Reklam görseli yükle",
      description: "Herkese açık bir URL'deki görseli reklam hesabının görsel kütüphanesine yükler ve image_hash döndürür. Hash, meta_create_ad_creative'de kullanılır.",
      inputSchema: {
        account_id: z.string(),
        image_url: z.string().url().describe("JPG/PNG görselin herkese açık URL'si"),
        name: z.string().optional(),
      },
      annotations: WRITE,
    },
    safe(async ({ account_id, image_url, name }) => {
      const res = await fetch(image_url);
      if (!res.ok) throw new Error(`Görsel indirilemedi (${res.status}): ${image_url}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > 30 * 1024 * 1024) throw new Error("Görsel 30 MB sınırını aşıyor.");
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      const out = await meta.post(`${act(account_id)}/adimages`, { bytes: btoa(bin), name: name || image_url.split("/").pop() });
      const img: any = Object.values(out.images ?? {})[0];
      return { image_hash: img?.hash, url: img?.url, raw: out };
    }),
  );

  server.registerTool(
    "meta_create_ad_creative",
    {
      title: "Reklam kreatifi oluştur",
      description:
        "Tek görselli veya videolu link reklamı kreatifi oluşturur. Görsel için image_hash (meta_upload_image) ya da video_id verin. Karmaşık formatlar (carousel, dinamik kreatif) için object_story_spec'i doğrudan verin.",
      inputSchema: {
        account_id: z.string(),
        name: z.string(),
        page_id: z.string().describe("meta_list_pages'den Facebook sayfa ID'si"),
        instagram_user_id: z.string().optional().describe("Instagram'da yayınlamak için IG hesap ID'si (meta_list_pages > instagram_business_account.id)"),
        link: z.string().url().optional().describe("Hedef URL"),
        message: z.string().optional().describe("Ana metin (birincil metin)"),
        headline: z.string().optional().describe("Başlık"),
        description: z.string().optional().describe("Açıklama"),
        image_hash: z.string().optional(),
        video_id: z.string().optional(),
        video_thumbnail_url: z.string().url().optional().describe("Videolu reklamlarda kapak görseli"),
        call_to_action: z.enum(["LEARN_MORE", "SHOP_NOW", "SIGN_UP", "CONTACT_US", "BOOK_TRAVEL", "GET_OFFER", "ORDER_NOW", "SUBSCRIBE", "DOWNLOAD", "WHATSAPP_MESSAGE", "MESSAGE_PAGE", "CALL_NOW", "APPLY_NOW", "GET_QUOTE"]).default("LEARN_MORE"),
        object_story_spec: z.record(z.string(), z.any()).optional().describe("İleri düzey: verilirse diğer kreatif alanları yok sayılır"),
      },
      annotations: WRITE,
    },
    safe(async (a) => {
      let spec = a.object_story_spec;
      if (!spec) {
        const cta = { type: a.call_to_action, ...(a.link ? { value: { link: a.link } } : {}) };
        spec = a.video_id
          ? { page_id: a.page_id, video_data: { video_id: a.video_id, message: a.message, title: a.headline, link_description: a.description, image_url: a.video_thumbnail_url, call_to_action: cta } }
          : { page_id: a.page_id, link_data: { link: a.link, message: a.message, name: a.headline, description: a.description, image_hash: a.image_hash, call_to_action: cta } };
        if (a.instagram_user_id) spec.instagram_user_id = a.instagram_user_id;
      }
      return meta.post(`${act(a.account_id)}/adcreatives`, { name: a.name, object_story_spec: spec });
    }),
  );

  server.registerTool(
    "meta_create_ad",
    {
      title: "Reklam oluştur",
      description: "Bir reklam setine, mevcut bir kreatifle reklam ekler. Varsayılan durum PAUSED. Oluşturulan reklam Meta incelemesinden geçer.",
      inputSchema: {
        account_id: z.string(),
        adset_id: z.string(),
        creative_id: z.string().describe("meta_create_ad_creative'den dönen ID"),
        name: z.string(),
        status: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED"),
      },
      annotations: WRITE,
    },
    safe(({ account_id, adset_id, creative_id, name, status }) =>
      meta.post(`${act(account_id)}/ads`, { adset_id, creative: { creative_id }, name, status }),
    ),
  );

  server.registerTool(
    "meta_duplicate",
    {
      title: "Kampanya/reklam seti/reklam kopyala",
      description: "Bir kampanyayı, reklam setini veya reklamı (isteğe bağlı alt nesneleriyle) kopyalar. Kopyalar PAUSED oluşturulur.",
      inputSchema: {
        id: z.string(),
        deep_copy: z.boolean().default(true).describe("Alt nesneleri de kopyala (kampanya → reklam setleri → reklamlar)"),
        rename_suffix: z.string().default(" - Kopya"),
        target_parent_id: z.string().optional().describe("Reklam seti kopyalanırken hedef campaign_id, reklam kopyalanırken hedef adset_id"),
      },
      annotations: WRITE,
    },
    safe(async ({ id, deep_copy, rename_suffix, target_parent_id }) => {
      const obj = await meta.get(id, { metadata: 1, fields: "id" });
      const type: string = obj.metadata?.type;
      const parentKey = type === "adset" ? "campaign_id" : type === "ad" ? "adset_id" : undefined;
      return meta.post(`${id}/copies`, {
        deep_copy: type === "ad" ? undefined : deep_copy,
        status_option: "PAUSED",
        rename_options: { rename_suffix },
        ...(parentKey && target_parent_id ? { [parentKey]: target_parent_id } : {}),
      });
    }),
  );

  // ---------- Güncelleme / silme ----------

  server.registerTool(
    "meta_set_status",
    {
      title: "Durumu değiştir (yayınla/durdur/arşivle)",
      description: "Bir veya birden çok kampanya, reklam seti veya reklamı ACTIVE (yayına al), PAUSED (durdur) veya ARCHIVED yapar. ACTIVE yapmak gerçek harcama başlatır.",
      inputSchema: { ids: z.array(z.string()).min(1).max(50), status },
      annotations: UPDATE,
    },
    safe(async ({ ids, status }) => {
      const results = await Promise.allSettled(ids.map((id) => meta.post(id, { status })));
      return results.map((r, i) => ({ id: ids[i], ok: r.status === "fulfilled", error: r.status === "rejected" ? String(r.reason?.message ?? r.reason) : undefined }));
    }),
  );

  server.registerTool(
    "meta_update",
    {
      title: "Kampanya/reklam seti/reklam güncelle",
      description:
        "Bir nesnenin alanlarını günceller: ad, bütçe, teklif, bitiş tarihi, hedefleme, kreatif vb. Bütçeler en küçük para biriminde (kuruş). Hedefleme verilirse mevcut hedeflemenin TAMAMI değiştirilir; önce meta_get_object ile mevcut hedeflemeyi okuyun.",
      inputSchema: {
        id: z.string(),
        name: z.string().optional(),
        daily_budget: money("Yeni günlük bütçe"),
        lifetime_budget: money("Yeni toplam bütçe"),
        bid_amount: money("Yeni teklif tutarı"),
        bid_strategy: z.enum(["LOWEST_COST_WITHOUT_CAP", "LOWEST_COST_WITH_BID_CAP", "COST_CAP", "LOWEST_COST_WITH_MIN_ROAS"]).optional(),
        end_time: z.string().optional().describe("Reklam seti bitişi, ISO 8601"),
        stop_time: z.string().optional().describe("Kampanya bitişi, ISO 8601"),
        targeting: z.record(z.string(), z.any()).optional(),
        creative_id: z.string().optional().describe("Reklamın kreatifini değiştirmek için"),
        extra: z.record(z.string(), z.any()).optional().describe("Yukarıda olmayan diğer API alanları"),
      },
      annotations: UPDATE,
    },
    safe(async ({ id, creative_id, extra, ...fields }) => {
      const params: Params = { ...fields, ...extra };
      if (creative_id) params.creative = { creative_id };
      if (Object.values(params).every((v) => v === undefined)) throw new Error("Güncellenecek en az bir alan verin.");
      const res = await meta.post(id, params);
      return { ...res, updated_fields: Object.keys(params).filter((k) => params[k] !== undefined) };
    }),
  );

  server.registerTool(
    "meta_delete",
    {
      title: "Sil",
      description: "Bir kampanya, reklam seti, reklam veya kreatifi KALICI olarak siler (geri alınamaz). Geçmiş raporları korumak için genelde meta_set_status ile ARCHIVED tercih edin.",
      inputSchema: { id: z.string() },
      annotations: DELETE,
    },
    safe(({ id }) => meta.delete(id)),
  );
}
