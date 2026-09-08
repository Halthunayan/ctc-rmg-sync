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
const CTC_T = 8000;   // per-request timeout for ctckw.com calls
const BATCH = 50;     // max tenders written per run (oldest first → always progresses)

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
async function fetchTenders(j, page, categoryId){
  const p = new URLSearchParams({ id:"1",
    catidvalue: String(categoryId||"11"), buyerid: hidVal(page,"hdfbuyers"),
    ClassificationID: hidVal(page,"hdfTenderClassificationID"), cityid: hidVal(page,"hdfCity"),
    tendertypeid: hidVal(page,"hdfTenderType"), tenderstatusid: hidVal(page,"hdfstatus"),
    rbbontype: hidVal(page,"hdfRbbon"), companyid: hidVal(page,"hdfCompanyId"),
    sortbyid: hidVal(page,"hdfSortby"), tendernameid: hidVal(page,"hdfTenderName"),
    IDFrom:"0", IDTo:"200", User: hidVal(page,"hdnUser"), startDate:"", endDate:"" });
  const r = await fetchT("https://www.ctckw.com/api/HomePage/GetValue?"+p.toString(),
    { headers:{ Cookie:j.hdr(), "User-Agent":UA, "X-Requested-With":"XMLHttpRequest",
                Accept:"application/json, text/javascript, */*; q=0.01",
                Referer:"https://www.ctckw.com/TendersSearch.aspx?CategoryID=11" } }, CTC_T);
  console.log("[ctc-sync] api cat="+String(categoryId||"11"), "HTTP", r.status);
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
           dead:g("الموعد النهائي"), status:g("الحالة"), price:g("السعر"), bond:g("التامين"), title:g("الموضوع"),
           hasBids: /إجمالي العرض|اسم المقاول/.test(t) };
}

const MED = /طب|صحة|صحي|مستشفى|مستوصف|مركز صحي|رعاية صحية|عيادة|طبي|طبية|الطب|أسنان|صيدل|دواء|أدوية|محاليل مخبرية|مستهلكات طبية|أشعة|جراح|مرضى|تمريض|سريري|اكلينيكي|طوارئ طبية|إسعاف|وزارة الصحة|الصحة العامة|مجمع صحي|مرفق صحي|مجمع طبي|مرفق طبي|اورام|أورام|الطب النفسي|مختبر|مختبرات/;
const NOTMED = /بيطر|البطاريات|الإطارات|التربة|الخرسانة|مواد البناء|عطور|تجميل|مأكولات|كافتيريا|بقالة/;
const typeEN = (a)=>({ "ممارسة":"Practice","مناقصة":"Tender","مزايدة":"Auction","مزاد":"Auction","استدراج عروض":"RFQ","خدمات استشارية":"Consulting","تأهيل":"Prequalification","استثمار":"Investment" }[String(a).trim()]||a||"Practice");
const statusEN = (s)=>({ "جديد":"New","ساري":"Open","ساري المفعول":"Open","قائم":"Open","منتهي":"Closed","مغلق":"Closed","مقفل":"Closed","ملغي":"Cancelled","ملغى":"Cancelled","معلق":"On Hold","مؤجل":"Postponed","تحت الدراسة":"Under Review","تعديل":"Amended","تمديد":"Extended","مُرسى":"Awarded","مرسى":"Awarded" }[String(s).trim()]||(s||"New"));
// Unmapped Arabic values still pass through raw. That is deliberate — losing the
// original string would hide a new CTC status entirely — but it means status
// alone can never be trusted as a filter. closeOutExpired() below is what makes
// the field meaningful.


