// ============================================================================
// CTC -> RMG daily sync — Netlify Scheduled Function (runs in Netlify's cloud).
// No browser, no user laptop. CTC is server-rendered ASP.NET, so a plain HTTP
// login + HTML parse is enough. Writes PER-TENDER Firebase nodes (tenders/{id})
// + bumps tenders_version; emails the digest via Resend.
//
// Env vars (set in Netlify → Site settings → Environment variables):
//   CTC_USER, CTC_PASS            CTC (ctckw.com) login
//   RESEND_KEY                    Resend API key
//   FIREBASE_URL                  https://tenders-cfefe-default-rtdb.europe-west1.firebasedatabase.app
//   FIREBASE_TOKEN  (optional)    DB secret/token once rules are secured
//   EMAIL_FROM      (optional)    default onboarding@resend.dev
//   EMAIL_TO        (optional)    default the 3 recipients
// ============================================================================

export const config = { schedule: "0 8 * * *" };  // daily 08:00 UTC

const FB    = (process.env.FIREBASE_URL || "").replace(/\/+$/, "");
const FBTOK = process.env.FIREBASE_TOKEN || "";
const UA    = "Mozilla/5.0 (compatible; RMG-CTC-Sync/1.0)";
const EMAIL_FROM = process.env.EMAIL_FROM || "onboarding@resend.dev";
const EMAIL_TO   = (process.env.EMAIL_TO || "ryangdougherty@gmail.com,hamadswat@gmail.com,ryandougherty@jhu.edu").split(",").map(s=>s.trim());

const fbUrl  = (p)=> `${FB}/${p}.json${FBTOK ? `?auth=${encodeURIComponent(FBTOK)}` : ""}`;
const fbGet  = async (p)=> { const r=await fetch(fbUrl(p)); return r.ok ? r.json() : null; };
const fbPatch= async (p,o)=> fetch(fbUrl(p),{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(o)});
const fbPut  = async (p,v)=> fetch(fbUrl(p),{method:"PUT", headers:{"Content-Type":"application/json"},body:JSON.stringify(v)});

// ---- tiny cookie jar over fetch -------------------------------------------
function jar(){ const c={}; return {
  hdr(){ return Object.entries(c).map(([k,v])=>`${k}=${v}`).join("; "); },
  take(res){ const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie")].filter(Boolean);
    (sc||[]).forEach(s=>{ const m=s.match(/^([^=]+)=([^;]*)/); if(m) c[m[1]]=m[2]; }); }
};}
const get  = (j,u)=> fetch(u,{headers:{Cookie:j.hdr(),"User-Agent":UA}});

// ---- CTC HTTP login (ASP.NET WebForms) ------------------------------------
async function ctcLogin(j){
  // CTC login form (verified live 2026-06): email field = txtPinCode1,
  // password = txtPinCode2; the "دخول" button is an <a> firing
  // __doPostBack('ctl00$ContentPlaceHolder1$btnLogin',''). No client-side
  // hashing/encryption, so plain values are accepted.
  const LOGIN = "https://www.ctckw.com/UserLogin.aspx?lang=ar";
  let r = await fetch(LOGIN,{headers:{"User-Agent":UA}}); j.take(r);
  const html = await r.text();
  const f = {};
  // carry every hidden field (order-independent: name/value matched separately)
  for (const m of html.matchAll(/<input[^>]*type="hidden"[^>]*>/gi)){
    const n=(m[0].match(/name="([^"]+)"/)||[])[1]; const v=(m[0].match(/value="([^"]*)"/)||[])[1]||"";
    if(n) f[n]=v;
  }
  f["__EVENTTARGET"]="ctl00$ContentPlaceHolder1$btnLogin";
  f["__EVENTARGUMENT"]="";
  f["ctl00$ContentPlaceHolder1$txtPinCode1"]=process.env.CTC_USER;
  f["ctl00$ContentPlaceHolder1$txtPinCode2"]=process.env.CTC_PASS;
  let r2 = await fetch(LOGIN,{method:"POST",redirect:"manual",
    headers:{"Content-Type":"application/x-www-form-urlencoded",Cookie:j.hdr(),"User-Agent":UA},
    body:new URLSearchParams(f).toString()}); j.take(r2);
  // verify: a logged-in TendersSearch page must NOT contain the login field
  let chk = await get(j,"https://www.ctckw.com/TendersSearch.aspx?CategoryID=11");
  const t = await chk.text();
  if(/txtPinCode2/i.test(t) || /UserLogin\.aspx/i.test(chk.url)) throw new Error("CTC login failed (still on login page)");
  return t; // first page of the medical category (logged in)
}

