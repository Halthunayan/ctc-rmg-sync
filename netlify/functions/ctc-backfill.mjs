// ============================================================================
// CTC -> RMG BACKFILL — Netlify HTTP function (NOT scheduled).
//
// Repairs tenders written before the description/sub-sector fix: every record
// carried the SAME placeholder description and was filed as "Medical
// Consumables". Both fields are rebuilt from data already in Firebase
// (summary / type / publisher), so this needs no CTC fetch and no external
// input — it is fast and safe to re-run.
//
// NOTE: this deliberately has NO `export const config = { schedule }`. A
// scheduled Netlify function is not publicly HTTP-invocable and returns an
// empty 403 to outside callers, which is why the backfill could not live
// inside ctc-sync.mjs.
//
// Usage:  /.netlify/functions/ctc-backfill?limit=1500
//         re-invoke until {"done":true}.  ?reset=1 restarts the cursor.
// Env:    FIREBASE_URL, FIREBASE_TOKEN (optional)
// ============================================================================

const FB    = (process.env.FIREBASE_URL || "").replace(/\/+$/, "");
const FBTOK = process.env.FIREBASE_TOKEN || "";

const fetchT = (url, opts = {}, ms = 9000) => {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(new Error(`timeout ${ms}ms`)), ms);
  return fetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(to));
};
const fbUrl   = (p) => `${FB}/${p}.json${FBTOK ? `?auth=${encodeURIComponent(FBTOK)}` : ""}`;
const fbGet   = async (p) => { const r = await fetchT(fbUrl(p), {}, 9000); return r.ok ? r.json() : null; };
const fbPatch = async (p, o) => fetchT(fbUrl(p), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) }, 9000);
const fbPut   = async (p, v) => fetchT(fbUrl(p), { method: "PUT",   headers: { "Content-Type": "application/json" }, body: JSON.stringify(v) }, 9000);

const typeEN = (a) => ({ "ممارسة":"Practice","مناقصة":"Tender","مزايدة":"Auction","مزاد":"Auction","استدراج عروض":"RFQ","خدمات استشارية":"Consulting","تأهيل":"Prequalification","استثمار":"Investment" }[String(a).trim()] || a || "");

const PHARM_EN  = /\b(TABLET|CAPSULE|INJECTION|AMPOULE|VIAL|SYRUP|SUSPENSION|OINTMENT|INFUSION|VACCINE|INSULIN|IU)\b/i;
const PHARM_AR  = /(حبوب|حقن|كبسولات|أدوية|ادوية|دواء|لقاح|شراب|مرهم|محاليل وريدية|صيدل|مضاد حيوي)/;
const CONSUM_EN = /\b(SLIDE|SWAB|GAUZE|GLOVE|SYRINGE|NEEDLE|CATHETER|MASK|DRESSING|BANDAGE|TUBING|BAG|CONTAINER|WIPE|PAD|NAPKIN|APPLICATOR|TIP|COVER|FILTER|PIPETTE|REAGENT|CUVETTE|LANCET|ELECTRODE|DIAPER|SHEET|GOWN|DRAPE)\b/i;
const CONSUM_AR = /(قفازات|شاش|ضمادات|حقن طبية|مستهلكات|فوط|أقنعة|كمامات|مسحات)/;
const EQUIP_EN  = /\b(MACHINE|SYSTEM|MONITOR|SCANNER|ANALYZER|ANALYSER|INSTRUMENT|DEVICE|CHAIR|BED|PUMP|VENTILATOR|MICROSCOPE|CENTRIFUGE|INCUBATOR|LASER|X-?RAY|ULTRASOUND|WHEEL ?CHAIR)\b/i;
const EQUIP_AR  = /(جهاز|أجهزة|اجهزة|معدات|ماكينة)/;

function subSectorFor(title, items) {
  const t  = String(title || "");
  const en = (items || []).map(i => i && i.d).filter(Boolean).join(" ");
  const all = `${t} ${en}`;
  if (PHARM_EN.test(all)  || PHARM_AR.test(t))  return "Pharmaceuticals";
  if (CONSUM_EN.test(all) || CONSUM_AR.test(t)) return "Medical Consumables";
  if (EQUIP_EN.test(all)  || EQUIP_AR.test(t))  return "Medical Equipment";
  return "Medical Consumables";
}