// ---- PDF text extraction (unpdf) -------------------------------------------
// CTC's MoH "QOT" quotation forms carry a real text layer. Content streams are
// FlateDecode, so inflate each stream and pull the text-showing operators.
// Deliberately NOT pdfjs-dist: a heavy import + parse would risk the 60s
// function timeout that previously stalled this pipeline for a week.
// Text extraction via unpdf (serverless pdf.js). The previous hand-rolled
// zlib+regex extractor was PROVEN WRONG on a real CTC file: 68k chars of
// metadata garbage vs poppler's 491k chars of real Arabic. It cannot decode
// CID/Identity-H fonts, which these PDFs use. Measured: 219pp -> 233k chars
// in ~700 ms.
async function pdfTextOf(buf){
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: true });
  return String(text || "");
}

// Letterhead/boilerplate that must never become a product description. The
// CTC/MoH QOT form repeats its header on every page, and both parsers have
// picked it up as a line item at least once on live data.
const DESC_NOISE = /(PRINTED ON|MINISTRY OF HEALTH|BIOMEDICAL|Page \d+ of \d+|P\.O\.\s?Box|SAFAT|Code No|Tel\s*:|Fax\s*:|QOT_|www\.|@)/i;
const looksLikeDesc = (d) => /[A-Za-z]{3}/.test(String(d || "")) && !DESC_NOISE.test(String(d || ""));

function numOf(s){
  const m = String(s).replace(/[^\d,]/g,"").match(/^\d{1,3}(?:,\d{3})+|^\d+/);
  if(!m) return null;
  const n = Number(m[0].replace(/,/g,""));
  return Number.isFinite(n) && n>0 ? n : null;
}

// Reconstruct real table rows from glyph coordinates. unpdf/pdf.js emits text
// in content-stream order, not visual order, so on the MoH QOT form the
// columns arrive as separate blocks and a line-based parse pairs the wrong
// description with the wrong quantity (it once read the letterhead postcode
// 13086 as a quantity). Coordinates are the only reliable pairing.
async function positionalItems(pdf){
  const out = [];
  const pages = Math.min(pdf.numPages || 1, 12);
  for (let p = 1; p <= pages && out.length < 40; p++) {
    let tc;
    try { tc = await (await pdf.getPage(p)).getTextContent(); } catch { continue; }
    const glyphs = (tc.items || [])
      .filter(i => i && typeof i.str === "string" && i.str.trim())
      .map(i => ({ s: i.str.trim(), x: i.transform[4], y: i.transform[5] }))
      .sort((a,b) => (b.y - a.y) || (a.x - b.x));
    const rows = [];
    for (const g of glyphs) {
      const r = rows[rows.length-1];
      if (r && Math.abs(r.y - g.y) <= 3) r.cells.push(g); else rows.push({ y:g.y, cells:[g] });
    }
    rows.forEach(r => r.cells.sort((a,b) => a.x - b.x));

    let hi = -1, col = {};
    for (let i = 0; i < rows.length; i++) {
      const joined = rows[i].cells.map(c=>c.s).join(" ").toUpperCase();
      if (!/DESCRIPTION/.test(joined) || !/QUANTITY/.test(joined)) continue;
      hi = i; col = {};
      for (const c of rows[i].cells) {
        const u = c.s.toUpperCase();
        if (/SL\s*N[O0]/.test(u))       col.sl   = c.x;
        else if (/DESCRIPTION/.test(u)) col.desc = c.x;
        else if (/^UNIT/.test(u))       col.unit = c.x;
        else if (/QUANTITY/.test(u))    col.qty  = c.x;
      }
      break;
    }
    if (hi < 0 || col.desc == null || col.unit == null || col.qty == null) continue;

    const pick = (cells, lo, hix) => cells.filter(c => c.x >= lo && c.x < hix).map(c=>c.s).join(" ").replace(/\s+/g," ").trim();
    const bDesc = col.sl != null ? (col.sl + col.desc)/2 : col.desc - 20;
    const bUnit = (col.desc + col.unit)/2;
    const bQty  = (col.unit + col.qty)/2;
    const right = col.qty + Math.max(40, col.qty - col.unit);

    let cur = null;
    for (let i = hi + 1; i < rows.length; i++) {
      const cells = rows[i].cells;
      const line  = cells.map(c=>c.s).join(" ");
      if (/REMARKS|PLEASE QUOTE|F\.O\.B|CLOSING DATE|VALIDITY OF THE OFFER/i.test(line)) break;
      const sl   = col.sl != null ? pick(cells, col.sl - 25, bDesc) : "";
      const desc = pick(cells, bDesc, bUnit);
      const unit = pick(cells, bUnit, bQty);
      const qty  = numOf(pick(cells, bQty, right));
      if (/^\d{1,3}$/.test(sl) || (qty && unit)) {
        if (cur && cur.d) out.push(cur);
        cur = { d: desc, u: (unit||"").toUpperCase(), q: qty || 0 };
      } else if (cur && desc) {
        cur.d = (cur.d + " " + desc).trim();
      }
      if (cur && qty && !cur.q) cur.q = qty;
      if (cur && unit && !cur.u) cur.u = unit.toUpperCase();
    }
    if (cur && cur.d) out.push(cur);
  }
  return out.filter(i => i.d && i.d.length >= 4 && i.q > 0 && looksLikeDesc(i.d))
            .map(i => ({ d: i.d.slice(0,160), u: i.u.slice(0,12), q: i.q }))
            .slice(0, 40);
}

