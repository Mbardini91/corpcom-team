// بحث الأخبار لزر «ارصد الآن» — عبر Google News RSS (مجاني، بدون مفتاح)
// المدخلات: { queries: [{ q, lang: "ar"|"en" }], from: "YYYY-MM-DD", to: "YYYY-MM-DD" }
// متاح فقط لأعضاء الفريق المسجّلين (team_access) — منشورة باسم news-search (verify_jwt = true)
import { createClient } from "jsr:@supabase/supabase-js@2";

const ORIGINS = ["https://corpcom-team.vercel.app", "http://localhost:8766", "http://localhost:8767"];
const cors = (o: string | null) => ({
  "Access-Control-Allow-Origin": o && ORIGINS.includes(o) ? o : ORIGINS[0],
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Vary": "Origin",
});

const ent = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const tag = (x: string, t: string) => { const m = x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return m ? ent(m[1]).trim() : ""; };
const addDay = (d: string) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };

Deno.serve(async (req) => {
  const h = cors(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: h });
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...h, "Content-Type": "application/json" } });

  const auth = req.headers.get("Authorization") || "";
  const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
  const { data: ok } = await userClient.rpc("is_member");
  if (!ok) return json({ error: "not_member" }, 403);

  let body: any = {};
  try { body = await req.json(); } catch { /* */ }
  const from = /^\d{4}-\d{2}-\d{2}$/.test(body.from) ? body.from : new Date().toISOString().slice(0, 10);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(body.to) ? body.to : from;
  const queries = (Array.isArray(body.queries) ? body.queries : []).slice(0, 30);

  const seen = new Set<string>();
  const items: any[] = [];
  await Promise.all(queries.map(async (qq: any, qi: number) => {
    const lang = qq.lang === "en" ? "en" : "ar";
    const q = `${String(qq.q || "").slice(0, 400)} after:${from} before:${addDay(to)}`;
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${lang === "ar" ? "ar" : "en-BH"}&gl=BH&ceid=BH:${lang}`;
    try {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; LMRA-monitor/1.0)" } });
      if (!r.ok) return;
      const xml = await r.text();
      for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const it = m[1];
        const src = it.match(/<source url="([^"]*)">([\s\S]*?)<\/source>/);
        const source = src ? ent(src[2]).trim() : "";
        let title = tag(it, "title");
        if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));
        const link = tag(it, "link");
        const key = title.replace(/\s+/g, " ").toLowerCase();
        if (!title || seen.has(key)) continue;
        seen.add(key);
        const pub = tag(it, "pubDate");
        items.push({ title, link, source, sourceUrl: src ? src[1] : "", pubDate: pub ? new Date(pub).toISOString() : "", q: qi });
      }
    } catch { /* تجاهل الاستعلام الفاشل */ }
  }));
  items.sort((a, b) => (b.pubDate || "").localeCompare(a.pubDate || ""));
  return json({ items, from, to });
});
