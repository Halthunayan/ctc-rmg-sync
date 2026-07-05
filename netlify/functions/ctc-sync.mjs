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

// Per-run limits — keep the whole run well under Netlify's 60s function timeout.
// The week-long stall was caused by an UNBOUNDED, sequential enrich loop over a
// growing backlog: it ran 60s and was killed before it could write/email, so
// lastMaxId never advanced and the backlog only grew. Fix = cap + parallelize.
const CTC_T = 6000;   // per-request timeout for ctckw.com calls
const BATCH = 20;     // max tenders processed per run (oldest first → always progresses)
const CONC  = 5;      // parallel enrich requests

// fetch with a hard timeout — a hung CTC request must abort, not hang the run.
const fetchT = (url, opts={}, ms=8000) => {
  const ac = new AbortController();
  const to = setTimeout(()=>ac.abort(new Error(`timeout ${ms}ms`)), ms);
  return fetch(url, {...opts, signal: ac.signal}).finally(()=>clearTimeout(to));
};

const fbUrl  = (p)=> `${FB}/${p}.json${FBTOK ? `?auth=${encodeURIComponent(FBTOK)}` : ""}`;
const fbGet  = async (p)=> { const r=await fetchT(fbUrl(p),{},8000); return r.ok ? r.json() : null; };
const fbPatch= async (p,o)=> fetchT(fbUrl(p),{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(o)},8000);
const fbPut  = async (p,v)=> fetchT(fbUrl(p),{method:"PUT", headers:{"Content-Type":"application/json"},body:JSON.stringify(v)},8000);

// ---- tiny cookie jar over fetch -------------------------------------------
function jar(){ const c={}; return {
  hdr(){ return Object.entries(c).map(([k,v])=>`${k}=${v}`).join("; "); },
  take(res){ const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie")].filter(Boolean);
    (sc||[]).forEach(s=>{ const m=s.match(/^([^=]+)=([^;]*)/); if(m) c[m[1]]=m[2]; }); }
};}
const get  = (j,u)=> fetchT(u,{headers:{Cookie:j.hdr(),"User-Agent":UA}},CTC_T);

// ---- CTC HTTP login (ASP.NET WebForms) ------------------------------------
async function ctcLogin(j){
  const LOGIN = "https://www.ctckw.com/UserLogin.aspx?lang=ar";
  let r = await fetchT(LOGIN,{headers:{"User-Agent":UA}},CTC_T); j.take(r);
  console.log("[ctc-sync] login GET", r.status);
  const html = await r.text();
  const f = {};
  for (const m of html.matchAll(/<input[^>]*type="hidden"[^>]*>/gi)){
    const n=(m[0].match(/name="([^"]+)"/)||[])[1]; const v=(m[0].match(/value="([^"]*)"/)||[])[1]||"";
    if(n) f[n]=v;
  }
  console.log("[ctc-sync] login hiddenFields=", Object.keys(f).length, "hasPwField=", /txtPinCode2/i.test(html));
  f["__EVENTTARGET"]="ctl00$ContentPlaceHolder1$btnLogin";
  f["__EVENTARGUMENT"]="";
  f["ctl00$ContentPlaceHolder1$txtPinCode1"]=process.env.CTC_USER;
  f["ctl00$ContentPlaceHolder1$txtPinCode2"]=process.env.CTC_PASS;
  let r2 = await fetchT(LOGIN,{method:"POST",redirect:"manual",
    headers:{"Content-Type":"application/x-www-form-urlencoded",Cookie:j.hdr(),"User-Agent":UA},
    body:new URLSearchParams(f).toString()},CTC_T); j.take(r2);
  console.log("[ctc-sync] login POST", r2.status);
  let chk = await get(j,"https://www.ctckw.com/TendersSearch.aspx?CategoryID=11");
  const t = await chk.text();
  const stillLogin = /txtPinCode2/i.test(t) || /UserLogin\.aspx/i.test(chk.url);
  console.log("[ctc-sync] verify", chk.status, "stillOnLogin=", stillLogin);
  if(stillLogin) throw new Error("CTC login failed (still on login page)");
  return t;
}

