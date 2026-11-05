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
// ملخص وافٍ لا يتجاوز 80 كلمة: جمل كاملة من مقدمة الخبر/المنشور (الهرم المقلوب)
function sum80(raw: string, fallback = ""): string {
  const clean = (s: string) => s.replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, " ")
    .replace(/[#*_>|`]+/g, " ").replace(/\s+/g, " ").trim();
  const junk = /cookie|subscribe|اشترك|حقوق النشر|copyright|اقرأ أيضا|اقرأ أيضًا|read more|تابعونا|follow us|log in|sign up|تسجيل الدخول/i;
  let paras: string[] = [];
  if (raw) paras = raw.split(/\n+/).map(clean).filter((x) => x.split(" ").length >= 10 && !junk.test(x));
  if (!paras.length && fallback) paras = [clean(fallback)];
  const sents = paras.join(" ").split(/(?<=[.!?؟。])\s+/).map((x) => x.trim()).filter(Boolean);
  const out: string[] = []; let n = 0;
  for (const s of sents) { const w = s.split(" ").length; if (n + w > 80) { if (!out.length) { out.push(s.split(" ").slice(0, 80).join(" ") + "…"); } break; } out.push(s); n += w; if (n >= 65) break; }
  return out.join(" ");
}
const bhDay = (iso: string) => new Date(new Date(iso).getTime() + 3 * 3600e3).toISOString().slice(0, 10);
async function socialSearch(kws: { kw: string; ctx: boolean }[], from: string, to: string, pfs: string[] = ["x", "ig", "fb"]) {
  const tav = Deno.env.get("TAVILY_API_KEY"), ser = Deno.env.get("SERPER_API_KEY");
  if (!tav && !ser) return { needKey: true, items: [] };
  const seen = new Set<string>(); const items: any[] = [];
  const norm = (s: string) => s.toLowerCase().replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/[\u064B-\u0652]/g, "");
  const BH = /بحرين|bahrain|manama|المنامة|المحرق|lmra/i;
  const ctxOf = new Map(kws.map((k) => [k.kw, k.ctx]));
  // أدق: يجب أن تظهر كل كلمات العبارة المفتاحية في النص، والعبارات العامة تتطلب ذكر البحرين
  const pick = (title: string, text: string, list: string[]) => { const s = norm(title + " " + text);
    return list.find((k) => norm(k).split(/\s+/).filter((w) => w.length > 1 && w !== "البحرين" && w !== "bahrain").every((w) => s.includes(w)) && (!(ctxOf.get(k) || /البحرين|bahrain/i.test(k)) || BH.test(title + " " + text))) || ""; };
  const domains = SM_DOMAINS.filter((d) => pfs.includes(pfOf("https://" + d + "/")));
  await Promise.all(batches(kws.slice(0, 40)).slice(0, 8).map(async (b) => {
    try {
      let rows: { title: string; link: string; snippet: string; date: string }[] = [];
      if (tav) {
        const r = await fetch("https://api.tavily.com/search", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tav}` },
          body: JSON.stringify({ query: b.q, search_depth: "basic", max_results: 20, include_domains: domains, start_date: from, end_date: addDay(to), include_raw_content: true }) });
        if (!r.ok) return;
        const j = await r.json();
        rows = (j.results || []).map((x: any) => ({ title: x.title || "", link: x.url || "", snippet: sum80(x.raw_content || "", x.content || ""), date: x.published_date || "" }));
      } else {
        const r = await fetch("https://google.serper.dev/search", { method: "POST", headers: { "Content-Type": "application/json", "X-API-KEY": ser! },
          body: JSON.stringify({ q: `(${b.q}) (${domains.map((d) => "site:" + d).join(" OR ")})`, gl: "bh", num: 20, tbs: `cdr:1,cd_min:${gd(from)},cd_max:${gd(to)}` }) });
        if (!r.ok) return;
        const j = await r.json();
        rows = (j.organic || []).map((x: any) => ({ title: x.title || "", link: x.link || "", snippet: x.snippet || "", date: x.date || "" }));
      }
      for (const x of rows) {
        const platform = pfOf(x.link);
        if (!platform || !pfs.includes(platform) || seen.has(x.link)) continue;
        const kw = pick(x.title, x.snippet, b.kws);
        if (!kw) continue;
        seen.add(x.link);
        let pub = dateFromUrl(x.link);
        if (!pub) { try { if (x.date) { const d = new Date(x.date); if (!isNaN(+d)) pub = d.toISOString(); } } catch { /* */ } }
        if (!pub) continue; // بدون تاريخ مؤكد لا يُعرض
        { const day = bhDay(pub); if (day < from || day > to) continue; }
        items.push({ title: x.title.replace(/\s*[|·-]\s*(Instagram|Facebook|X)\s*$/i, ""), link: x.link, snippet: sum80("", x.snippet), pubDate: pub, platform, kw });
      }
    } catch { /* تجاهل */ }
  }));
  return { items, provider: tav ? "tavily" : "serper" };
}

// رصد مباشر لحسابات إنستغرام المدرجة عبر Apify (APIFY_TOKEN) — تشغيل غير متزامن ثم استعلام عن النتيجة
const ACTOR = "sones~instagram-posts-scraper-lowcost";
async function accStart(handles: string[], from: string, to: string) {
  const tok = Deno.env.get("APIFY_TOKEN");
  if (!tok) return { needKey: true };
  const days = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1);
  const input = { usernames: handles.slice(0, 80), postsPerProfile: Math.min(30, Math.max(6, days * 4)), newerThan: `${from}T00:00:00+03:00` };
  const r = await fetch(`https://api.apify.com/v2/acts/${ACTOR}/runs?token=${tok}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  if (!r.ok) return { error: "start_failed", status: r.status };
  const j = await r.json();
  return { runId: j.data?.id };
}
async function accPoll(runId: string, from: string, to: string) {
  const tok = Deno.env.get("APIFY_TOKEN");
  if (!tok) return { needKey: true };
  if (!/^[A-Za-z0-9]{8,30}$/.test(runId)) return { error: "bad_run" };
  const r = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${tok}`);
  if (!r.ok) return { error: "poll_failed" };
  const run = (await r.json()).data || {};
  if (["READY", "RUNNING"].includes(run.status)) return { status: "running" };
  if (run.status !== "SUCCEEDED") return { status: "failed", detail: run.status };
  const d = await fetch(`https://api.apify.com/v2/datasets/${run.defaultDatasetId}/items?token=${tok}&clean=true&limit=3000`);
  const rows = d.ok ? await d.json() : [];
  const items: any[] = [];
  const seen = new Set<string>();
  for (const x of rows) {
    const code = x.code || x.shortCode || x.shortcode || "";
    const link = x.post_url || x.url || (code ? `https://www.instagram.com/p/${code}/` : "");
    if (!link || seen.has(link)) continue;
    const ts = x.taken_at ? (x.taken_at > 1e12 ? x.taken_at : x.taken_at * 1000) : (x.timestamp ? Date.parse(x.timestamp) : 0);
    let pub = ts ? new Date(ts).toISOString() : dateFromUrl(link);
    if (!pub) continue;
    const day = bhDay(pub); if (day < from || day > to) continue;
    seen.add(link);
    const cap = String((x.caption && typeof x.caption === "object" ? x.caption.text : x.caption) || "").trim();
    const handle = (x.user && x.user.username) || x.ownerUsername || x.scraped_username || "";
    const first = cap.split(/\n/)[0].trim();
    items.push({ title: first.length > 140 ? first.slice(0, 140) + "…" : (first || "منشور بدون نص"), link, snippet: sum80("", cap), caption: cap.slice(0, 4000), pubDate: pub, platform: "ig", handle, src: "acc",
      likes: x.like_count ?? x.likesCount ?? null, comments: x.comment_count ?? x.commentsCount ?? null });
  }
  return { status: "done", items };
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
  if (body.mode === "acc-start") {
    const handles = (Array.isArray(body.handles) ? body.handles : []).map((h: any) => String(h || "").replace(/[^A-Za-z0-9._]/g, "")).filter(Boolean);
    return json(await accStart(handles, from, to));
  }
  if (body.mode === "acc-poll") return json(await accPoll(String(body.runId || ""), from, to));
  if (body.mode === "social") {
    const kws = (Array.isArray(body.keywords) ? body.keywords : []).filter((k: any) => k && typeof k.kw === "string" && k.kw.trim()).map((k: any) => ({ kw: String(k.kw).slice(0, 80), ctx: !!k.ctx }));
    const pfs = (Array.isArray(body.platforms) ? body.platforms : ["x", "ig", "fb"]).filter((x: string) => ["x", "ig", "fb"].includes(x));
    return json({ ...(await socialSearch(kws, from, to, pfs.length ? pfs : ["x", "ig", "fb"])), from, to });
  }
  const queries = (Array.isArray(body.queries) ? body.queries : []).slice(0, 30);

  const seen = new Set<string>();
  const items: any[] = [];
  await Promise.all(queries.map(async (qq: any, qi: number) => {
    if (!String(qq.q || "").trim()) return;
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
  // Tavily (أخبار): رابط المصدر المباشر + تاريخ النشر + نص الخبر للملخص
  const tav = Deno.env.get("TAVILY_API_KEY");
  if (tav) {
    await Promise.all(queries.map(async (qq: any, qi: number) => {
      const raw = String(qq.q || "");
      if (!raw.trim()) return;
      const domains = [...raw.matchAll(/site:([\w.-]+)/g)].map((m) => m[1]);
      const q = raw.replace(/\((?:\s*(?:OR\s+)?site:[\w.-]+\s*)+\)/g, " ").replace(/site:[\w.-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 380);
      try {
        const r = await fetch("https://api.tavily.com/search", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tav}` },
          body: JSON.stringify({ query: q, topic: "news", search_depth: "basic", max_results: 15, include_domains: domains.length ? domains : undefined, start_date: from, end_date: addDay(to), include_raw_content: true }) });
        if (!r.ok) return;
        const j = await r.json();
        for (const x of (j.results || [])) {
          const title = String(x.title || "").replace(/\s*[|–-]\s*[^|–-]{2,40}$/, "").trim();
          const key = title.replace(/\s+/g, " ").toLowerCase();
          if (!title || !x.url) continue;
          const old = items.find((i) => i.title.replace(/\s+/g, " ").toLowerCase() === key);
          const summary = sum80(x.raw_content || "", x.content || "");
          if (old) { if (!old.summary) old.summary = summary; continue; }
          if (seen.has(key)) continue;
          seen.add(key);
          let pub = ""; try { if (x.published_date) { const d = new Date(x.published_date); if (!isNaN(+d)) pub = d.toISOString(); } } catch { /* */ }
          items.push({ title, link: x.url, source: "", sourceUrl: x.url, pubDate: pub, q: qi, summary });
        }
      } catch { /* */ }
    }));
  }
  // التزام صارم بالفترة: يُستبعد كل ما لا يحمل تاريخًا ضمنها (بتوقيت البحرين)
  const inRange = items.filter((x) => x.pubDate && bhDay(x.pubDate) >= from && bhDay(x.pubDate) <= to);
  inRange.sort((a, b) => (b.pubDate || "").localeCompare(a.pubDate || ""));
  return json({ items: inRange, from, to });
});