// Text fallback. Uses the MoH QOT column-header anchors: the serial, unit and
// quantity blocks each end with their header label and align exactly, so those
// three are safe. Descriptions are only paired when the line count divides
// evenly by the item count; otherwise nothing is emitted rather than guessed.
function pdfItems(text){
  const L = String(text||"").split(/\r?\n/).map(s => s.replace(/\s+/g," ").trim());
  const at = (re) => L.findIndex(l => re.test(l));
  const iSl = at(/^SL\s*N[O0]\.?$/i), iDesc = at(/^ITEM\s+DESCRIPTION$/i),
        iUnit = at(/^UNIT$/i),        iQty  = at(/^QUANTITY$/i);
  if (iSl < 0 || iDesc < 0 || iUnit < 0 || iQty < 0) return [];
  const serials = [];
  for (let i = iSl - 1; i >= 0 && /^\d{1,3}$/.test(L[i]); i--) serials.unshift(L[i]);
  const n = serials.length; if (!n) return [];
  const back = (end, count) => { const a = []; for (let i = end - 1; i >= 0 && a.length < count; i--) if (L[i]) a.unshift(L[i]); return a; };
  const units = back(iUnit, n), qtys = back(iQty, n);
  if (units.length !== n || qtys.length !== n) return [];
  // Multi-page QOT forms repeat the CTC/MoH letterhead inside the stream, so
  // the description block can contain the fax/phone/P.O.-box lines. Those once
  // reached a live record as a product line. Drop boilerplate, and require a
  // run of Latin letters: item descriptions on these forms are always English.
  const dl = L.slice(iSl + 1, iDesc).filter(Boolean).filter(looksLikeDesc);
  let descs;
  if (dl.length === n) descs = dl;
  else if (dl.length && dl.length % n === 0) { const k = dl.length / n; descs = []; for (let i=0;i<n;i++) descs.push(dl.slice(i*k,(i+1)*k).join(" ")); }
  else if (n === 1) descs = [dl.join(" ")];
  else return [];
  const out = [];
  for (let i = 0; i < n; i++) {
    const q = numOf(qtys[i]), d = descs[i], u = String(units[i]||"").toUpperCase();
    if (!q || !d || d.length < 4) continue;
    out.push({ d: d.slice(0,160), u: u.slice(0,12), q });
  }
  return out.slice(0, 40);
}

// Primary path is the text-anchor parser above: it is verified correct against
// a real MoH QOT form (6LB333 -> 400,000 + 4,000,000 PCS). positionalItems is
// the fallback for attachments that lack those column headers.
async function pdfItemsOf(buf){
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  let items = [];
  try { const { text } = await extractText(pdf, { mergePages: true }); items = pdfItems(String(text || "")); } catch {}
  if (!items.length) { try { items = await positionalItems(pdf); } catch {} }
  return items;
}

