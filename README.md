# Reklam Connector

Kendi barındırdığın, Windsor.ai benzeri bir MCP connector'ı. Claude'a şu erişimleri verir:

- **Meta Ads (Facebook/Instagram):** Raporlama ve kampanya, reklam seti, reklam, kreatif yönetimi (20 araç)
- **Google Analytics 4:** Raporlar, gerçek zamanlı veri, boyut ve metrik listesi
- **Google Search Console:** Arama performansı, URL denetimi, site haritaları

Cloudflare Workers üzerinde çalışır. Ücretsiz katman (günde 100.000 istek) bireysel kullanım için fazlasıyla yeter.

## Araçlar

| Alan | Okuma | Yazma |
|---|---|---|
| Meta | `meta_list_ad_accounts`, `meta_list_pages`, `meta_list_campaigns`, `meta_list_adsets`, `meta_list_ads`, `meta_get_object`, `meta_get_insights`, `meta_search_targeting`, `meta_estimate_reach`, `meta_list_audiences`, `meta_list_pixels` | `meta_create_campaign`, `meta_create_adset`, `meta_upload_image`, `meta_create_ad_creative`, `meta_create_ad`, `meta_duplicate`, `meta_set_status`, `meta_update`, `meta_delete` |
| GA4 | `ga4_list_properties`, `ga4_run_report`, `ga4_run_realtime_report`, `ga4_get_metadata` | — |
| Search Console | `gsc_list_sites`, `gsc_search_analytics`, `gsc_inspect_url`, `gsc_list_sitemaps` | `gsc_submit_sitemap` |

Güvenlik önlemleri:
- Yeni oluşturulan her şey varsayılan olarak **PAUSED** durumdadır.
- Harcamayı etkileyen araçlar `destructiveHint` ile işaretlidir. Claude bu araçları çalıştırmadan önce senden onay ister.

---

## Kurulum

### 1) Meta erişim token'ı (yaklaşık 10 dakika)

1. [developers.facebook.com](https://developers.facebook.com/apps) → **Create App** → tür olarak **Business** seç ve uygulamayı Business Portfolio'na bağla.
2. Uygulama panelinde **Marketing API** ürününü ekle.
3. [business.facebook.com](https://business.facebook.com/settings) → **Ayarlar → Kullanıcılar → Sistem Kullanıcıları** → **Ekle** → rol olarak **Admin** seç.
4. Sistem kullanıcısına **Varlık ata**:
   - Reklam hesapları için **Tam kontrol** ver.
   - Facebook sayfaları için reklam oluşturma yetkisi ver.
5. **Token oluştur**:
   - Uygulamanı seç.
   - Süre olarak **Süresiz** (Never expire) seç.
   - Şu izinleri işaretle: `ads_management`, `ads_read`, `business_management`, `pages_show_list`, `pages_read_engagement`, `pages_manage_ads`, `instagram_basic`.
6. Oluşan token'ı kopyala. Bu token **META_ACCESS_TOKEN** olacak.

### 2) Google servis hesabı (yaklaşık 10 dakika)

1. [console.cloud.google.com](https://console.cloud.google.com) → yeni bir proje oluştur.
2. **APIs & Services → Library** bölümünden şu üç API'yi etkinleştir:
   - Google Analytics Data API
   - Google Analytics Admin API
   - Google Search Console API
3. **IAM & Admin → Service Accounts → Create** ile bir servis hesabı oluştur (rol vermen gerekmez).
4. Servis hesabı → **Keys → Add key → JSON** ile anahtarı indir.
5. Servis hesabının e-posta adresini (`...@...iam.gserviceaccount.com`) iki yere ekle:
   - **GA4:** Yönetici → Mülk erişim yönetimi → **Görüntüleyici**
   - **Search Console:** Ayarlar → Kullanıcılar ve izinler → **Tam** (site haritası göndermek için **Sahip** gerekebilir)

### 3) Cloudflare'e yükle

Bilgisayarında Node.js 18 veya üstü kurulu olmalı. Ardından:

```bash
npm install
npx wrangler login                      # tarayıcıda Cloudflare hesabına giriş (ücretsiz hesap yeterli)

# Connector URL'sinin gizli anahtarı. Çıktıyı bir yere not et.
openssl rand -hex 32
npx wrangler secret put MCP_SECRET                     # üstteki değeri yapıştır
npx wrangler secret put META_ACCESS_TOKEN              # Meta token'ını yapıştır
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON < servis-hesabi.json

npx wrangler deploy
```

Deploy çıktısında `https://reklam-connector.<hesabin>.workers.dev` gibi bir adres görürsün. Kontrol için:
`https://reklam-connector.<hesabin>.workers.dev/health` adresi `{"ok":true,"meta":true,"google":true}` döndürmeli.

### 4) Claude'a ekle

claude.ai → **Ayarlar → Connectors → Add custom connector**:

- **Ad:** Reklam Connector
- **URL:** `https://reklam-connector.<hesabin>.workers.dev/mcp`
- **Kimlik doğrulama:** Oturum açma yok
- **İstek başlıkları → Başlık ekle:** ad `Authorization`, değer `Bearer <MCP_SECRET>`

Connector web, mobil ve Claude Code'da kullanılabilir hale gelir.

İstek başlığı eklenemeyen istemciler için anahtar adresin içinde de verilebilir: `https://reklam-connector.<hesabin>.workers.dev/mcp/<MCP_SECRET>`. Ancak bu yöntemde anahtar ekran görüntülerinde ve geçmişte görünür.

> ⚠️ MCP_SECRET bir şifre gibidir. Bilen herkes reklam hesaplarını yönetebilir, o yüzden kimseyle paylaşma. Sızarsa `npx wrangler secret put MCP_SECRET` ile yeni bir anahtar ver ve connector'ı güncelle.

---

## Örnek komutlar

- "Geçen ayın kampanya bazında harcama ve ROAS tablosunu çıkar"
- "Son 7 günde CPC'si 5 TL'yi geçen reklam setlerini durdur"
- "Instagram için İstanbul'daki 25-40 yaş kadınlara yönelik, günlük 300 TL'lik bir trafik kampanyası kur (paused)"
- "GA4'te Meta'dan gelen oturumların dönüşüm oranı ne?"
- "Search Console'da gösterimi yüksek ama CTR'si %1'in altında olan sayfaları listele"

## Notlar

- Meta bütçeleri **kuruş cinsindendir**: 250 TL = `25000`. Claude bu kuralı sunucu talimatlarından okur.
- Meta API sürümünü `wrangler.toml` dosyasındaki `META_API_VERSION` ile değiştirebilirsin.
- Sadece Meta veya sadece Google kullanmak istersen, kullanmayacağın secret'ı hiç tanımlama. O platformun araçları otomatik olarak gizlenir.
- Yerel geliştirme için `.dev.vars` dosyasına secret'ları yaz ve `npm run dev` ile çalıştır.