function describeTender(r, items = []) {
  if (items.length) {
    const head = items.slice(0, 3).map(i => {
      const qty = i.q ? ` (${Number(i.q).toLocaleString()} ${i.u || ""})`.replace(/ \)$/, ")") : "";
      return `${i.d}${qty}`;
    }).join("; ");
    const more = items.length > 3 ? ` … +${items.length - 3} more line items` : "";
    return (head + more).slice(0, 400);
  }
  const bits = [];
  if (r.type)   bits.push(typeEN(r.type));
  if (r.entity) bits.push(r.entity);
  const tail = bits.length ? ` — ${bits.join(" · ")}` : "";
  return `${String(r.title || "").trim()}${tail}`.trim().slice(0, 400);
}


// ---- PDF MODE (?pdf=1) -----------------------------------------------------
// Fills item schedules on tenders that have none, by logging in to CTC and
// reading each tender's attachment. Bounded per invocation and resumable via
// its own cursor, so it is re-invoked until {"done":true}. Kept separate from
// the description backfill because it needs a CTC session and is far slower.
const UA = "Mozilla/5.0 (compatible; RMG-CTC-Sync/1.0)";
const CTC_T = 8000;

function jar(){ const c={}; return {
  hdr(){ return Object.entries(c).map(([k,v])=>`${k}=${v}`).join("; "); },
  take(res){ const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie")].filter(Boolean);
    (sc||[]).forEach(x=>{ const m=x.match(/^([^=]+)=([^;]*)/); if(m) c[m[1]]=m[2]; }); }
};}
const cget = (j,u)=> fetchT(u,{headers:{Cookie:j.hdr(),"User-Agent":UA}},CTC_T);

async function ctcLogin(j){
  const LOGIN = "https://www.ctckw.com/UserLogin.aspx?lang=ar";
  let r = await fetchT(LOGIN,{headers:{"User-Agent":UA}},CTC_T); j.take(r);
  const html = await r.text();
  const f = {};
  for (const m of html.matchAll(/<input[^>]*type="hidden"[^>]*>/gi)){
    const n=(m[0].match(/name="([^"]+)"/)||[])[1]; const v=(m[0].match(/value="([^"]*)"/)||[])[1]||"";
    if(n) f[n]=v;
  }
  f["__EVENTTARGET"]="ctl00$ContentPlaceHolder1$btnLogin";
  f["__EVENTARGUMENT"]="";
  f["ctl00$ContentPlaceHolder1$txtPinCode1"]=process.env.CTC_USER;
  f["ctl00$ContentPlaceHolder1$txtPinCode2"]=process.env.CTC_PASS;
  let r2 = await fetchT(LOGIN,{method:"POST",redirect:"manual",
    headers:{"Content-Type":"application/x-www-form-urlencoded",Cookie:j.hdr(),"User-Agent":UA},
    body:new URLSearchParams(f).toString()},CTC_T); j.take(r2);
  const chk = await cget(j,"https://www.ctckw.com/TendersSearch.aspx?CategoryID=11");
  const t = await chk.text();
  if (/txtPinCode2/i.test(t) || /UserLogin\.aspx/i.test(chk.url)) throw new Error("CTC login failed");
  return true;
}