// ---- sub-sector classification (was hardcoded "Medical Consumables") -------
const PHARM_EN = /\b(TABLET|CAPSULE|INJECTION|AMPOULE|VIAL|SYRUP|SUSPENSION|OINTMENT|INFUSION|VACCINE|INSULIN|MG|ML|IU)\b/i;
const PHARM_AR = /(حبوب|حقن|كبسولات|أدوية|ادوية|دواء|لقاح|شراب|مرهم|محاليل وريدية|صيدل)/;
const EQUIP_EN = /\b(MACHINE|SYSTEM|MONITOR|SCANNER|ANALYZER|ANALYSER|INSTRUMENT|DEVICE|CHAIR|BED|PUMP|VENTILATOR|MICROSCOPE|CENTRIFUGE|INCUBATOR|LASER|X-?RAY|ULTRASOUND|WHEEL ?CHAIR)\b/i;
const EQUIP_AR = /(جهاز|أجهزة|اجهزة|معدات|ماكينة|تركيب)/;
// Consumable accessories often contain an equipment noun ("MICROSCOPE cover
// slide", "VENTILATOR tube"), so these markers are checked BEFORE the equipment
// patterns — otherwise disposables get filed as capital equipment.
const CONSUM_EN = /\b(SLIDE|SWAB|GAUZE|GLOVE|SYRINGE|NEEDLE|CATHETER|MASK|DRESSING|BANDAGE|TUBING|BAG|CONTAINER|WIPE|PAD|NAPKIN|APPLICATOR|TIP|COVER|FILTER|PIPETTE|REAGENT|CUVETTE|LANCET|ELECTRODE|DIAPER|SHEET|GOWN|DRAPE)\b/i;
function subSectorFor(title, items){
  const t = String(title || "");
  const en = (items || []).map(i => i.d).join(" ");
  // MoH titles routinely embed English product names inside Arabic text
  // (e.g. "شراء WHEEL CHAIR BARIATRIC 60 CM"), so the English patterns must be
  // tested against the title as well as the item schedule.
  const all = `${t} ${en}`;
  if (PHARM_EN.test(all) || PHARM_AR.test(t)) return "Pharmaceuticals";
  if (CONSUM_EN.test(all)) return "Medical Consumables";
  if (EQUIP_EN.test(all) || EQUIP_AR.test(t)) return "Medical Equipment";
  return "Medical Consumables";
}

// ---- real description (was an identical placeholder on every tender) -------
function describeTender(r, d = {}, items = []){
  if (items.length){
    const head = items.slice(0, 3).map(i => {
      const qty = i.q ? ` (${i.q.toLocaleString()} ${i.u || ""})`.replace(/ \)$/, ")") : "";
      return `${i.d}${qty}`;
    }).join("; ");
    const more = items.length > 3 ? ` … +${items.length - 3} more line items` : "";
    return (head + more).slice(0, 400);
  }
  const bits = [];
  if (r.type)   bits.push(typeEN(r.type));
  if (r.entity) bits.push(r.entity);
  const tail = bits.length ? ` — ${bits.join(" · ")}` : "";
  const base = `${String(r.title || "").trim()}${tail}`.trim();
  return (base || "Medical / healthcare procurement — Kuwait (CTC)").slice(0, 400);
}


