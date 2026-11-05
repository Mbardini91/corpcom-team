// دخول سريع بالإيميل لأعضاء الفريق (بدون رمز تحقق)
// - يتحقق أن الإيميل ضمن team_access
// - يعيد token_hash يستخدمه المتصفح لإنشاء الجلسة
// منشورة على Supabase باسم quick-login (verify_jwt = false)
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = ["https://corpcom-team.vercel.app", "http://localhost:8766"];

function cors(origin: string | null) {
  const o = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": o,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

Deno.serve(async (req: Request) => {
  const h = cors(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: h });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...h, "Content-Type": "application/json" } });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  let email = "";
  try { email = String((await req.json()).email || "").trim().toLowerCase(); } catch { /* ignore */ }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "invalid_email" }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: rows, error: e1 } = await admin.from("team_access").select("contact, role").ilike("contact", email).limit(1);
  if (e1) return json({ error: "server" }, 500);
  const row = rows && rows[0];
  if (!row) return json({ error: "not_member" }, 403);

  await admin.auth.admin.createUser({ email, email_confirm: true }).catch(() => null);
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !data?.properties?.hashed_token) return json({ error: "link_failed", detail: error?.message }, 500);
  return json({ token_hash: data.properties.hashed_token });
});