// ---- fetch tender rows via the page's own JSON API -------------------------
const hidVal = (page,sfx) => { const m = page.match(new RegExp('<input[^>]*ctl00_ContentPlaceHolder1_'+sfx+'[^>]*>','i')); if(!m) return ""; const v=m[0].match(/value="([^"]*)"/); return v?v[1]:""; };
async function fetchTenders(j, page){
  const p = new URLSearchParams({ id:"1",
    catidvalue: hidVal(page,"hdfCatid")||"11", buyerid: hidVal(page,"hdfbuyers"),
    ClassificationID: hidVal(page,"hdfTenderClassificationID"), cityid: hidVal(page,"hdfCity"),
    tendertypeid: hidVal(page,"hdfTenderType"), tenderstatusid: hidVal(page,"hdfstatus"),
    rbbontype: hidVal(page,"hdfRbbon"), companyid: hidVal(page,"hdfCompanyId"),
    sortbyid: hidVal(page,"hdfSortby"), tendernameid: hidVal(page,"hdfTenderName"),
    IDFrom:"0", IDTo:"200", User: hidVal(page,"hdnUser"), startDate:"", endDate:"" });
  const r = await fetchT("https://www.ctckw.com/api/HomePage/GetValue?"+p.toString(),
    { headers:{ Cookie:j.hdr(), "User-Agent":UA, "X-Requested-With":"XMLHttpRequest",
                Accept:"application/json, text/javascript, */*; q=0.01",
                Referer:"https://www.ctckw.com/TendersSearch.aspx?CategoryID=11" } }, CTC_T);
  console.log("[ctc-sync] api HTTP", r.status);
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
  return { ref:g("الرقم"), type:g("نوع الاشعار"), entity:g("الجهة الناشرة"), post:g("تاريخ الطرح"),
           dead:g("الموعد النهائي"), status:g("الحالة"), price:g("السعر"), bond:g("التامين"), title:g("الموضوع") };
}

const MED = /طب|صحة|صحي|مستشفى|مستوصف|مركز صحي|رعاية صحية|عيادة|طبي|طبية|الطب|أسنان|صيدل|دواء|أدوية|محاليل مخبرية|مستهلكات طبية|أشعة|جراح|مرضى|تمريض|سريري|اكلينيكي|طوارئ طبية|إسعاف|وزارة الصحة|الصحة العامة/;
const NOTMED = /بيطر|البطاريات|الإطارات|التربة|الخرسانة|مواد البناء|عطور|تجميل|مأكولات|كافتيريا|بقالة/;
const typeEN = (a)=>({ "ممارسة":"Practice","مناقصة":"Tender","مزايدة":"Auction","مزاد":"Auction","استدراج عروض":"RFQ","خدمات استشارية":"Consulting","تأهيل":"Prequalification","استثمار":"Investment" }[String(a).trim()]||a||"Practice");
const statusEN = (s)=>({ "جديد":"New","ساري":"Open","ساري المفعول":"Open","قائم":"Open","منتهي":"Closed","مغلق":"Closed","مقفل":"Closed","ملغي":"Cancelled","ملغى":"Cancelled","معلق":"On Hold","مؤجل":"Postponed","تحت الدراسة":"Under Review" }[String(s).trim()]||(s||"New"));

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
  return fetchT("https://api.resend.com/emails",{method:"POST",
    headers:{Authorization:`Bearer ${process.env.RESEND_KEY}`,"Content-Type":"application/json"},
    body:JSON.stringify({from:EMAIL_FROM,to:EMAIL_TO,subject,html})},8000);
}

const toRecord = (r, d={}) => ({
  nashraaId: "CTC-"+r.id, refId: d.ref||"", publisher: "Ministry of Health - "+(r.entity||""),
  type: typeEN(r.type), summary: r.title,
  description: "Medical / healthcare procurement — Kuwait (CTC)",
  sector: "Medical", subSector: "Medical Consumables",
  postDate: iso(r.post), deadline: iso(r.dead),
  status: statusEN(r.status), mainSector: "Health",
  price: d.price||"", insurance: d.bond||"", hasOpeningBids: "No",
  _ctcId: r.id, _src: "ctc",
});

