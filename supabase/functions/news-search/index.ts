// بحث «ارصد الآن»
// - الصحف: Google News RSS (مجاني، بدون مفتاح) — { queries: [{ q, lang }], from, to }
// - السوشيال: { mode: "social", keywords: [{ kw, ctx }], from, to } عبر Tavily (TAVILY_API_KEY) أو Serper (SERPER_API_KEY)
//   بدون مفتاح يرجع { needKey: true }
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


const SM_DOMAINS = ["x.com", "twitter.com", "instagram.com", "facebook.com"];
const pfOf = (u: string) => { try { const h = new URL(u).hostname; return /(^|\.)(x|twitter)\.com$/.test(h) ? "x" : /instagram\.com$/.test(h) ? "ig" : /facebook\.com$/.test(h) ? "fb" : ""; } catch { return ""; } };
const gd = (d: string) => { const [y, m, dd] = d.split("-"); return `${+m}/${+dd}/${y}`; };
function batches(kws: { kw: string; ctx: boolean }[]) {
  const out: { q: string; kws: string[] }[] = [];
  let cur: string[] = [], q = "";
  for (const k of kws) {
    const t = (/\s/.test(k.kw) ? `"${k.kw}"` : k.kw) + (k.ctx ? " Bahrain" : "");
    const term = k.ctx ? `(${t})` : t;
    const n = q ? q + " OR " + term : term;
    if (n.length > 300 && cur.length) { out.push({ q, kws: cur }); cur = []; q = term; } else q = n;
    cur.push(k.kw);
  }
  if (cur.length) out.push({ q, kws: cur });
  return out;
}
const IG_ABC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
// تاريخ النشر من الرابط نفسه: معرّف تغريدة إكس ومعرّف منشور إنستغرام يحملان وقت النشر
function dateFromUrl(u: string): string {
  try {
    const x = u.match(/(?:x|twitter)\.com\/[^/]+\/status(?:es)?\/(\d{15,20})/);
    if (x) return new Date(Number((BigInt(x[1]) >> 22n) + 1288834974657n)).toISOString();
    const ig = u.match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{6,})/);
    if (ig) { let id = 0n; for (const c of ig[1].slice(0, 11)) { const i = IG_ABC.indexOf(c); if (i < 0) return ""; id = id * 64n + BigInt(i); }
      const ms = Number((id >> 23n) + 1314220021721n); if (ms > 1.3e12 && ms < Date.now() + 864e5) return new Date(ms).toISOString(); }
  } catch { /* */ }
  return "";
}
const bhDay = (iso: string) => new Date(new Date(iso).getTime() + 3 * 3600e3).toISOString().slice(0, 10);
async function socialSearch(kws: { kw: string; ctx: boolean }[], from: string, to: string) {
  const tav = Deno.env.get("TAVILY_API_KEY"), ser = Deno.env.get("SERPER_API_KEY");
  if (!tav && !ser) return { needKey: true, items: [] };
  const seen = new Set<string>(); const items: any[] = [];
  const pick = (title: string, text: string, list: string[]) => { const s = (title + " " + text).toLowerCase(); return list.find((k) => s.includes(k.toLowerCase())) || list[0]; };
  await Promise.all(batches(kws.slice(0, 40)).slice(0, 8).map(async (b) => {
    try {
      let rows: { title: string; link: string; snippet: string; date: string }[] = [];
      if (tav) {
        const r = await fetch("https://api.tavily.com/search", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tav}` },
          body: JSON.stringify({ query: b.q, search_depth: "basic", max_results: 20, include_domains: SM_DOMAINS, start_date: from, end_date: addDay(to) }) });
        if (!r.ok) return;
        const j = await r.json();
        rows = (j.results || []).map((x: any) => ({ title: x.title || "", link: x.url || "", snippet: x.content || "", date: x.published_date || "" }));
      } else {
        const r = await fetch("https://google.serper.dev/search", { method: "POST", headers: { "Content-Type": "application/json", "X-API-KEY": ser! },
          body: JSON.stringify({ q: `(${b.q}) (site:x.com OR site:instagram.com OR site:facebook.com)`, gl: "bh", num: 20, tbs: `cdr:1,cd_min:${gd(from)},cd_max:${gd(to)}` }) });
        if (!r.ok) return;
        const j = await r.json();
        rows = (j.organic || []).map((x: any) => ({ title: x.title || "", link: x.link || "", snippet: x.snippet || "", date: x.date || "" }));
      }
      for (const x of rows) {
        const platform = pfOf(x.link);
        if (!platform || seen.has(x.link)) continue;
        seen.add(x.link);
        let pub = dateFromUrl(x.link);
        if (!pub) { try { if (x.date) { const d = new Date(x.date); if (!isNaN(+d)) pub = d.toISOString(); } } catch { /* */ } }
        if (pub) { const day = bhDay(pub); if (day < from || day > to) continue; }
        items.push({ title: x.title.replace(/\s*[|·-]\s*(Instagram|Facebook|X)\s*$/i, ""), link: x.link, snippet: x.snippet.slice(0, 400), pubDate: pub, platform, kw: pick(x.title, x.snippet, b.kws) });
      }
    } catch { /* تجاهل */ }
  }));
  return { items, provider: tav ? "tavily" : "serper" };
}

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
  if (body.mode === "social") {
    const kws = (Array.isArray(body.keywords) ? body.keywords : []).filter((k: any) => k && typeof k.kw === "string" && k.kw.trim()).map((k: any) => ({ kw: String(k.kw).slice(0, 80), ctx: !!k.ctx }));
    return json({ ...(await socialSearch(kws, from, to)), from, to });
  }
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