// ---- fetch tender rows via the page's own JSON API -------------------------
// The results page is CLIENT-rendered: it GETs /api/HomePage/GetValue with all
// the hidden-field filters and renders the JSON. We replicate that call exactly.
const hidVal = (page,sfx) => { const m = page.match(new RegExp('<input[^>]*ctl00_ContentPlaceHolder1_'+sfx+'[^>]*>','i')); if(!m) return ""; const v=m[0].match(/value="([^"]*)"/); return v?v[1]:""; };
async function fetchTenders(j, page){
  const p = new URLSearchParams({ id:"1",
    catidvalue: hidVal(page,"hdfCatid")||"11", buyerid: hidVal(page,"hdfbuyers"),
    ClassificationID: hidVal(page,"hdfTenderClassificationID"), cityid: hidVal(page,"hdfCity"),
    tendertypeid: hidVal(page,"hdfTenderType"), tenderstatusid: hidVal(page,"hdfstatus"),
    rbbontype: hidVal(page,"hdfRbbon"), companyid: hidVal(page,"hdfCompanyId"),
    sortbyid: hidVal(page,"hdfSortby"), tendernameid: hidVal(page,"hdfTenderName"),
    IDFrom:"0", IDTo:"200", User: hidVal(page,"hdnUser"), startDate:"", endDate:"" });
  const r = await fetch("https://www.ctckw.com/api/HomePage/GetValue?"+p.toString(),
    { headers:{ Cookie:j.hdr(), "User-Agent":UA, "X-Requested-With":"XMLHttpRequest",
                Accept:"application/json, text/javascript, */*; q=0.01",
                Referer:"https://www.ctckw.com/TendersSearch.aspx?CategoryID=11" } });
  if(!r.ok) throw new Error("CTC API HTTP "+r.status);
  const arr = await r.json();
  return (Array.isArray(arr)?arr:[]).map(o => ({
    id: String(o.tdc_id||""), title: (o.tnd_name||"").trim(), entity: (o.ttp_name||"").trim(),
    post: o.tnd_publish_date||"", dead: o.tnd_buy_tender_date||"",
    type: o.tnd_tcs_id||"", status: o.tnd_sts||"", subcat: String(o.tnc_cat_id||""),
  })).filter(r => r.id);
}
const iso = (d)=>{ const m=String(d||"").match(/(\d{2})\/(\d{2})\/(\d{4})/); return m?`${m[3]}-${m[2]}-${m[1]}`:""; };

// ---- detail page enrich ----------------------------------------------------
async function enrich(j,id){
  let r = await get(j,`https://www.ctckw.com/TenderDetails.aspx?tdc_id=${id}`);
  const t = (await r.text()).replace(/<[^>]+>/g,"\n").replace(/&nbsp;/g," ");
  const g=(label)=>{ const m=t.match(new RegExp(label+"\\s*\\n?\\s*([^\\n]+)")); return m?m[1].trim():""; };
  return {
    ref:    g("الرقم"),
    type:   g("نوع الاشعار"),
    entity: g("الجهة الناشرة"),
    post:   g("تاريخ الطرح"),
    dead:   g("الموعد النهائي"),
    status: g("الحالة"),
    price:  g("السعر"),
    bond:   g("التامين"),
    title:  g("الموضوع"),
  };
}

const MED = /طب|صحة|صحي|مستشفى|مستوصف|مركز صحي|رعاية صحية|عيادة|طبي|طبية|الطب|أسنان|صيدل|دواء|أدوية|محاليل مخبرية|مستهلكات طبية|أشعة|جراح|مرضى|تمريض|سريري|اكلينيكي|طوارئ طبية|إسعاف|وزارة الصحة|الصحة العامة/;
const NOTMED = /بيطر|البطاريات|الإطارات|التربة|الخرسانة|مواد البناء|عطور|تجميل|مأكولات|كافتيريا|بقالة/;
const typeEN = (a)=>({ "ممارسة":"Practice","مناقصة":"Tender","مزايدة":"Auction","مزاد":"Auction","استدراج عروض":"RFQ","خدمات استشارية":"Consulting","تأهيل":"Prequalification","استثمار":"Investment" }[String(a).trim()]||a||"Practice");