// ---- attachments: fetch a tender's PDFs, ref-named one FIRST ---------------
// Tenders whose item schedule is published attach a PDF whose filename contains
// the tender ref (e.g. ...5DI073.pdf for ref 5DI073). Generic batch scans
// (Doc1.pdf) are one-page adverts with no schedule, so try the ref-named file
// first and stop as soon as items are found.
async function pdfPass(j, id, ref){
  const r = await get(j, `https://www.ctckw.com/TenderDetails.aspx?tdc_id=${id}`);
  const html = await r.text();
  const hrefs = [...html.matchAll(/href\s*=\s*["']([^"']*DataFiles[^"']*\.pdf(?:\?[^"']*)?)["']/gi)].map(m => m[1]);
  if (!hrefs.length) return [];
  const key = String(ref || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const score = (h) => {
    const f = h.split("/").pop().replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    if (key && f.includes(key)) return 0;          // ref-named → best
    if (/DOC\d+\.PDF(?:\?|$)/i.test(h)) return 2;         // generic batch advert → worst
    return 1;
  };
  hrefs.sort((a, b) => score(a) - score(b));
  for (const h of hrefs.slice(0, 2)) {            // at most 2 PDFs per tender
    const url = h.startsWith("http") ? h : `https://www.ctckw.com/${h.replace(/^\/+/, "")}`;
    try {
      const pr = await fetchT(url, { headers: { "User-Agent": UA } }, 5000);
      if (!pr.ok) continue;
      const buf = await pr.arrayBuffer();
      if (buf.byteLength > 6e6) continue;          // skip very large scans
      const items = await pdfItemsOf(buf);
      if (items.length) return items;
    } catch { /* ignore this attachment */ }
  }
  return [];
}

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

const toRecord = (r, d={}, items=[]) => ({
  nashraaId: "CTC-"+r.id, refId: d.ref||"", publisher: "Ministry of Health - "+(r.entity||""),
  type: typeEN(r.type), summary: r.title,
  // Real, per-tender description. Built from the PDF item schedule when the PDF
  // pass has run; otherwise from title + notice type + buying department. Never
  // the same string on every record (the old placeholder made the app useless).
  description: describeTender(r, d, items),
  sector: "Medical", subSector: subSectorFor(r.title, items),
  postDate: iso(r.post), deadline: iso(r.dead),
  status: statusEN(r.status), mainSector: "Health",
  price: d.price||"", insurance: d.bond||"",
  hasOpeningBids: d.hasBids ? "Yes" : "No",
  items: items.length ? items : null,
  itemCount: items.length,
  _ctcId: r.id, _src: "ctc",
});


// ---- BACKFILL MODE ---------------------------------------------------------
// Every tender written before this version carries an identical placeholder
// description and subSector "Medical Consumables". Those fields can be rebuilt
// entirely from data ALREADY in Firebase (summary / type / publisher) — no CTC
// fetch, no external data, so it is fast and safe. Item schedules still need the
// PDF pass, which the daily run chews through for new tenders.
//
// Trigger:  /.netlify/functions/ctc-sync?backfill=1[&limit=1500]
// Resumable: cursor stored at pipeline/backfillCursor; re-invoke until done:true
const PLACEHOLDER = "Medical / healthcare procurement — Kuwait (CTC)";
async function runBackfill(limit){
  const all = (await fbGet("tenders")) || {};
  const keys = Object.keys(all).sort();
  const cursor = String((await fbGet("pipeline/backfillCursor")) || "");
  let start = 0;
  if (cursor) { const i = keys.indexOf(cursor); start = i >= 0 ? i + 1 : 0; }

  const patch = {};
  let scanned = 0, fixedDesc = 0, fixedSub = 0, last = cursor;
  for (let i = start; i < keys.length && scanned < limit; i++) {
    const k = keys[i], t = all[k] || {};
    scanned++; last = k;
    const items = Array.isArray(t.items) ? t.items : [];
    // description: replace the placeholder (or an empty/echoed-title value)
    const needDesc = !t.description || t.description === PLACEHOLDER || t.description === t.summary;
    if (needDesc) {
      const d = describeTender({ title: t.summary, type: t.type, entity: (t.publisher || "").replace("Ministry of Health - ", "") }, {}, items);
      if (d && d !== t.description) { patch[k + "/description"] = d; fixedDesc++; }
    }
    // subSector: recompute; only patch when it actually changes
    const ss = subSectorFor(t.summary, items);
    if (ss !== t.subSector) { patch[k + "/subSector"] = ss; fixedSub++; }
  }
  if (Object.keys(patch).length) {
    await fbPatch("tenders", patch);
    await fbPut("tenders_version", Date.now());
  }
  const done = (start + scanned) >= keys.length;
  await fbPut("pipeline/backfillCursor", done ? "" : last);
  return { total: keys.length, from: start, scanned, fixedDesc, fixedSub,
           patched: Object.keys(patch).length, done };
}

export default async (req) => {
  const log = [];
  const t0 = Date.now();
  try {
    // BACKFILL: repair descriptions/sub-sectors on already-stored tenders.
    // Needs only FIREBASE_URL, so it runs even if CTC/Resend creds are absent.
    try {
      const u = new URL(req.url);
      if (u.searchParams.get("backfill")) {
        if (!FB) return new Response("Missing FIREBASE_URL", { status: 500 });
        const limit = Math.min(Number(u.searchParams.get("limit")) || 1500, 4000);
        const res = await runBackfill(limit);
        console.log("[ctc-sync] backfill", JSON.stringify(res));
        return new Response(JSON.stringify({ ok: true, mode: "backfill", ...res }),
          { headers: { "Content-Type": "application/json" } });
      }
    } catch (e) {
      console.error("[ctc-sync] backfill error:", String(e));
      return new Response(JSON.stringify({ ok: false, mode: "backfill", error: String(e) }),
        { status: 500, headers: { "Content-Type": "application/json" } });
    }

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

    // Fetch BOTH the Health category (11 — medical goods/lab) AND the Studies &
    // Consultations category (35 — where medical-facility DESIGN & SUPERVISION
    // tenders live). Merge + dedupe by id; the medical filter keeps only the
    // health-related ones from category 35.
    const rows11 = await fetchTenders(j, firstPage, "11");
    const rows35 = await fetchTenders(j, firstPage, "35");
    const byId = new Map();
    [...rows11, ...rows35].forEach(r => { if(r.id && !byId.has(r.id)) byId.set(r.id, r); });
    const rows = [...byId.values()];
    const maxRowId = rows.reduce((m,r)=>Math.max(m,Number(r.id)||0),0);
    console.log("[ctc-sync] cat11=", rows11.length, "cat35=", rows35.length, "merged=", rows.length);
    log.push("api rows="+rows.length);
    console.log("[ctc-sync] rows=", rows.length, "maxRowId=", maxRowId);
    const isMedical = (r) => { const b = `${r.title} ${r.entity}`; return MED.test(b) && !NOTMED.test(b); };

    // new = id > lastMaxId & medical; OLDEST first so we always make progress,
    // and CAP per run so the enrich loop can't exceed the 60s function limit.
    const freshAll = rows.filter(r => Number(r.id) > lastMaxId && isMedical(r))
                         .sort((a,b)=> Number(a.id) - Number(b.id));
    const batch = freshAll.slice(0, BATCH);
    console.log("[ctc-sync] freshAll=", freshAll.length, "processing=", batch.length);

    // Build records DIRECTLY from the list API rows. Per-tender enrichment
    // (price/bond/refId via TenderDetails.aspx) is DISABLED: those detail fetches
    // hang on CTC's side and their AbortController timeout doesn't cancel in this
    // runtime, so the enrich loop never resolved — that stalled the pipeline for a
    // week. Everything essential (title/dates/status/publisher) is already in the
    // list API. Enrichment can be re-added later as a separate bounded job.
    let records = batch.map(r => toRecord(r, {}));
    // DEDUPE: CTC lists one tender under multiple consecutive tdc_ids (identical
    // title / deadline / publisher). Collapse within this batch AND drop any whose
    // signature already exists in /tenders, so neither Firebase nor the email
    // digest ever contains duplicate cards.
    {
      // Within-batch only: collapse the same practice re-listed under consecutive
      // tdc_ids (identical title/deadline/publisher, e.g. 6LS216 ×4) so the email
      // shows one card. refId is "" at insert (enrichment disabled) so it is a
      // no-op here but kept for parity with the app signature. NOTE: no cross-
      // history drop — matching an OLD tender's title must NOT hide a NEW distinct
      // practice that happens to share a truncated title (6SU008 vs 6SU004).
      const _sig = (t) => `${t.refId||''}|${t.summary||''}|${t.deadline||''}|${t.publisher||''}`;
      const _seen = new Set();
      records = records.filter(t => { const s=_sig(t); if(_seen.has(s)) return false; _seen.add(s); return true; });
    }
    console.log("[ctc-sync] records (deduped)=", records.length, "t=", Date.now()-t0, "ms");
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

    // AUTO DEADLINE/STATUS REFRESH: CTC can extend a tender's deadline or change
    // its status after we first stored it. Every run, compare CTC's CURRENT
    // deadline/status (from the list API we already fetched) against what we hold
    // for tenders we ALREADY track, and patch any that changed. Covers the
    // ~200-most-recent per category (where active tenders live), and runs whether
    // or not there were new tenders this run.
    try {
      const existing = (await fbGet("tenders")) || {};
      const refreshPatch = {}; let refreshed = 0;
      for (const r of rows) {
        if (!isMedical(r)) continue;
        const key = "CTC-" + r.id, ex = existing[key];
        if (!ex) continue;                       // brand-new ones are handled by the write above
        const nd = iso(r.dead), ns = statusEN(r.status);
        let changed = false;
        if (nd && ex.deadline !== nd) { refreshPatch[key+"/deadline"] = nd; changed = true; }
        if (ns && ex.status   !== ns) { refreshPatch[key+"/status"]   = ns; changed = true; }
        if (changed) refreshed++;
      }
      if (Object.keys(refreshPatch).length) { await fbPatch("tenders", refreshPatch); await fbPut("tenders_version", Date.now()); }
      log.push("refreshed "+refreshed);
      console.log("[ctc-sync] deadline/status refresh:", refreshed, "updated");
    } catch(e) { console.log("[ctc-sync] refresh skipped:", String(e)); }

    // STATUS CLOSE-OUT — measured 8 Sep 2026: CTC keeps reporting "جديد" long after
    // a tender closes, so /tenders held status "New" for 1,357 of 1,358 records and
    // every status-based filter, here and in the app, was meaningless. The refresh
    // above only covers the ~200 most recent per category, so older records were
    // never revised at all. The deadline is authoritative: anything past it cannot
    // be bid on. Firebase-only — no CTC fetch — so this costs one read and one
    // patch, and after the first run it only touches newly expired records.
    try {
      const allT = (await fbGet("tenders")) || {};
      const today = new Date().toISOString().slice(0, 10);
      const closePatch = {};
      for (const k of Object.keys(allT)) {
        const t = allT[k] || {};
        const d = String(t.deadline || "").slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;   // unparsable — leave alone
        if (d >= today) continue;                        // still biddable
        if (/^(Closed|Cancelled|Awarded)$/i.test(String(t.status || ""))) continue;
        closePatch[k + "/status"] = "Closed";
      }
      if (Object.keys(closePatch).length) {
        await fbPatch("tenders", closePatch);
        await fbPut("tenders_version", Date.now());
      }
      log.push("closed " + Object.keys(closePatch).length);
      console.log("[ctc-sync] close-out:", Object.keys(closePatch).length, "expired -> Closed");
    } catch (e) { console.log("[ctc-sync] close-out skipped:", String(e)); }

    // best-effort enrichment (refId/price/bond) — runs AFTER write+email so it can
    // NEVER stall the pipeline. Each TenderDetails fetch is raced against a 3.5s
    // wall-clock timer (those fetches can hang on CTC's side); hung ones are
    // abandoned. Kept small/gentle to avoid CTC rate-limiting. Patches only the
    // enriched fields onto the already-written nodes via slash-path keys.
    if (records.length) {
      const cap = records.slice(0, 10), CONC = 3, patch = {};
      const raceEnrich = (id) => Promise.race([ enrich(j,id).catch(()=>null), new Promise(r=>setTimeout(()=>r(null),3500)) ]);
      let enriched = 0;
      for (let i=0;i<cap.length;i+=CONC){
        const res = await Promise.all(cap.slice(i,i+CONC).map(async t => ({t, d: await raceEnrich(t._ctcId)})));
        res.forEach(({t,d}) => { if(d && (d.ref||d.price||d.bond)){ patch[t.nashraaId+"/refId"]=d.ref||""; patch[t.nashraaId+"/price"]=d.price||""; patch[t.nashraaId+"/insurance"]=d.bond||""; enriched++; } });
      }
      if (Object.keys(patch).length){ await fbPatch("tenders", patch); await fbPut("tenders_version", Date.now()); }
      log.push("enriched "+enriched+"/"+cap.length);
      console.log("[ctc-sync] enriched", enriched, "/", cap.length, "t=", Date.now()-t0, "ms");
    }

    // PDF PASS — read each new tender's attachment to recover the real item
    // schedule, then upgrade description + subSector + items on the stored node.
    // Runs LAST (after write + email) and is hard-capped, so a slow or hanging
    // CTC attachment can never prevent the pipeline from writing or emailing —
    // that failure mode stalled this pipeline for a week and must not return.
    if (records.length) {
      // Raised from 8: the budgetLeft() guard below already bounds this pass, so
      // the cap only needs to stop a heavy day from starving the budget. Anything
      // still unscanned is picked up by ctc-backfill, which skips records already
      // marked itemsTried.
      const PDF_CAP = 15, PDF_CONC = 2, patch = {};
      const budgetLeft = () => 45000 - (Date.now() - t0);     // leave ~15s headroom
      const racePdf = (id, ref) => Promise.race([
        pdfPass(j, id, ref).catch(() => []),
        new Promise(r => setTimeout(() => r([]), 6000)),
      ]);
      const cap = records.slice(0, PDF_CAP);
      let withItems = 0, scanned = 0;
      for (let i = 0; i < cap.length; i += PDF_CONC) {
        if (budgetLeft() < 8000) { console.log("[ctc-sync] pdf pass: out of budget, stopping"); break; }
        const res = await Promise.all(cap.slice(i, i + PDF_CONC).map(async t => ({ t, items: await racePdf(t._ctcId, t.refId) })));
        res.forEach(({ t, items }) => {
          scanned++;
          if (!items.length) {
            // Tell ctc-backfill this one was already attempted, so its active pass
            // does not pay to scan it again.
            patch[t.nashraaId + "/itemsTried"] = new Date().toISOString().slice(0, 10);
            return;
          }
          withItems++;
          patch[t.nashraaId + "/items"]       = items;
          patch[t.nashraaId + "/itemCount"]   = items.length;
          patch[t.nashraaId + "/description"] = describeTender(
            { title: t.summary, type: t.type,
              entity: String(t.publisher || "").replace("Ministry of Health - ", "") }, {}, items);
          patch[t.nashraaId + "/subSector"]   = subSectorFor(t.summary, items);
        });
      }
      if (Object.keys(patch).length) { await fbPatch("tenders", patch); await fbPut("tenders_version", Date.now()); }
      log.push(`pdf ${withItems}/${scanned}`);
      console.log("[ctc-sync] pdf pass:", withItems, "of", scanned, "yielded items, t=", Date.now()-t0, "ms");
    }

    const remaining = Math.max(0, freshAll.length - records.length);
    console.log("[ctc-sync] === done in", Date.now()-t0, "ms", JSON.stringify(log), "remaining=", remaining);
    return new Response(JSON.stringify({ok:true, remaining, log}), {headers:{"Content-Type":"application/json"}});
  } catch (e) {
    console.error("[ctc-sync] ERROR after", Date.now()-t0, "ms:", String(e), "| log:", JSON.stringify(log));
    return new Response(JSON.stringify({ok:false, error:String(e), log}), {status:500, headers:{"Content-Type":"application/json"}});
  }
};
