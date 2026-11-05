/* منصة فريق إدارة الاتصال — طبقة الربط مع Supabase
   توفّر نفس واجهة window.claude.use(...) التي تعتمد عليها المنصة:
   db · user · assets · downloads — مع شاشة دخول برمز يُرسل عبر الإيميل أو الواتساب. */
(function () {
  "use strict";
  const C = window.LMRA_CONFIG || {};
  const configured = C.supabaseUrl && C.supabaseAnonKey && !/YOUR-|xxxx/i.test(C.supabaseUrl + C.supabaseAnonKey);
  const sb = configured ? window.supabase.createClient(C.supabaseUrl, C.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  }) : null;

  let resolveReady;
  const ready = new Promise(r => (resolveReady = r));
  let session = null, member = null;

  /* ---------------- helpers ---------------- */
  const $ = id => document.getElementById(id);
  const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function normPhone(v) {
    let d = String(v || "").replace(/\D/g, "");
    if (d.startsWith("00")) d = d.slice(2);
    if (d.length === 8) d = "973" + d;          // رقم بحريني بدون مفتاح الدولة
    return d ? "+" + d : "";
  }
  function mapErr(e) {
    const m = (e && (e.message || e.error_description)) || "";
    const code = e && (e.code === "42501" || /row-level security|permission/i.test(m)) ? "invalid_argument"
      : /quota|exceed|too large|payload/i.test(m) ? "quota_exceeded"
      : /rate|too many/i.test(m) ? "resource_exhausted" : "unknown";
    const err = new Error(m || "error"); err.code = code; return err;
  }

  /* ---------------- data (docs table) ---------------- */
  const store = new Map();          // col -> Map(id -> data)
  const subs = new Map();           // col -> Set(listener)
  const loaded = new Map();         // col -> Promise
  let channel = null;

  function snapOf(col) {
    const m = store.get(col) || new Map();
    return { docs: [...m.entries()].map(([id, d]) => ({ id, data: () => d })), metadata: { fromCache: false, hasPendingWrites: false } };
  }
  function emit(col) { (subs.get(col) || []).forEach(fn => { try { fn(snapOf(col)); } catch (e) { console.error(e); } }); }
  async function fetchCol(col) {
    const m = new Map(); const page = 1000;
    for (let from = 0; ; from += page) {
      const { data, error } = await sb.from("docs").select("id,data").eq("col", col).range(from, from + page - 1);
      if (error) throw mapErr(error);
      data.forEach(r => m.set(r.id, r.data));
      if (data.length < page) break;
    }
    store.set(col, m); return m;
  }
  function ensureChannel() {
    if (channel) return;
    channel = sb.channel("docs-all")
      .on("postgres_changes", { event: "*", schema: "public", table: "docs" }, p => {
        const row = p.eventType === "DELETE" ? p.old : p.new;
        if (!row || !row.col || !store.has(row.col)) return;
        const m = store.get(row.col);
        if (p.eventType === "DELETE") m.delete(row.id); else m.set(row.id, row.data);
        emit(row.col);
      })
      .subscribe();
  }
  async function refreshAll() { for (const col of store.keys()) { try { await fetchCol(col); emit(col); } catch (e) { } } }
  window.addEventListener("focus", () => { if (session && member) refreshAll(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && session && member) refreshAll(); });

  function subscribe(col, fn, onErr) {
    if (!subs.has(col)) subs.set(col, new Set());
    subs.get(col).add(fn);
    if (!loaded.has(col)) loaded.set(col, fetchCol(col).catch(e => { loaded.delete(col); throw e; }));
    loaded.get(col).then(() => fn(snapOf(col)), e => onErr && onErr(e));
    ensureChannel();
    return () => subs.get(col).delete(fn);
  }
  function docRef(col, id) {
    return {
      async set(data) {
        const { error } = await sb.from("docs").upsert({ col, id, data, updated_at: new Date().toISOString() });
        if (error) throw mapErr(error);
        if (store.has(col)) { store.get(col).set(id, data); emit(col); }
      },
      async delete() {
        const { error } = await sb.from("docs").delete().eq("col", col).eq("id", id);
        if (error) throw mapErr(error);
        if (store.has(col)) { store.get(col).delete(id); emit(col); }
      },
      onSnapshot(fn, onErr) {
        return subscribe(col, s => { const d = s.docs.find(x => x.id === id); fn({ id, exists: !!d, data: () => (d ? d.data() : undefined) }); }, onErr);
      }
    };
  }
  const db = {
    collection(col) { return { onSnapshot: (fn, onErr) => subscribe(col, fn, onErr), doc: id => docRef(col, id) }; },
    doc(path) { const i = path.indexOf("/"); return docRef(path.slice(0, i), path.slice(i + 1)); }
  };

  /* ---------------- user ---------------- */
  const user = {
    async can(what) { return what === "data.write" ? !!(member && member.role !== "viewer") : true; },
    async id() { return session ? session.user.id : null; },
    async me() { return { name: (member && member.name) || (session && (session.user.email || session.user.phone)) || "" }; }
  };

  /* ---------------- assets (Supabase Storage) ---------------- */
  const assets = {
    async upload(blob) {
      const type = blob.type || "image/png";
      const ext = (type.split("/")[1] || "png").replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "");
      const path = "news/" + new Date().toISOString().slice(0, 10) + "/" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + "." + ext;
      const { error } = await sb.storage.from("images").upload(path, blob, { contentType: type, upsert: false });
      if (error) { const e = new Error(error.message); e.code = "upload_failed"; throw e; }
      const { data } = sb.storage.from("images").getPublicUrl(path);
      return { id: data.publicUrl, url: data.publicUrl };
    }
  };

  /* ---------------- downloads ---------------- */
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = filename || "download";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      return { status: "saved" };
    }
  };

  window.claude = {
    async use(name) {
      if (!sb) return null;
      await ready;
      return { db, user, assets, downloads }[name] || null;   // "sample" (Claude) غير مفعّل في هذه النسخة
    }
  };

  /* ---------------- login UI ---------------- */
  const css = `
  #auth{position:fixed;inset:0;z-index:100;display:grid;place-items:center;background:var(--bg,#f4f2ee);padding:20px}
  #auth[hidden]{display:none}
  #auth .box{width:min(420px,100%);background:var(--surface,#fff);border:1px solid var(--line,#e3ded5);border-radius:16px;padding:28px 26px;box-shadow:0 10px 40px rgba(0,0,0,.06);display:grid;gap:14px}
  #auth .k{font-size:12.5px;color:var(--mute,#6f7375)}
  #auth h1{font-size:22px;font-weight:800;color:var(--navy,#17325a);margin:0}
  #auth .seg{display:flex;background:var(--surface-2,#f8f6f2);border:1px solid var(--line,#e3ded5);border-radius:9px;padding:3px}
  #auth .seg button{flex:1;border:0;background:transparent;padding:8px;border-radius:7px;font:inherit;font-weight:700;cursor:pointer;color:var(--mute,#6f7375)}
  #auth .seg button[aria-pressed=true]{background:var(--surface,#fff);color:var(--ink,#222);box-shadow:0 1px 3px rgba(0,0,0,.08)}
  #auth input{width:100%;font:inherit;font-size:16px;padding:11px 12px;border:1px solid var(--line-2,#cfc8bb);border-radius:10px;background:var(--surface,#fff);color:var(--ink,#222)}
  #auth input.code{letter-spacing:.5em;text-align:center;font-size:22px;font-weight:700}
  #auth .go{width:100%;padding:12px;border:0;border-radius:10px;background:var(--navy,#17325a);color:#fff;font:inherit;font-weight:700;font-size:15px;cursor:pointer}
  #auth .go:disabled{opacity:.6;cursor:default}
  #auth .lnk{background:none;border:0;color:var(--mute,#6f7375);font:inherit;font-size:13px;cursor:pointer;text-decoration:underline;justify-self:center}
  #auth .msg{font-size:13px;min-height:18px;color:var(--mute,#6f7375)}#auth .msg.err{color:#a8211f}
  .auth-out{margin-inline-start:6px}
  #acl table{min-width:0;width:100%}#acl td,#acl th{padding:6px 8px;font-size:13px}`;
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

  const wa = !!C.whatsapp;
  let mode = wa && C.defaultLogin === "whatsapp" ? "phone" : "email", target = "";
  function screen(html) {
    let el = $("auth");
    if (!el) { el = document.createElement("div"); el.id = "auth"; el.setAttribute("dir", "rtl"); document.body.appendChild(el); }
    el.hidden = false;
    el.innerHTML = `<div class="box"><div><div class="k">هيئة تنظيم سوق العمل · إدارة الاتصال</div><h1>منصة فريق إدارة الاتصال</h1></div>${html}</div>`;
    return el;
  }
  function msg(t, err) { const m = $("auth-msg"); if (m) { m.textContent = t || ""; m.className = "msg" + (err ? " err" : ""); } }
  function showStep1() {
    screen(`${wa ? `<div class="seg" role="group"><button type="button" data-m="email" aria-pressed="${mode === "email"}">الإيميل</button><button type="button" data-m="phone" aria-pressed="${mode === "phone"}">الواتساب</button></div>` : ""}
      <form id="auth-f1" style="display:grid;gap:10px">
        <label class="k" for="auth-in">${mode === "email" ? "أدخل إيميلك المسجّل في الفريق" : "أدخل رقم هاتفك المسجّل في الفريق"}</label>
        <input id="auth-in" ${mode === "email" ? 'type="email" autocomplete="email" placeholder="name@example.com"' : 'type="tel" autocomplete="tel" placeholder="3xxxxxxx"'} dir="ltr" required>
        <button class="go" type="submit">${mode === "email" ? "دخول" : "إرسال رمز الدخول"}</button>
        <div id="auth-msg" class="msg"></div></form>`);
    document.querySelectorAll("#auth [data-m]").forEach(b => b.onclick = () => { mode = b.dataset.m; showStep1(); });
    $("auth-in").focus();
    $("auth-f1").onsubmit = async e => {
      e.preventDefault(); const btn = e.target.querySelector("button"); const raw = $("auth-in").value.trim();
      target = mode === "email" ? raw.toLowerCase() : normPhone(raw);
      if (!target) return;
      btn.disabled = true; msg("جارٍ التحقق…");
      if (mode === "email") {
        try {
          const r = await fetch(C.supabaseUrl + "/functions/v1/quick-login", {
            method: "POST", headers: { "Content-Type": "application/json", apikey: C.supabaseAnonKey }, body: JSON.stringify({ email: target })
          });
          const j = await r.json().catch(() => ({}));
          if (j.error === "not_member") { msg("هذا الإيميل غير مسجّل في الفريق. تواصل مع مسؤول المنصة.", true); btn.disabled = false; return; }
          if (j.token_hash) {
            let { error } = await sb.auth.verifyOtp({ token_hash: j.token_hash, type: "email" });
            if (error) ({ error } = await sb.auth.verifyOtp({ token_hash: j.token_hash, type: "magiclink" }));
            if (error) throw error;
            msg("تم الدخول…"); return;
          }
          if (!j.needOtp) throw new Error(j.error || "quick_login_failed");
          // المسؤولون: يكمل بالتحقق عبر الإيميل
        } catch (err) { console.error(err); msg("تعذّر الدخول. حاول مجددًا.", true); btn.disabled = false; return; }
      }
      try {
        const { data: ok, error: e1 } = await sb.rpc("can_login", { p: target });
        if (e1) throw e1;
        if (!ok) { msg(mode === "email" ? "هذا الإيميل غير مسجّل في الفريق. تواصل مع مسؤول المنصة." : "هذا الرقم غير مسجّل في الفريق. تواصل مع مسؤول المنصة.", true); btn.disabled = false; return; }
        const { error } = mode === "email"
          ? await sb.auth.signInWithOtp({ email: target, options: { shouldCreateUser: true, emailRedirectTo: location.origin + location.pathname } })
          : await sb.auth.signInWithOtp({ phone: target, options: { shouldCreateUser: true, channel: "whatsapp" } });
        if (error) throw error;
        showStep2();
      } catch (err) {
        console.error(err);
        const m = (err && (err.code || "") + " " + (err.message || "")) || "";
        msg(/over_email_send_rate_limit|email rate limit/i.test(m) ? "تعذّر إرسال الإيميل حاليًا: تم بلوغ حد الإرسال في خدمة البريد. أبلغ مسؤول المنصة."
          : /seconds|over_request_rate_limit/i.test(m) ? "طلبت رمزًا قبل قليل. انتظر دقيقة، أو استخدم الرمز/الرابط الذي وصلك."
          : /not authorized|smtp|sending/i.test(m) ? "تعذّر إرسال الإيميل. أبلغ مسؤول المنصة."
          : "تعذّر إرسال الرمز. حاول مجددًا.", true);
        btn.disabled = false;
      }
    };
  }
  function showStep2() {
    screen(`<form id="auth-f2" style="display:grid;gap:10px">
        <div class="k">${mode === "email" ? "حساب المسؤول يتطلب تحققًا إضافيًا. " : ""}أرسلنا رمز دخول ${mode === "email" ? "إلى إيميلك" : "إلى الواتساب"}: <b dir="ltr">${esc(target)}</b>${mode === "email" ? "<br>اكتب الرمز هنا، أو اضغط رابط الدخول الموجود في الإيميل." : ""}</div>
        <input id="auth-code" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" dir="ltr" required>
        <button class="go" type="submit">دخول</button>
        <div id="auth-msg" class="msg"></div>
        <button class="lnk" type="button" id="auth-back">تغيير ${mode === "email" ? "الإيميل" : "الرقم"} أو إعادة الإرسال</button></form>`);
    $("auth-code").focus(); $("auth-back").onclick = showStep1;
    $("auth-f2").onsubmit = async e => {
      e.preventDefault(); const btn = e.target.querySelector(".go"); const token = $("auth-code").value.replace(/\D/g, "");
      btn.disabled = true; msg("جارٍ التحقق…");
      const { error } = mode === "email"
        ? await sb.auth.verifyOtp({ email: target, token, type: "email" })
        : await sb.auth.verifyOtp({ phone: target, token, type: "sms" });
      if (error) { msg("الرمز غير صحيح أو انتهت صلاحيته.", true); btn.disabled = false; }
    };
  }
  function showDenied() {
    screen(`<div class="msg err" style="font-size:14px">هذا الحساب غير مضاف لفريق إدارة الاتصال.</div><div class="k">تواصل مع مسؤول المنصة لإضافة إيميلك أو رقمك.</div><button class="go" type="button" id="auth-so">تسجيل الخروج</button>`);
    $("auth-so").onclick = () => sb.auth.signOut();
  }
  function showConfigMissing() {
    screen(`<div class="msg err" style="font-size:14px">المنصة غير مربوطة بقاعدة البيانات بعد.</div><div class="k">أضف رابط مشروع Supabase ومفتاح anon في ملف <b dir="ltr">config.js</b> ثم أعد النشر.</div>`);
  }

  /* ---------------- session lifecycle ---------------- */
  let booted = false;
  async function onSession(s) {
    session = s;
    if (!s) { member = null; if (booted) location.reload(); else showStep1(); return; }
    const { data, error } = await sb.rpc("my_membership");
    member = !error && data && data[0] ? data[0] : null;
    if (!member) { showDenied(); return; }
    const el = $("auth"); if (el) el.hidden = true;
    if (!booted) { booted = true; resolveReady(); addHeaderButtons(); }
  }
  function addHeaderButtons() {
    const meta = document.querySelector(".mast-meta"); if (!meta) return;
    const out = document.createElement("button"); out.type = "button"; out.className = "ghost-btn auth-out"; out.textContent = "تسجيل الخروج";
    out.onclick = async () => { await sb.auth.signOut(); location.reload(); };
    meta.appendChild(out);
    if (member && member.role === "admin") {
      const acl = document.createElement("button"); acl.type = "button"; acl.className = "ghost-btn auth-out"; acl.textContent = "صلاحيات الدخول";
      acl.onclick = openAcl; meta.insertBefore(acl, out);
    }
  }

  /* ---------------- admin: manage team access ---------------- */
  async function openAcl() {
    let d = $("acl");
    if (!d) {
      d = document.createElement("dialog"); d.id = "acl"; d.setAttribute("dir", "rtl");
      d.innerHTML = `<form method="dialog" id="acl-f"><div class="dlg-h"><h3>صلاحيات الدخول</h3><button class="btn icon" type="button" data-x aria-label="إغلاق">✕</button></div>
        <div class="dlg-b"><div class="small muted">فقط الإيميلات والأرقام المضافة هنا تستطيع الدخول للمنصة. الأرقام تُكتب مع مفتاح الدولة (مثال: 97333123456).</div>
        <div style="overflow:auto;max-height:46vh"><table><thead><tr><th>الإيميل أو الرقم</th><th>الاسم</th><th>الصلاحية</th><th></th></tr></thead><tbody id="acl-rows"></tbody></table></div>
        <div class="row2"><label class="field"><span>إيميل أو رقم</span><input id="acl-c" dir="ltr"></label><label class="field"><span>الاسم</span><input id="acl-n"></label></div>
        <label class="field"><span>الصلاحية</span><select id="acl-r"><option value="member">عضو (يضيف ويعدّل)</option><option value="viewer">مشاهد فقط</option><option value="admin">مسؤول (يدير الصلاحيات)</option></select></label>
        <div class="err-msg" id="acl-err"></div></div>
        <div class="dlg-f"><span></span><div class="grp"><button class="btn" type="button" data-x>إغلاق</button><button class="btn primary" type="submit">إضافة</button></div></div></form>`;
      document.body.appendChild(d);
      d.querySelectorAll("[data-x]").forEach(b => b.onclick = () => d.close());
      $("acl-f").onsubmit = async e => {
        e.preventDefault(); let c = $("acl-c").value.trim(); if (!c) return;
        c = c.includes("@") ? c.toLowerCase() : normPhone(c).slice(1);
        const { error } = await sb.from("team_access").upsert({ contact: c, name: $("acl-n").value.trim() || null, role: $("acl-r").value });
        if (error) { $("acl-err").textContent = "تعذّر الحفظ."; return; }
        $("acl-c").value = ""; $("acl-n").value = ""; $("acl-err").textContent = ""; loadAcl();
      };
    }
    d.showModal(); loadAcl();
  }
  const ROLE_AR = { member: "عضو", viewer: "مشاهد", admin: "مسؤول" };
  async function loadAcl() {
    const { data, error } = await sb.from("team_access").select("contact,name,role").order("name");
    const tb = $("acl-rows"); if (error) { tb.innerHTML = `<tr><td colspan="4">تعذّر التحميل.</td></tr>`; return; }
    tb.innerHTML = data.map(r => `<tr><td dir="ltr">${esc(r.contact)}</td><td>${esc(r.name || "")}</td><td>${ROLE_AR[r.role] || r.role}</td><td><button class="btn small" type="button" data-del="${esc(r.contact)}">حذف</button></td></tr>`).join("");
    tb.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
      if (b.dataset.ok !== "1") { b.dataset.ok = "1"; b.textContent = "تأكيد"; return; }
      await sb.from("team_access").delete().eq("contact", b.dataset.del); loadAcl();
    });
  }

  /* ---------------- start ---------------- */
  function start() {
    if (!sb) { showConfigMissing(); return; }
    sb.auth.onAuthStateChange((evt, s) => {
      if (evt === "INITIAL_SESSION" || evt === "SIGNED_IN" || evt === "SIGNED_OUT") setTimeout(() => onSession(s), 0);
      else if (s) session = s;
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