// Text extraction uses unpdf (serverless pdf.js build). A hand-rolled
// zlib+regex extractor was tried first and PROVEN WRONG against a real CTC
// file: it returned 68k chars of metadata garbage ("ar-KWar-SA", null bytes)
// where poppler returned 491k chars of real Arabic. It cannot decode CID /
// Identity-H font encodings, which is exactly what these PDFs use.
// Measured: 219-page CTC PDF -> 233,628 chars in 732 ms.
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
async function pdfForTender(j,id,ref){
  const r = await cget(j,`https://www.ctckw.com/TenderDetails.aspx?tdc_id=${id}`);
  const html = await r.text();
  const hrefs=[...html.matchAll(/href\s*=\s*["']([^"']*DataFiles[^"']*\.pdf(?:\?[^"']*)?)["']/gi)].map(m=>m[1]);
  if(!hrefs.length) return [];
  const key=String(ref||"").replace(/[^A-Za-z0-9]/g,"").toUpperCase();
  const score=(h)=>{ const f=h.split("/").pop().replace(/[^A-Za-z0-9]/g,"").toUpperCase();
    if(key&&f.includes(key)) return 0; if(/DOC\d+\.PDF(?:\?|$)/i.test(h)) return 2; return 1; };
  hrefs.sort((a,b)=>score(a)-score(b));
  for(const h of hrefs.slice(0,2)){
    const url=h.startsWith("http")?h:`https://www.ctckw.com/${h.replace(/^\/+/,"")}`;
    try{
      const pr=await fetchT(url,{headers:{Cookie:j.hdr(),"User-Agent":UA}},5000);
      if(!pr.ok) continue;
      const buf=await pr.arrayBuffer();
      if(buf.byteLength>6e6) continue;
      const items=await pdfItemsOf(buf);
      if(items.length) return items;
    }catch{}
  }
  return [];
}

// Netlify synchronous functions cap around 10s. Measured cost is ~2s to log in
// plus ~2s per tender, so only a handful fit per invocation — hence the small
// default limit and the tight budget guard below.
const OPEN_STATUS = /^(Open|New|Under Review|On Hold|Postponed)$/i;
// Measured 2026-09-08: ctc-sync writes status "New" for 1,357 of 1,358 records
// and never revises it, so a status-only filter keeps everything. The deadline
// is the only usable signal for "still biddable" (267 of 1,358). Status is
// retained only as a fallback when a record carries no parsable deadline.
function normDate(d){
  const x = String(d || "").trim();
  const a = x.match(/^(\d{4})[\/-](\d{2})[\/-](\d{2})/); if (a) return a[1]+"-"+a[2]+"-"+a[3];
  const b = x.match(/^(\d{2})[\/-](\d{2})[\/-](\d{4})/); if (b) return b[3]+"-"+b[2]+"-"+b[1];
  return "";
}
function isBiddable(t){
  const nd = normDate(t && t.deadline);
  if (nd) return nd >= new Date().toISOString().slice(0, 10);
  return OPEN_STATUS.test(String((t && t.status) || ""));
}
async function runPdfPass(limit, t0, activeOnly, repair){
  const all=(await fbGet("tenders"))||{};
  const keys=Object.keys(all).sort();
  const CUR = repair ? "pipeline/repairCursor" : "pipeline/pdfCursor";
  const cursor=String((await fbGet(CUR))||"");
  let start=0; if(cursor){ const i=keys.indexOf(cursor); start=i>=0?i+1:0; }

  const j=jar(); await ctcLogin(j);

  const patch={}; let scanned=0, withItems=0, skipped=0, last=cursor;
  const budget=()=> 8500-(Date.now()-t0);           // Netlify sync limit is ~10s
  for(let i=start;i<keys.length&&scanned<limit;i++){
    if(budget()<3000) break;
    const k=keys[i], t=all[k]||{};
    last=k;
    const hasItems = Array.isArray(t.items) && t.items.length > 0;
    // repair mode inverts the filter: only records that already carry items are
    // re-parsed, so a bad parse can be corrected without rescanning the corpus.
    if(repair ? !hasItems : hasItems){ skipped++; continue; }
    // active-only mode: skip closed/cancelled tenders — they cannot be bid on,
    // and scanning them burns the whole budget for no operational value.
    if(activeOnly && !isBiddable(t)){ skipped++; continue; }
    scanned++;
    const items=await Promise.race([
      pdfForTender(j,t._ctcId,t.refId).catch(()=>[]),
      new Promise(r=>setTimeout(()=>r([]),6000)),
    ]);
    if(!items.length){
      if(repair){ // the old parse was wrong and nothing valid replaces it
        patch[k+"/items"]=null; patch[k+"/itemCount"]=0;
        patch[k+"/description"]=describeTender({title:t.summary,type:t.type,
          entity:String(t.publisher||"").replace("Ministry of Health - ","")},[]);
      }
      continue;
    }
    withItems++;
    patch[k+"/items"]=items;
    patch[k+"/itemCount"]=items.length;
    patch[k+"/description"]=describeTender({title:t.summary,type:t.type,
      entity:String(t.publisher||"").replace("Ministry of Health - ","")},items);
    patch[k+"/subSector"]=subSectorFor(t.summary,items);
  }
  if(Object.keys(patch).length){ await fbPatch("tenders",patch); await fbPut("tenders_version",Date.now()); }
  const done=(keys.indexOf(last)+1)>=keys.length;
  await fbPut(CUR, done?"":last);
  return { mode: repair ? "pdf-repair" : (activeOnly ? "pdf-active" : "pdf"), total:keys.length, scanned, skipped, withItems,
           patched:Object.keys(patch).length, done, ms:Date.now()-t0 };
}

const PLACEHOLDER = "Medical / healthcare procurement — Kuwait (CTC)";

export default async (req) => {
  const t0 = Date.now();
  try {
    if (!FB) return new Response(JSON.stringify({ ok:false, error:"Missing FIREBASE_URL" }), { status:500, headers:{ "Content-Type":"application/json" } });
    const u = new URL(req.url);
    const limit = Math.min(Number(u.searchParams.get("limit")) || 1500, 5000);

    // ?stats=1 — READ-ONLY. Status/type histogram for /tenders, plus how many
    // records the active filter actually keeps. Answers "how many tenders are
    // really open", which was previously guessed from an app KPI card that
    // spans a different, much larger store.
    if (u.searchParams.get("stats")) {
      const all = (await fbGet("tenders")) || {};
      const keys = Object.keys(all);
      const byStatus = {}, byType = {};
      let withItems = 0, open = 0, openNoItems = 0, future = 0;
      const samples = [];
      const today = new Date().toISOString().slice(0, 10);
      const norm = (d) => { const x = String(d || "").trim();
        const m = x.match(/^(\d{4})[\/-](\d{2})[\/-](\d{2})/); if (m) return m[1] + "-" + m[2] + "-" + m[3];
        const m2 = x.match(/^(\d{2})[\/-](\d{2})[\/-](\d{4})/); if (m2) return m2[3] + "-" + m2[2] + "-" + m2[1];
        return ""; };
      for (const k of keys) {
        const t = all[k] || {};
        const st = String(t.status || "(none)");
        byStatus[st] = (byStatus[st] || 0) + 1;
        const ty = String(t.type || "(none)");
        byType[ty] = (byType[ty] || 0) + 1;
        const has = Array.isArray(t.items) && t.items.length > 0;
        if (has) { withItems++;
          if (samples.length < 4) samples.push({ ref:t.refId, deadline:t.deadline,
            itemCount:t.itemCount, subSector:t.subSector,
            description:String(t.description || "").slice(0, 200),
            items:(t.items || []).slice(0, 3) });
        }
        const isOpen = OPEN_STATUS.test(st);
        if (isOpen) { open++; if (!has) openNoItems++; }
        const nd = norm(t.deadline);
        if (nd && nd >= today) future++;
      }
      return new Response(JSON.stringify({ ok:true, mode:"stats", total:keys.length,
        open, openNoItems, futureDeadline:future, withItems, byStatus, byType,
        deadlineSamples: keys.slice(0, 3).map(k => (all[k] || {}).deadline),
        samples,
        ms:Date.now()-t0 }), { headers:{ "Content-Type":"application/json" } });
    }

    // ?probe=<refId|nashraaId> — READ-ONLY diagnostic. Proves the extraction
    // path end-to-end for ONE tender: which PDFs the detail page exposes, which
    // one the scorer picks, how many characters unpdf recovers, and how many
    // items the parser finds. Writes nothing to Firebase and touches no cursor.
    const probe = u.searchParams.get("probe");
    if (probe) {
      if (!process.env.CTC_USER || !process.env.CTC_PASS)
        return new Response(JSON.stringify({ ok:false, error:"Missing CTC_USER / CTC_PASS" }), { status:500, headers:{ "Content-Type":"application/json" } });
      const all = (await fbGet("tenders")) || {};
      const norm = (x)=> String(x||"").replace(/[^A-Za-z0-9]/g,"").toUpperCase();
      const want = norm(probe);
      const k = Object.keys(all).find(x => norm(x)===want || norm((all[x]||{}).refId)===want);
      if (!k) return new Response(JSON.stringify({ ok:false, mode:"probe", probe, error:"not found in /tenders", total:Object.keys(all).length }), { status:404, headers:{ "Content-Type":"application/json" } });
      const t = all[k] || {};
      const j = jar(); await ctcLogin(j);
      const r = await cget(j, `https://www.ctckw.com/TenderDetails.aspx?tdc_id=${t._ctcId}`);
      const html = await r.text();
      const hrefs = [...html.matchAll(/href\s*=\s*["']([^"']*DataFiles[^"']*\.pdf(?:\?[^"']*)?)["']/gi)].map(m=>m[1]);
      const dbg = {
        htmlLen: html.length,
        pageHasLoginForm: /txtPinCode2/i.test(html),
        pdfMentions: (html.match(/\.pdf/gi) || []).length,
        dataFilesMentions: (html.match(/DataFiles/gi) || []).length,
        titleTag: ((html.match(/<title[^>]*>([\s\S]{0,120})<\/title>/i) || [])[1] || "").trim(),
        anchorSample: [...html.matchAll(/href\s*=\s*["']([^"']{1,200})["']/gi)]
          .map(m => m[1]).filter(x => !/^(#|javascript:)/i.test(x)).slice(0, 25),
      };
      const key = norm(t.refId);
      const score = (h)=>{ const f = norm(h.split("/").pop());
        if (key && f.includes(key)) return 0; if (/DOC\d+\.PDF(?:\?|$)/i.test(h)) return 2; return 1; };
      hrefs.sort((a,b)=>score(a)-score(b));
      const tried = [];
      for (const h of hrefs.slice(0,2)) {
        const url = h.startsWith("http") ? h : `https://www.ctckw.com/${h.replace(/^\/+/,"")}`;
        const rec = { href:h, score:score(h) };
        try {
          const pr = await fetchT(url, { headers:{ Cookie:j.hdr(), "User-Agent":UA } }, 5000);
          rec.httpStatus = pr.status;
          if (pr.ok) {
            const buf = await pr.arrayBuffer();
            rec.bytes = buf.byteLength;
            // pdf.js detaches the ArrayBuffer it is given, so keep a copy for the
            // second parse below.
            const copy = buf.slice(0);
            if (buf.byteLength <= 6e6) {
              const txt = await pdfTextOf(buf);
              rec.textLen = txt.length;
              rec.sample = txt.slice(0, Math.min(Number(u.searchParams.get("sample")) || 400, 40000));
              const it = await pdfItemsOf(copy);
              rec.itemCount = it.length;
              rec.items = it.slice(0, 5);
            } else rec.note = "over 6MB cap — skipped by the real pass too";
          }
        } catch (e) { rec.error = String((e && e.message) || e); }
        tried.push(rec);
        if (Date.now() - t0 > 8000) { rec.aborted = "budget"; break; }
      }
      return new Response(JSON.stringify({ ok:true, mode:"probe", key, refId:t.refId, ctcId:t._ctcId,
        status:t.status, hasItems:Array.isArray(t.items)?t.items.length:0, pdfHrefs:hrefs.length,
        dbg, tried, ms:Date.now()-t0 }), { headers:{ "Content-Type":"application/json" } });
    }

    if (u.searchParams.get("pdf")) {
      if (!process.env.CTC_USER || !process.env.CTC_PASS)
        return new Response(JSON.stringify({ ok:false, error:"Missing CTC_USER / CTC_PASS" }), { status:500, headers:{ "Content-Type":"application/json" } });
      const repair = !!u.searchParams.get("repair");
      if (u.searchParams.get("reset")) await fbPut(repair ? "pipeline/repairCursor" : "pipeline/pdfCursor", "");
      const res = await runPdfPass(Math.min(Number(u.searchParams.get("limit")) || 3, 10), t0, !!u.searchParams.get("active"), repair);
      console.log("[ctc-backfill]", JSON.stringify(res));
      return new Response(JSON.stringify({ ok:true, ...res }), { headers:{ "Content-Type":"application/json" } });
    }

    // reset applies ONLY to this mode's cursor. It previously ran BEFORE the pdf
    // branch, so `?pdf=1&reset=1` silently wiped the description cursor as well.
    if (u.searchParams.get("reset")) await fbPut("pipeline/backfillCursor", "");

    const all  = (await fbGet("tenders")) || {};
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
      const entity = String(t.publisher || "").replace("Ministry of Health - ", "");
      // description: replace the placeholder, an empty value, or a title echo
      if (!t.description || t.description === PLACEHOLDER || t.description === t.summary) {
        const d = describeTender({ title: t.summary, type: t.type, entity }, items);
        if (d && d !== t.description) { patch[k + "/description"] = d; fixedDesc++; }
      }
      const ss = subSectorFor(t.summary, items);
      if (ss !== t.subSector) { patch[k + "/subSector"] = ss; fixedSub++; }
    }

    if (Object.keys(patch).length) { await fbPatch("tenders", patch); await fbPut("tenders_version", Date.now()); }
    const done = (start + scanned) >= keys.length;
    await fbPut("pipeline/backfillCursor", done ? "" : last);

    const out = { ok:true, total:keys.length, from:start, scanned, fixedDesc, fixedSub,
                  patched:Object.keys(patch).length, done, ms: Date.now() - t0 };
    console.log("[ctc-backfill]", JSON.stringify(out));
    return new Response(JSON.stringify(out), { headers:{ "Content-Type":"application/json" } });
  } catch (e) {
    console.error("[ctc-backfill] ERROR", String(e));
    return new Response(JSON.stringify({ ok:false, error:String(e), ms: Date.now() - t0 }), { status:500, headers:{ "Content-Type":"application/json" } });
  }
};