export default async (req) => {
  const log = [];
  const t0 = Date.now();
  try {
    if(!FB || !process.env.CTC_USER || !process.env.RESEND_KEY){
      console.error("[ctc-sync] MISSING ENV");
      return new Response("Missing env (FIREBASE_URL / CTC_USER / RESEND_KEY)", {status:500});
    }
    console.log("[ctc-sync] === run start", new Date().toISOString());

    const j = jar();
    let firstPage = await ctcLogin(j);
    log.push("login ok");

    const lastMaxId = Number((await fbGet("pipeline/lastMaxId")) || 0);
    console.log("[ctc-sync] lastMaxId=", lastMaxId);

    const rows = await fetchTenders(j, firstPage);
    const maxRowId = rows.reduce((m,r)=>Math.max(m,Number(r.id)||0),0);
    log.push("api rows="+rows.length);
    console.log("[ctc-sync] rows=", rows.length, "maxRowId=", maxRowId);
    const isMedical = (r) => { const b = `${r.title} ${r.entity}`; return MED.test(b) && !NOTMED.test(b); };

    // new = id > lastMaxId & medical; OLDEST first so we always make progress,
    // and CAP per run so the enrich loop can't exceed the 60s function limit.
    const freshAll = rows.filter(r => Number(r.id) > lastMaxId && isMedical(r))
                         .sort((a,b)=> Number(a.id) - Number(b.id));
    const batch = freshAll.slice(0, BATCH);
    console.log("[ctc-sync] freshAll=", freshAll.length, "processing=", batch.length);

    // enrich (best-effort) + normalize — PARALLEL, small concurrency cap
    const records = [];
    for (let i=0; i<batch.length; i+=CONC){
      const recs = await Promise.all(batch.slice(i,i+CONC).map(async r => {
        let d={}; try{ d = await enrich(j, r.id); }catch(e){ console.log("[ctc-sync] enrich fail", r.id, String(e)); }
        return toRecord(r, d);
      }));
      records.push(...recs);
    }
    log.push(`freshAll=${freshAll.length} batch=${records.length}`);
    console.log("[ctc-sync] batch records=", records.length, "elapsed=", Date.now()-t0, "ms");

    // guard against a concurrent double-fire (re-read high-water mark)
    if (records.length) {
      const nowMax = Number((await fbGet("pipeline/lastMaxId")) || 0);
      const ourMax = Math.max(...records.map(t=>Number(t._ctcId)));
      if (nowMax >= ourMax) { log.push("skip: concurrent run"); console.log("[ctc-sync] skip concurrent"); records.length = 0; }
    }

    // write PER-TENDER nodes + advance high-water mark to the max PROCESSED id
    if (records.length) {
      const patch = {};
      records.forEach(t => { patch[t.nashraaId] = t; });
      await fbPatch("tenders", patch);
      await fbPut("tenders_version", Date.now());
      const newMax = Math.max(lastMaxId, ...records.map(t=>Number(t._ctcId)));
      await fbPut("pipeline/lastMaxId", newMax);
      await fbPatch("pipeline/runs", { [Date.now()]: { date:new Date().toISOString().slice(0,10), n:records.length } });
      console.log("[ctc-sync] wrote", records.length, "newMax=", newMax, "remaining=", freshAll.length-records.length);
    }

    // email digest via Resend
    if (records.length) {
      const er = await sendEmail(records);
      log.push("email "+er.status);
      console.log("[ctc-sync] email HTTP", er.status);
    } else { log.push("no new medical — no email"); console.log("[ctc-sync] no new medical — no email"); }

    const remaining = Math.max(0, freshAll.length - records.length);
    console.log("[ctc-sync] === done in", Date.now()-t0, "ms", JSON.stringify(log), "remaining=", remaining);
    return new Response(JSON.stringify({ok:true, remaining, log}), {headers:{"Content-Type":"application/json"}});
  } catch (e) {
    console.error("[ctc-sync] ERROR after", Date.now()-t0, "ms:", String(e), "| log:", JSON.stringify(log));
    return new Response(JSON.stringify({ok:false, error:String(e), log}), {status:500, headers:{"Content-Type":"application/json"}});
  }
};