// ---- bilingual digest email (Resend) --------------------------------------
function buildEmail(records){
  const card = (t)=>`<div style="border:1px solid #e2e6ee;border-radius:8px;padding:12px 14px;margin:10px 0;background:#fafbfd">
    <div dir="rtl" style="font-weight:bold;font-size:15px;color:#1f3864">${t.summary}</div>
    <div style="font-size:12px;color:#374151;line-height:1.7">🏛️ ${t.publisher}<br>🧾 ${t.type} · 🆔 ${t.nashraaId}<br>📅 ${t.postDate} · ⏰ ${t.deadline}</div>
    <div style="margin-top:8px">
      <a href="https://www.ctckw.com/TenderDetails.aspx?tdc_id=${t._ctcId}" style="display:inline-block;background:#2E5496;color:#fff;text-decoration:none;padding:7px 12px;border-radius:6px;font-size:12px;font-weight:bold;margin-right:6px">عرض في CTC ↗ / View on CTC</a>
      <a href="https://rmg-tenders.netlify.app/?search=${t.nashraaId}" style="display:inline-block;background:#2f8f4e;color:#fff;text-decoration:none;padding:7px 12px;border-radius:6px;font-size:12px;font-weight:bold">فتح في RMG ↗ / Open in RMG</a>
    </div></div>`;
  const html = `<div style="font-family:Tahoma,Arial,sans-serif;max-width:640px">
    <div style="background:#1f3864;color:#fff;padding:16px 18px;border-radius:8px">
      <div dir="rtl" style="font-size:18px;font-weight:bold">مناقصات طبية جديدة من CTC</div>
      <div style="font-size:14px;font-weight:bold">New CTC Medical Tenders — ${records.length} new</div>
      <div style="font-size:12px;opacity:.85">${new Date().toISOString().slice(0,10)}</div></div>
    <div style="margin:14px 0"><a href="https://rmg-tenders.netlify.app" style="display:inline-block;background:#2f8f4e;color:#fff;text-decoration:none;padding:8px 14px;border-radius:6px;font-weight:bold">📂 Open all in RMG</a></div>
    ${records.map(card).join("")}
    <div style="color:#9ca3af;font-size:11px;margin-top:14px;border-top:1px solid #eee;padding-top:10px">Automated daily digest · CTC → RMG · source ctckw.com</div></div>`;
  const subject = `CTC Medical Tenders — ${new Date().toISOString().slice(0,10)} (${records.length} new) | مناقصات طبية`;
  return { subject, html };
}
async function sendEmail(records){
  const { subject, html } = buildEmail(records);
  return fetch("https://api.resend.com/emails",{method:"POST",
    headers:{Authorization:`Bearer ${process.env.RESEND_KEY}`,"Content-Type":"application/json"},
    body:JSON.stringify({from:EMAIL_FROM,to:EMAIL_TO,subject,html})});
}

export default async (req) => {
  const log = [];
  try {
    if(!FB || !process.env.CTC_USER || !process.env.RESEND_KEY)
      return new Response("Missing env (FIREBASE_URL / CTC_USER / RESEND_KEY)", {status:500});

    const j = jar();
    let firstPage = await ctcLogin(j);
    log.push("login ok");

    const lastMaxId = Number((await fbGet("pipeline/lastMaxId")) || 0);

    // 1) fetch the medical-category (CategoryID 11) tender list from the JSON API
    const rows = await fetchTenders(j, firstPage);
    log.push("api rows="+rows.length);
    const isMedical = (r) => { const b = `${r.title} ${r.entity}`; return MED.test(b) && !NOTMED.test(b); };

    // SELFTEST (?selftest=1): read-only — show API rows + how the filter classifies
    // recent items. No write/email, so it stays fast and side-effect free.
    if (new URL(req.url).searchParams.get("selftest") === "1") {
      const recent = rows.filter(r => Number(r.id) > 259300).slice(0,40)
        .map(r => ({ id:r.id, medical:isMedical(r), subcat:r.subcat,
                     title:r.title.slice(0,44), entity:r.entity.slice(0,28), post:r.post, type:r.type }));
      return new Response(JSON.stringify({ ok:true, selftest:{ loginOk:true, lastMaxId,
        apiRows:rows.length, newestId:rows[0]?.id, medicalShown:recent.filter(c=>c.medical).length,
        sample:recent } }, null, 2), {headers:{"Content-Type":"application/json"}});
    }

    // 2) new = id > lastMaxId, medically relevant, not a false positive
    const fresh = rows.filter(r => Number(r.id) > lastMaxId && isMedical(r));

    // 3) enrich (best-effort: price/bond/ref) + normalize to RMG schema
    const records = [];
    for (const r of fresh) {
      let d = {};
      try { d = await enrich(j, r.id); } catch {}
      records.push({
        nashraaId: "CTC-"+r.id, refId: d.ref||"", publisher: "Ministry of Health - "+(r.entity||""),
        type: typeEN(r.type), summary: r.title,
        description: "Medical / healthcare procurement — Kuwait (CTC)",
        sector: "Medical", subSector: "Medical Consumables",
        postDate: iso(r.post), deadline: iso(r.dead),
        status: r.status||"New", mainSector: "Health",
        price: d.price||"", insurance: d.bond||"", hasOpeningBids: "No",
        _ctcId: r.id, _src: "ctc",
      });
    }
    log.push(`fresh=${fresh.length} medical=${records.length}`);

    // 4) write PER-TENDER nodes + bump version
    if (records.length) {
      const patch = {};
      records.forEach(t => { patch[t.nashraaId] = t; });
      await fbPatch("tenders", patch);                 // merge — never overwrites other tenders
      await fbPut("tenders_version", Date.now());
      const newMax = Math.max(lastMaxId, ...records.map(t=>Number(t._ctcId)));
      await fbPut("pipeline/lastMaxId", newMax);
      await fbPatch("pipeline/runs", { [Date.now()]: { date:new Date().toISOString().slice(0,10), n:records.length } });
    }

    // 5) email digest via Resend
    if (records.length) {
      const er = await sendEmail(records);
      log.push("email "+er.status);
    } else { log.push("no new medical — no email"); }

    return new Response(JSON.stringify({ok:true, log}), {headers:{"Content-Type":"application/json"}});
  } catch (e) {
    return new Response(JSON.stringify({ok:false, error:String(e), log}), {status:500, headers:{"Content-Type":"application/json"}});
  }
};
