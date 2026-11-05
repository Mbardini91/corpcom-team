/* إعدادات الربط — عدّل القيمتين من Supabase:
   Project Settings → API → Project URL و anon public key
   (مفتاح anon آمن للنشر، الحماية تتم عبر صلاحيات قاعدة البيانات) */
window.LMRA_CONFIG = {
  supabaseUrl: "https://YOUR-PROJECT.supabase.co",
  supabaseAnonKey: "YOUR-ANON-KEY",

  /* الدخول عبر الواتساب يحتاج تفعيل Twilio في Supabase (انظر README).
     اجعلها true بعد التفعيل لتظهر خانة الواتساب في شاشة الدخول. */
  whatsapp: false,
  defaultLogin: "email"
};
