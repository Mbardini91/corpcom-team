/* إعدادات الربط — عدّل القيمتين من Supabase:
   Project Settings → API → Project URL و anon public key
   (مفتاح anon آمن للنشر، الحماية تتم عبر صلاحيات قاعدة البيانات) */
window.LMRA_CONFIG = {
  supabaseUrl: "https://pmwouizumulaoonamcyx.supabase.co",
  supabaseAnonKey: "sb_publishable_W9o36lYRDwansSTJHid9qQ_Bkt-3h4g",

  /* الدخول عبر الواتساب يحتاج تفعيل Twilio في Supabase (انظر README).
     اجعلها true بعد التفعيل لتظهر خانة الواتساب في شاشة الدخول. */
  whatsapp: false,
  defaultLogin: "email"
};
