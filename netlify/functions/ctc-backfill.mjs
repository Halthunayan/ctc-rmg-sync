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
// Item schedules harvested by the browser-side CTC sweep (sweep_store/sweep.jsonl)
// that never reached /tenders, keyed by normalised refId, 2024 deadlines onward.
// Every row was passed through the same looksLikeDesc guard before embedding.
// Applying these needs no CTC session and no PDF parsing.
const SEED_ITEMS = {"4LB478":[{"d":"COBAS P-P/ MICRO SAMPLE CUPS 5085713001","u":"PCS","q":1800}],"4LB481":[{"d":"INTGR400 MICRO CUVETTES 21043862001","u":"PCS","q":400000}],"4LB485":[{"d":"DAKO COVERGLASS 24X50MM CS70430-2","u":"PCS","q":60000}],"4LB486":[{"d":"HEMOLET PEDIATRIC 1.25X0.4MM(28G)","u":"PCS","q":200000}],"4LB503":[{"d":"COBAS P-P/ ASSAY TIP/CUP TRAY 5694302001","u":"PCS","q":3780}],"4LB512":[{"d":"STERILE SPECIMEN CONTAINER 60ML LEAK PROOF WITH LABEL","u":"PCS","q":3000000}],"4LB517":[{"d":"AFFIRM SWABS AMIES TRANSPORT WITH SWABS 220245 CZ 300","u":"PCS","q":12500}],"4LB519":[{"d":"XN-SYSMEX SP SLIDES 5000PCS/BOX","u":"PCS","q":432000}],"4LB523":[{"d":"SWAB/ SAMPLE COLLECTION/ MRSA TESTING","u":"PCS","q":100000}],"4LB529":[{"d":"ACL ACUSTAR/ CUVETTES 0009801100","u":"PCS","q":72800}],"4LB545":[{"d":"B.B/BAG QUAD. LEUKOTRAP/MTL-1","u":"PCS","q":15000}],"4LB587":[{"d":"PIPETTE TIPS YELLOW 5-200 UL GELSON TYPE","u":"PCS","q":2300000}],"4LB621":[{"d":"SPERM A. IVOS SLIDES 20 U DEPTH 4-WELL CASE COUNTING CHAMBER LEJA,","u":"PCS","q":2000}],"4LB637":[{"d":"B.B/DUO SWAB (ALCOHOL ONLY) STICK INDIVIDUALY WRAPPED,(50-100 PCS EACH)","u":"PCS","q":170000}],"4LB641":[{"d":"TIPS 100-1000 UL BLUE STD 76MM","u":"PCS","q":750000},{"d":"FINNTIP-60 SIZE 0.5-200UL PP NATURAL LABSYSTEM CAT NO. 9400060 OR EQUIVALENT","u":"PCS","q":100000},{"d":"FINNTIP/PCR 0.5-25UL 9403030 LAB SYSTEM OR EQUIVALENT","u":"PCS","q":300000},{"d":"JENCONS FINNTIP 5-200uL AUTOCLEVABLE EPPENDORF 0030 073 428 OR EQUIVALENT","u":"PCS","q":600000},{"d":"TIPS 0.5-10 UL 70.1115 OR EQUIVALENT","u":"PCS","q":400000},{"d":"TIPS 100-5000UL 120MM STD 0030000978 OR EQUIVALENT","u":"PCS","q":250000},{"d":"PIPETTE SEROLOGICAL 10mL STR.PS STERILE ACCURATE AND POLYSTYRENE","u":"PCS","q":10000},{"d":"MICROTITRATION U-PLATE N/STR PS 96 WELL WITH 96 WELLS, STERILE, U","u":"PCS","q":15000},{"d":"CONTAINER S.C PP AUTOCLV. 40ML GRAD62555 OR EQUIVALENT ,CONTAINER SCREW CAPPED","u":"PCS","q":135000}],"4LB644":[{"d":"CYTOSPIN4/EZ SINGLE CYTOFUNNEL A78710003","u":"PCS","q":7000}],"4LS225":[{"d":"10 ML SEROLOGICAL PIPETS 10 ML RED INDIVIDUALLY PAPER/PLASTIC","u":"PCS","q":1000},{"d":"SPECIMEN COLLECTION CUPS CAP AND CONTAINER ASSEMBLED, WIDE MOUTH, TABBED","u":"PCS","q":1500}],"4LS230":[{"d":"EPT.I.P.S. TIP EPT.I.P.S. TIP, 2-200 MICROLITER, BIOPUR, STERILE, 53MM,","u":"PCS","q":1500},{"d":"DISPOSABLE POLYETHYLENE TRANSFER PIPETS, INDIVIDUALLY WRAPPED 3ML PIPETE, STERILE MEA TESTED","u":"PCS","q":2500}],"4LS246":[{"d":"TUBE, POLYSTYRENE ROUND-BOTTOM, 5ML PACKING: 500PCS/CASE","u":"PCS","q":1000},{"d":"TUBE, POLYSTYRENE ROUND-BOTTOM, 14ML PACKING: 500PCS/CASE","u":"PCS","q":12000},{"d":"TUBE,POLYSTYRENE CONICAL 15ML,17X120MM PACKING: 500PCS/CASE","u":"PCS","q":5000}],"4LS266":[{"d":"WHOLE BLOOD COLLECTION SYSTEM WITH IN-LINE FILTER (COMPOSELECT)","u":"PCS","q":15000}],"4LS269":[{"d":"ET SYRINGE CODAN INDIVIDUAL WRAPPING, EMBRYO TRANSFER","u":"PCS","q":1500}],"4LS295":[{"d":"55% W/V DMSO, BUFFERED WITH SD-10 5% W/V DEXTRAN-40 10ML IN 20ML SYRINGE","u":"SET","q":5000}],"4LS297":[{"d":"FILTERED PIPETTE TIPS, PCR CLEAN AND STERILE, 0.1-10 MICRO LITER, 40 MM,","u":"PCS","q":9600},{"d":"FILTERED PIPETTE TIPS, PCR CLEAN AND STERILE, 2-200 MICRO LITER,55 MM,","u":"PCS","q":4800},{"d":"GREEN-PAK INDIVIDUAL REFILLS,20UL MAX,","u":"PCS","q":5760},{"d":"GREEN-PAK INDIVIDUAL REFILLS,1000UL MAX VOLUME,FOR RAININ PIPETTES WITH LTS","u":"PCS","q":4608},{"d":"DNA LOBIND TUBES - 0.2 ML PCR CLEAN, COLORLESS, 250 TUBES","u":"PCS","q":1250},{"d":"SIMPORT POLYPROPYLENE STERILE MICROTUBES WITH O-RING SEAL SCREW CAP","u":"PCS","q":1000}],"4LS309":[{"d":"OLIGOS * EACH PRIMER LENGTH WILL BE BETWEEN","u":"PCS","q":3000}],"4LS315":[{"d":"EPT.I.P.S RELOADS, EPPENDORF QUALITY, 20-300UL, 55 MM, ORANGE, 960 TIPS","u":"PCS","q":11520}],"4LS356":[{"d":"PCR PERFORMANCE TESTED, MULTIPLY PRO 0.2ML WITH INTEGRAL","u":"PCS","q":4000},{"d":"MULTIPLY-PRO 0.2ML PCR TUBES WITH INTEGRAL ANTI-CONTAMINATION SHIELD","u":"PCS","q":1000},{"d":"NUNC BIOBANKING AND CELL CULTURE CRYOGENIC TUBES,CAPACITY= 1 ML,BOTTOM SHAPE=","u":"PCS","q":3000}],"5AN034":[{"d":"AIRVO COMPATIBLE OXYGEN 900PT422","u":"PCS","q":1100}],"5CS016":[{"d":"WRAPPING PAPER GREEN 50X50 TECNICAL SPECIFICATIONS:","u":"PCS","q":9000000}],"5DAN75":[{"d":"STANDARD ENDOTRACHEAL PLAIN TUBE WITH X-RAY DETECTABLE LINE SIZE (5MM)","u":"PCS","q":7500}],"5DAN76":[{"d":"STANDARD ENDOTRACHEAL PLAIN TUBE WITH XRAY DETECTABLE BLUE LINE SIZE 5.5MM NASAL/ORAL","u":"PCS","q":6000}],"5DAN77":[{"d":"DISPOSABLE SPINAL NEEDLE WITH K-3' LANCET AND","u":"PCS","q":20000}],"5DAN78":[{"d":"STANDARD ENDOTRACHEAL PLAIN TUBE WITH X-RAY DETECTABLE LINE SIZE (4.5MM)","u":"PCS","q":5000}],"5DAN79":[{"d":"ENDO-TUBE PARKER FLEX-TIP CUFF S-8.5 O/N","u":"PCS","q":1500}],"5DAN81":[{"d":"AIR WAYS NASOPHARYNGEAL 22 FR STERILE. MADE OF WIRUPREN WENDLE PATTERM WITH","u":"PCS","q":6000}],"5DAN82":[{"d":"INTUBATION STYLET (STANDARD LENGTH) FOR TRACHEAL SMALL 2, 5-4, 5MM I.D STERILE SMALL","u":"PCS","q":7140}],"5DAN83":[{"d":"STANARD ENDOTRACHEAL PLAIN TUBE WITH X-RAY DETECTABLE LINE SIZE (2.5MM)","u":"PCS","q":10000}],"5DAN85":[{"d":"STANDARD ENDOTRACHEAL PLAIN TUBE WITH X-RAY DETECTABLE LINE SIZE 2 MM","u":"PCS","q":15000}],"5DAN96":[{"d":"ETT PREFORMED NASAL PLAIN 4","u":"PCS","q":1500}],"5DAN99":[{"d":"STANDARD ENDOTRACHEAL PLAIN TUBE WITH X-RAY DETECTABLE BLUE LINE SIZE (6 MM) NASAL/ORAL","u":"PCS","q":6000}],"5DB027":[{"d":"DISYRINGE INSULIN G31/0.3ML/0.5 UNIT 6MM","u":"PCS","q":150000}],"5DB031":[{"d":"SYRINGE PURPLE (O/E) 10ML","u":"PCS","q":50000}],"5DB032":[{"d":"SCALPVEIN INFUSION SET TUBING, LENGTH 30 CM SIZE 25FGx3/4\" WITH DOUBLE","u":"SET","q":60000}],"5DB034":[{"d":"ENTERAL SYRINGE PURPLE (O/E) 5ML","u":"PCS","q":120000}],"5DB036":[{"d":"LUER MALE ADAPTER PLUG (HEPLOCK PLUG) STERILE WITH LATEX SPACEMENT.","u":"PCS","q":170000}],"5DE051":[{"d":"BUR PR RUBBER CUP RA 020204034491060","u":"PCS","q":14000}],"5DE057":[{"d":"MIS. COMPOSITE FINISHING AND POLISHING KIT","u":"KIT","q":6000}],"5DE080":[{"d":"MATRIX STRIPS CELLULOSE 8MM THIN","u":"MTR","q":15000}],"5DE082":[{"d":"MIS. WEDGE (ASSORTED)","u":"BOX","q":1500}],"5DI059":[{"d":"TUBULAR BANDAGE ELASTICATED 100% COTTON WITH COVERED ELASTIC THREADS LAID INTO","u":"PKT","q":10000}],"5DI073":[{"d":"ADHESIVE DRES I.V.CHLORHEXIDIN SIZE APPROXIMATELY 10X12CM","u":"PCS","q":41000}],"5DI074":[{"d":"ADHESIVE DRESSING STRIPS MADE OF CONFORMABLE PLASTIC","u":"PCS","q":1500000}],"5DI075":[{"d":"DISPOSABLE INJECT SWAB. SWAB IMPREGNATED IN 70% ISOPROPYL","u":"PCS","q":41000000}],"5DI076":[{"d":"DRESSING, IN POLYURETHERE TRANSPARENT DRESSING FOR I.V CANNULA OR CATHETER HUB, ADHESIVE FILM","u":"PCS","q":700000}],"5DI077":[{"d":"LATEX FREE WATERPROOF TO THE WATER AND BACTERIUM STERILE ADHESIVE DRESSING IN POLYUETHANE FOR","u":"PCS","q":700000}],"5DI080":[{"d":"SILVER PLASTER NON-ADHERANT SILVER PAD SET ON","u":"PCS","q":95000}],"5DI082":[{"d":"G-DRES TOE FOAM DRESSING WITH SILVER (FINGER / HAND)","u":"PCS","q":1500}],"5DI083":[{"d":"TUBE GAUZE FOR ADULT LIMB NO.56 STRETCHED TUBULAR BANDAGE MADE","u":"PKT","q":3000}],"5ENS07":[{"d":"AMBU NEUROLINE 720","u":"PCS","q":65000},{"d":"DISPOSABLE SNAP ELECTRODES FOR NHS","u":"PCS","q":150000}],"5EY045":[{"d":"AC IOLS FOR SULCUS FIXATION BICONVEX, OPTIC SIZE 7.0 MM, PMMA, TOTAL LENGHT 12.5","u":"PCS","q":1500}],"5GI008":[{"d":"GI MULTI BAND LIGATOR","u":"PCS","q":1500}],"5LB439":[{"d":"SAMPLE CUPS 0.5ML CRYSTAL CLEAR POLYSTYRENE SIZE 14X25 MM","u":"PCS","q":300000},{"d":"SAMPLE CUPS 2ML CRYSTAL CLEAR POLYSTYRENE SIZE 14X24 MM","u":"PCS","q":100000}],"5LB461":[{"d":"B.B/ID-NACL,ENZ.TEST&COLD AGGL","u":"PCS","q":2880}],"5LB473":[{"d":"ACL2000/MAGNETIC STIRRED REQ. PACKING: 6 PCS/PKT","u":"PCS","q":1200}],"5LB498":[{"d":"STOOL CONTAINER WITH COVER 150 ML","u":"PCS","q":450000}],"5LB510":[{"d":"SLIDE FOR TESTING BLOOD GROUPING","u":"PCS","q":48000},{"d":"SPECIMEN CONT. STR 60ML","u":"PCS","q":200000}],"5LB566":[{"d":"B.B/ID-NACL,ENZ.TEST&COLD AGGL","u":"PCS","q":8640}],"5LS296":[{"d":"COXIELLA BURNETII PHASE 1 (IGG) EI217A-9601-1G OR EQUIVALENT.","u":"PCS","q":2400},{"d":"CONDUCTIVE TIPS, 300 ML ZG 0201-0118 OR EQUIVALENT.","u":"PCS","q":518400},{"d":"CONDUCTIVE TIPS 1.100 ML ZG 0202-0110 OR EQUIVALENT.","u":"PCS","q":96000}],"5LS307":[{"d":"EP DUALIFILTER T.I.P.S. PCR CLEAN AND STERILE,0.1-2.5ML,115MM,RED,COLORLESS TIPS,240 TIPS","u":"PCS","q":1200},{"d":"EP DUALFILTER T.I.P.S. PCR CLEAN AND STERILE,10 MICROLITER S,34MM, DARK GRAY","u":"PCS","q":9600}],"5LS311":[{"d":"1.5 ML STERILE MICROTUBES WITH O-RING SEAL SCREW CAP SELF-STANDING","u":"PCS","q":1500}],"5LS343":[{"d":"DISPOSABLE SEROLOGICAL PIPETES - STERILE","u":"PCS","q":1500}],"5MEM07":[{"d":"ADULT NASAL CANNULA DESIGNED FOR PRESSUR","u":"PCS","q":4000}],"5MES07":[{"d":"ADULT NASAL CANNULA DESIGNED FOR PRESSUR","u":"PCS","q":2000}],"5NU039":[{"d":"COMPLETE NUTRITION FOR CROHN'S DISEASE","u":"TIN","q":10200}],"5PC018":[{"d":"DISPOSABLE CIRCUIT FOR BEAR CUB VENTILATORS RT-225 (OR SIMILAR)","u":"SET","q":6000}],"5PD097":[{"d":"SPEEDY CATH COMPACTS SET MALE 12-18 REF: 284221","u":"PCS","q":1200}],"5SSN20":[{"d":"DISPOSABLE REFLECTIVE MARKER SPHERE FOR NAVIGATION SYSTEM","u":"PCS","q":3500}],"5TX035":[{"d":"NAPKINS (SANITARY PADS) STANDARD NAPKIN SIZE:320MM, WEIGHT 8.5GM","u":"PCS","q":300000}],"6AN006":[{"d":"ADULT CO2/O2 NASAL DEVIDED CANNULA MALE STULE CO2 CONNECTOR , ADAPTOR 22MM/(I.D) X 6MM","u":"PCS","q":3650}],"6AN014":[{"d":"DISPOSABLE PEDIATRIC BOUJIE (EDOTRACHEAL TUBE INTRODUCER) 8 FR","u":"PCS","q":1000}],"6AN016":[{"d":"PRESSURE MONITORING MANOMETER LINES 100 CM","u":"PCS","q":3070}],"6CD015":[{"d":"CANULATION TORNIQUET SET,(2RED,2BLUE)","u":"SET","q":1500}],"6CS005":[{"d":"AUTOCLAVE CHEMICAL INDICATOR TYPE 6 STEAM STERILIZATION CYCLE VERIFICATION STRIP CHEMICAL","u":"PCS","q":20000}],"6CS009":[{"d":"WRAPPING PAPER SOFT CREPE GREEN 35X35CM TECHNICAL SPECIFICATIONS:","u":"PCS","q":15000000}],"6CS011":[{"d":"TAMPERPROOF PLASTIC LOCK TECHNICAL SPECIFICATIONS:","u":"PCS","q":100000}],"6CS019":[{"d":"COTTON BALLS FOR INJECTION \"NON STERILE\" TECHNICAL SPECIFICATIONS:","u":"PCS","q":1650000}],"6CS020":[{"d":"GAUZE SWAB (100% COTTON) 12 PLY TECNICAL SPECIFICATIONS:","u":"PKT","q":3312}],"6DAN02":[{"d":"ENDOTRACHEAL TUBE SIZE (8.5) PREFORMED LOW PRESSURE CUFF ORAL STERILE.","u":"PCS","q":2500}],"6DAN03":[{"d":"ETT PREFORMED NASAL PLAIN 5.5","u":"PCS","q":3000}],"6DAN07":[{"d":"DISPOSABLE SPINAL NEEDLE PENCIL POINT 23GX3 1/2\" STERILE","u":"PCS","q":30000}],"6DAN14":[{"d":"DISPOSABLE TRACHEAL TUBE PREFORMED WITHOUT CUFF(PLAIN) ORAL","u":"PCS","q":3000}],"6DAN20":[{"d":"STANDARD ENDOTRACHEAL CUFF TUBE WITH RADIOPAQUE BLUE LINE SIZE (4.5 MM) NASAL/ORAL STERILE","u":"PCS","q":12000}],"6DAN22":[{"d":"AIR WAY NASOPHARYNGEAL 32FR STERILE MADE OF WIRUPREN WENDLE PATTERN WITH","u":"PCS","q":10000}],"6DAN23":[{"d":"DISPOSABLE PREFORMED ORAL ENDO TRACHEAL TUBE WITH CUFF SIZE 8","u":"PCS","q":7000}],"6DAN30":[{"d":"ANGIOGRAPHY DRAPE TOTAL BODY STERILE DRAPE WITH 4 HOLES","u":"PCS","q":6000}],"6DAN31":[{"d":"ENDO-TUBE PARKER FLEX-TIP CUFF S-7.5 O/N","u":"PCS","q":6000}],"6DAN32":[{"d":"STANDARD ENDOTRACHEAL CUFF TUBE WITH RADIOPAQUE SIZE (4 MM) NASAL/ORAL STERILE.","u":"PCS","q":14000}],"6DAN38":[{"d":"DISPOSABLE TRACHEAL TUBE WITH X-RAY DETECTABLE BLUE LINE PREFORMED","u":"PCS","q":6000}],"6DAN50":[{"d":"ENDOTRACH TUBE CUFF 3.5","u":"PCS","q":8500}],"6DAN54":[{"d":"ENDOTRACHEAL TUBE REINFORCED PLAIN, SIZE 4.5 WITH X-RAY DETECTABLE LINE, ORAL/NASAL STERILE.","u":"PCS","q":1000}],"6DAN56":[{"d":"MRI COMPATABLE ECG ELECTRODES PED","u":"PCS","q":50000}],"6DB004":[{"d":"SYRINGE 10ML LURE SLIP 3 PCS LATEX FREE STOPPER, CLEAR BARREL AND PLUNGER FOR","u":"PCS","q":260000}],"6DB010":[{"d":"SCALPVEN INFUSION SET TUBING LENGTH 30CM G 27 X 3/4\" NEEDLE WITH","u":"SET","q":6000}],"6DB011":[{"d":"ENTERAL SYRINGE PURPLE (O/E) 5ML","u":"PCS","q":200000}],"6DB012":[{"d":"MALE LUER LOCK PLUG STERILE","u":"PCS","q":400000}],"6DB019":[{"d":"STERILE SINGLE-USE NEEDLES.HUB IS DESIGNED TO FIT ANY LUER SLIP OR","u":"PCS","q":2000000}],"6DE001":[{"d":"DISP. PLASTIC CUPS 160 ML DELIVERY WITHIN 3 WEEKS","u":"PCS","q":800000}],"6DE017":[{"d":"PEDO CROWN PERMANENT MOLAR. SSC LR-6","u":"PCS","q":1000},{"d":"PEDO CROWN PR. MOL. SSC DLR-7","u":"PCS","q":1500}],"6DE023":[{"d":"BUR * ROUND LARGE RA 500204001003018","u":"PCS","q":10000}],"6DE024":[{"d":"BUR * ROUND X-LARGE RA 500204001003023","u":"PCS","q":8000},{"d":"BUR CB ROUND BLK 806314001544014","u":"PCS","q":3000}],"6DE040":[{"d":"R.C. FILE PROTAPER NEXT (X5) 25MM -MUST BE STERILE.","u":"PCS","q":1110}],"6DE043":[{"d":"OS. HAEMOSTATIC ABSORBABLE GELATINE FOAM DRESSING SIZE 1X1CM","u":"PCS","q":1200},{"d":"PER SURGICAL BLADE 15C","u":"PCS","q":80000}],"6DE045":[{"d":"MIS. COMPOSITE POLISHING DISC KIT","u":"KIT","q":1300}],"6DE046":[{"d":"RIGHT ANGLE PEDO CROWN PRIMARY MOLAR SSC DUR-2","u":"PCS","q":2000}],"6DE048":[{"d":"R.C. ABSORBENT PAPER POINTS 25 STERILE MUST BE STERILE","u":"PCS","q":100000}],"6DI001":[{"d":"BURN DRESSING [HYDROGEL \"WATER-BASED GEL\"WITH","u":"PCS","q":6000}],"6DI003":[{"d":"HAEMOSTATIC ABSORBABLE GELATINE FOAM DREESING SIZE 10X10X10 MM","u":"PCS","q":1000}],"6DI004":[{"d":"NON ADHERENT DRESSING MADE FROM VISCOSE RAYON FABRIC KNITTED, IMPREGNATED WITH","u":"PCS","q":400000}],"6DI009":[{"d":"HAEMOSTATIC SURGICAL ADHESIVE BIOGLUE 2ML SYRINGE","u":"PCS","q":5000}],"6DI015":[{"d":"SELF ADHERENT SOFT SILICONE FOAM DRESSING, ABSORBS EXUDATES, MAINTAIN HEALING","u":"PCS","q":80000}],"6DI021":[{"d":"SOFT SILICON SHEET GEL SELF-ADHESIVE EFFECTIVE IN THE IMPROVEMENT OF RED, DARK","u":"PCS","q":1500}],"6DI023":[{"d":"AIRSTRIP 10CMX20CM ABSORBENT ADHESIVE DRESSING WITH NON-ADHERANT","u":"PCS","q":40000},{"d":"INDIVIDUALLY WRAPPED SIZE 10CMX20CM AIRSTRIP 25CMX10CM ABSORBENT ADHESIVE DRESSING WITH NON-ADHERANT","u":"PCS","q":20000}],"6DI036":[{"d":"NON ADHESIVE TRACTION KIT. CONTAINS A FOAM LINED STIR UP.RETAINING STRAPS AND 50","u":"PCS","q":1000}],"6DI040":[{"d":"ANTIBACTERIAL MANUKA HONEY DRESING SHOULD BE WITH CA ALGINATE.","u":"PCS","q":30000}],"6DR007":[{"d":"ECG ELECTRODE PREGELLED ADULT FOAM BACKING HYPOALLERGENIC ADHESIVE FOR ALL","u":"PCS","q":500000}],"6DR008":[{"d":"MAT-TUBING SET SUCTION DS ENDOMAT","u":"PCS","q":1500},{"d":"MAT-TUBING SET IRRIGATION PC ENDOMAT","u":"PCS","q":3000}],"6DR012":[{"d":"DERM- DISPOSABLE CURETTE 3MM","u":"PCS","q":4000}],"6DR018":[{"d":"LABEL ROLL 28 X 51MM","u":"PCS","q":70000}],"6DR020":[{"d":"ECG ELECTRODE PREGELLED INFANT FOAM BACKING HYPOALLERGENIC ADHESIVE. FOR ALL","u":"PCS","q":250000}],"6DR021":[{"d":"DERM- DISPOSABLE CURETTE 2MM","u":"PCS","q":6000}],"6DS007":[{"d":"SILICONE STRAIGHT CATHETER THORACIC DRAINAGE WITH HIGH KINK RESISTANCE,X-RAY CONTRAST","u":"PCS","q":2000}],"6DS016":[{"d":"SCALPEL BLADES,SIZE 12 CARBON STEEL STERILE.","u":"PCS","q":300000},{"d":"SURGICAL BLADES SIZE 15 CARBON STEEL STERILE.","u":"PCS","q":400000}],"6DS022":[{"d":"CATHETER THORACIC DRAINAGE TIP CH-30 STRAIGHT WITHOUT TROCAR","u":"PCS","q":1000}],"6DX005":[{"d":"CONDOM FOR VAGINAL SONOGRAPHY NON MEDICATED AND NON LUBRICATED,","u":"PCS","q":200000}],"6DX012":[{"d":"MLT-DIGITAL VIDEO DISC 16X4.5GB","u":"PCS","q":16000}],"6DX024":[{"d":"DISPOSABLE LUMP MARKER","u":"PCS","q":8000}],"6DX029":[{"d":"TORQUE DEVICE \"Torque Device accepts guidewires 0.014” to 0.038”","u":"PCS","q":1000}],"6DX031":[{"d":"DISPOSABLE LUMP MARKER Disposable palpable breast mass skin marker for mammography","u":"PCS","q":6000}],"6DXA02":[{"d":"STRIGHT EXTENSION TUBE 120CM STRIGHT EXTENTION TUBE WITH TWO CHECK VALVES","u":"PCS","q":10000}],"6EN003":[{"d":"MONOPLAR STIMULATING PROBE","u":"PCS","q":1700}],"6EN004":[{"d":"NASAL TAMPONS W/O AIRWAY 75X10X30MM","u":"PCS","q":1500}],"6EN014":[{"d":"STERILE SUCTION CATHETER CH 10 WITH TWO OPPOSED SIDE EYES AND VACUUM","u":"PCS","q":3000000}],"6EN018":[{"d":"ANGLED ASPIRATION CANNULA 1.4MM/17G 80MM","u":"PCS","q":5000}],"6EN025":[{"d":"SURGICAL PATTIES (13 MM X 76 MM)","u":"PCS","q":10000},{"d":"SURGICAL PATTIES 13 MM X 52 MM","u":"PCS","q":5000}],"6EN027":[{"d":"ANGLED ASPIRATION CANNULA, 0.7MM/22G","u":"PCS","q":3000}],"6EN028":[{"d":"EPISTAXIS NASAL TAMPON W/O AIRWAY PD 35M","u":"PCS","q":1000}],"6EN034":[{"d":"STERILE SUCTION CATHETER CH 12 WITH TWO SMALL OPPOSED SIDE EYES - GRADUATED AND","u":"PCS","q":140000}],"6EY013":[{"d":"25 G CHANDELIER ENDOILLUMINATION PROBE WITH 25G TROCHAR/CANULLA EACH SET IN PACK","u":"PCS","q":1000}],"6EY014":[{"d":"CRESCENT KNIVES 2.00 MM, STRAIGHT","u":"PCS","q":1500}],"6GI001":[{"d":"GI DOUBLE PIGTAIL STENT DB PIGTAIL BILIARY STENTS REQUIRED SIZES:","u":"PCS","q":1920}],"6GR003":[{"d":"NASOJUJENAL FEEDING TUBE 130CM -12FR MARKED EACH CM, RADIO-OPAQUE, CLOSED ROUND RIP, FOUR","u":"PCS","q":1000}],"6GR004":[{"d":"FEEDING SET OST-1000ML","u":"SET","q":8500}],"6GR005":[{"d":"NASOGASTRIC TUBE FG 18 WITH X RAY LINE DETECTABLE, WITH 4 LARGE LATERAL EYES, WITH STOPPER,","u":"PCS","q":15000},{"d":"10CM. DISPOSABLE AND STERILE. RYLE'S TUBE FG 10 WITH X RAY LINE DETECTABLE, WITH 4 LARGE LATERAL EYES,","u":"PCS","q":20000}],"6GR018":[{"d":"FEEDING TUBE, RADIO-OPAQUE, 50CM LONG WITH NUMERICAL GRADUATION EVERY 1CM, STERILE, FREE OF","u":"PCS","q":150000}],"6GR040":[{"d":"RECTAL TUBE WITH FUNNEL AND 2 SIDE EYES LENGTH 40CM SINGLE USE","u":"PCS","q":15000}],"6IN028":[{"d":"SODIUM CHLORIDE IRRG. 0.9% 5000ML","u":"BAG","q":2000}],"6IN029":[{"d":"SODIUM CHLORIDE IRRG. 0.9% 3000ML","u":"BAG","q":3000}],"6LB020":[{"d":"BRUSH/ ENDOCERVICAL SMEAR STERILE I.W (INDIVIDUALLY WRAPPED)","u":"PCS","q":3000}],"6LB030":[{"d":"TUBE PP STR.CONICAL GRAD. SCR.CAP 50ML POLY PROPYLENE CENTRIFUGE TUBE","u":"PCS","q":50000}],"6LB087":[{"d":"HEMOLET PEDIATRIC 1.25X0.4MM(28G)","u":"PCS","q":400000}],"6LB100":[{"d":"TRIPLE LUMEN CENTRAL VENOUS CATHETER 7 FR FOR JUGULAR VEIN,INTRODUCER","u":"SET","q":8000}],"6LB136":[{"d":"GALILEO/G PLATES","u":"PCS","q":2900}],"6LB181":[{"d":"HLA PLATES NUNC","u":"PCS","q":1920}],"6LB210":[{"d":"PENCIL MARKER RED THICK","u":"PCS","q":10000}],"6LB212":[{"d":"B.B/C6800/PROCESSING PLATE PACKING: 32 PCS/PKT","u":"PCS","q":4992}],"6LB222":[{"d":"COBAS P-P/ ASSAY TIP/CUP TRAY PACKING SIZE: 36 PC/BOX","u":"PCS","q":1440}],"6LB243":[{"d":"STA/MICROCUPS","u":"PCS","q":4800}],"6LB285":[{"d":"TYPE SAFE SEGMENT DEVICE","u":"PCS","q":4000}],"6LB287":[{"d":"CC/ACCU-CHEK SAFE-T-PRO PLUS","u":"PCS","q":30000}],"6LB297":[{"d":"MICROSCOPE COVER SLIDE GLASS 22X22MM","u":"PCS","q":400000},{"d":"COVER SLIDE GLASS 21X26MM","u":"PCS","q":200000}],"6LB303":[{"d":"GEM P3000/ SAMPLE TUBES+ ADAPTOR","u":"PCS","q":30000}],"6LB310":[{"d":"TUBE STR CENTRIFUGE CON. PP+CAP 15ML STERILE TUBE CONICAL SCREW CAPPED","u":"PCS","q":225000}],"6LB333":[{"d":"WOODEN APPLICATOR SMALL LENGTH 3\" 3MM DIAMETER.","u":"PCS","q":400000},{"d":"WOODEN APPLICATORS, 6 INCH 3MM DIAMETER. PACKING 1000PC/BOX.","u":"PCS","q":4000000}],"6LB344":[{"d":"ATEL CH-EMPTY 1","u":"PCS","q":1100}],"6LB347":[{"d":"STOOL CONTAINER WITH COVER 150 ML","u":"PCS","q":450000}],"6LS091":[{"d":"PIPETTE TIPS 250 ML 6300250A/PPT25","u":"PCS","q":2880}],"6LS105":[{"d":"96-WELL PCR PLATE MLL9601 OR EQUIVALENT","u":"PCS","q":1000}],"6LS120":[{"d":"FISHER FINE TIP TRANSFER PIPETTES FOR PRECISE DESPENSING OF SMALL DROPS","u":"PCS","q":4800}],"6LS128":[{"d":"EP DUALFILTER T.I.P.S 0.1-10UL 0030078500 OR EQUIVALENT","u":"PCS","q":15360},{"d":"EP DUALFILTER T.I.P.S 50-1000 UL 0030078578 OR EQUIVALENT","u":"PCS","q":10560},{"d":"EP DUALFILTER T.I.P.S 2-200 UL 0030078551 OR EQUIVALENT","u":"PCS","q":24000}],"6LS200":[{"d":"FISHER FINE TIP TRANSFER PIPETTES FOR PRECISE DESPENSING OF SMALL DROPS","u":"PCS","q":4800}],"6LS216":[{"d":"EZ-TIP WITH 290 MICRON TIP ID 7-72-2290/5","u":"PCS","q":1300}],"6LS219":[{"d":"TUBE, POLYSTYRENE ROUND-BOTTOM, 5ML 352003","u":"PCS","q":1000}],"6LS223":[{"d":"NUNC MULTI 4 WELL-DISH 144444","u":"PCS","q":1000},{"d":"TUBE, POLYSTYRENE ROUND-BOTTOM, 14ML 352001-MEA","u":"PCS","q":15000},{"d":"TUBE,POLYSTYRENE CONICAL 15ML,17X120MM 352099-MEA","u":"PCS","q":5000}],"6LS226":[{"d":"DISPOSABLE POLYETHYLENE TRANSFER PIPETS, INDIVIDUALLY WRAPPED 3ML PIPETE, STERILE MEA TESTED","u":"PCS","q":2500},{"d":"EPT.I.P.S. TIP EPPENDORF EPT.I.P.S. TIP, .1-20 MICROLITER, BIOPUR","u":"PCS","q":1500}],"6LS236":[{"d":"CAREBRUSH GYNECOLOGIC SAMPLES FOR SINGLE USE WITH DISPOSABLE COLLECTION TUBE FOR HPV,","u":"PCS","q":2000}],"6LS247":[{"d":"VISOTUBES / GOBLETS FOR CRYOPRESERVATION 13MM VISOTUBES, MULTI COLOUR (WHITE,","u":"PCS","q":1000}],"6MEI01":[{"d":"NOSE CLIP, SINGLE USE","u":"PCS","q":2000}],"6MEM04":[{"d":"BACTERIAL VIRAL FILTER FOR SPIROMETER","u":"PCS","q":3000}],"6PC019":[{"d":"ABDOMINAL RESPIRATORY SENSOR 467349","u":"PCS","q":2000}],"6PC031":[{"d":"GLASS BREAST RELIEVER SET","u":"PCS","q":1200}],"6PC034":[{"d":"MINI MUFF NOISE ATTENUATORS","u":"PCS","q":2000}],"6PC035":[{"d":"OPTIFLOW NASAL CANNULA INFANT","u":"PCS","q":5000}],"6PC041":[{"d":"INJACTOMAT SYRING 50MLOPAQUE *IMMEDIATE DELIVERY","u":"PCS","q":5000}],"6PD002":[{"d":"N.CATHTER BARD PEDIATRIC SIZE10F#RTU10P","u":"PCS","q":1080}],"6PD045":[{"d":"AQUACEL EXTRA 12.5X12.5/ 5IN.X5IN","u":"PCS","q":1000}],"6PD080":[{"d":"LOFRIC ORIGO TIEMANN CH10, 40CM REF: 4441000","u":"PCS","q":1920}],"6PD090":[{"d":"LOFRIC ORIGO TIEMANN TIP CATH 14FR CURVE","u":"PCS","q":2190}],"6PEF01":[{"d":"KNOSCUSION SET FOR NCPAP FOR NASAL PRONGS","u":"PCS","q":1000}],"6RS001":[{"d":"OXYGEN MASK,PEDIATRIC, NON REBREATHING WITH TWO PART AT THE EXHALATION PORTS, ONE VALVE","u":"PCS","q":25000}],"6RS004":[{"d":"MASK NON REBREATHING ADULT ELONGATED","u":"PCS","q":25000}],"6RS008":[{"d":"PULMONARY FILTER&MOUTH PIECE 2800/21","u":"PCS","q":22000}],"6RS017":[{"d":"OXYGEN MASK,PEDIATRIC, NON REBREATHING WITH TWO PART AT THE EXHALATION PORTS, ONE VALVE","u":"PCS","q":25000}],"6SP016":[{"d":"NITROGLYCERINE PATCH 25MG (TTS 5)","u":"PCS","q":26000}],"6SP066":[{"d":"URINARY ALKALINISER POWDER CONTAIN :- SODIUM BICARBONATE-CITRIC ACID-TARTARIC ACID-SODIUM","u":"BOX","q":42000}],"6TS009":[{"d":"PEN TORCH 1- MATERIAL: ANODIZED ALUMINUM ALLOY.","u":"PCS","q":1000}],"6TX001":[{"d":"EXAMINATION NITRILE GLOVES FREE POWDER, LATEX FREE, NON STERILE, MATCH WITH EN 455","u":"PCS","q":6000000}],"6TX003":[{"d":"ANTIBACTERIAL SHEMPOO CAP","u":"PCS","q":100000}],"6TX017":[{"d":"SCROTUM SUPPORT SUSPENSORY BANDAGE WITH ADJUSTABLE BELT MADE FROM BLEACHED COTTON YARN","u":"PKT","q":2000}],"6TX022":[{"d":"SURGICAL NON WOVEN FABRIC DRAPE SHEET FOR PROCEDURES OF ALL TYPES,IMPERMEABLE","u":"PCS","q":24000}],"6TX026":[{"d":"THYROIDECTOMY NECK SURGERY PACK","u":"PCS","q":1000}],"6TX028":[{"d":"DRAP COLONOSCOPY SHORT","u":"PCS","q":9000}],"6TX029":[{"d":"SLING ARM MEDIUM SUPPORT FOREARM AND WRIST, CONSIST","u":"PCS","q":15000}],"6TX030":[{"d":"SLING ARM SMALL SUPPORT FOREARM AND WRIST, CONSIST","u":"PCS","q":16000}],"6TX033":[{"d":"SLING ARM SIZE LARGE SUPPORT FOREARM AND WRIST, CONSIST","u":"PCS","q":20000}],"6TX043":[{"d":"NAPKINS, MATERNITY PAD, ABSORBENT, NURSING CONTOURED, NON IRRITATING","u":"PCS","q":160000}],"6TX051":[{"d":"GOWN, DISPOSABLE, WITH ELASTIC WRISTS","u":"PCS","q":600000}],"6TX058":[{"d":"ORTHO CERVICAL COLLAR PLASTIC TOW PICES ADJUSTABLE, MADE IN HIGH DENSITY","u":"PCS","q":2000}],"6TX063":[{"d":"NAPKINS (SANITARY PADS) STANDARD NAPKIN SIZE:320MM, WEIGHT 8.5GM","u":"PCS","q":300000}],"6TX065":[{"d":"NAPKINS, MATERNITY PAD, ABSORBENT, NURSING CONTOURED, NON IRRITATING","u":"PCS","q":170000}],"6UR003":[{"d":"U-EMG SNAP PATCH ELECTROD ELE425","u":"PCS","q":1000}],"6UR007":[{"d":"DISPOSABLE FEMALE CATHETER CH 14 LENGTH 18CM APPROXIMATELY.","u":"PCS","q":20000},{"d":"INDIVIDUALY PACKED IN PEEL POUCHES. DISPOSABLE FEMALE CATHETER CH 16 LENGTH 16-20CM. WITH SOFT ROUNDED","u":"PCS","q":15000}],"6UR016":[{"d":"DISPOSABLE FEMALE CATHETER CH 12 LENGTH 18CM APPROXIMATELY.","u":"PCS","q":20000},{"d":"INDIVIDUALY PACKED IN PEEL POUCHES. CATHETER NELTON 24","u":"PCS","q":5000}],"6UR017":[{"d":"SILICONIZED LATEX FOLLY'S CATHETER 3 WAY SIZE 18 BALLOON 30CC. WITH FUNNEL AND VALVES","u":"PCS","q":6000},{"d":"INDIVIDUAL PACKED SILICONIZED LATEX FOLLY'S CATHETER 2-WAY SIZE 24FR, WITH FUNNEL AND VALVE","u":"PCS","q":2000},{"d":"30 C.C STERILE. SILICONIZED LATEX FOLLY'S CATHETER SELF RETAINING 2-WAY WITH FUNNAL AND VALVE SUITABLE TO","u":"PCS","q":10000}],"6UR018":[{"d":"DRAING PLASTIC TRANSPARENT URINE MEASURMENT SYSTEM VOLUME OF 500 ML","u":"PCS","q":5000}]};
// Refs the sweep holds bidder/winner/award data for. Carried as bare refs so a
// single call can measure the overlap with /tenders before the much larger
// Arabic payload is worth embedding at all.
const AWARD_REFS = new Set(["0LS220","1082021","1112022","12","12021","12023","122","1232021","1342021","162023","172024","1820192020","20241","20242023","202420235","2024202361","2025202413","22026","232024","242020","252019","2520192","25201920","252024","28202420","292023","292024","302020","312020","342022","35201","352019","35201920","352024","362020","39120162017","412023","432023","492022","502022","5020242","512022","552022","602023","612022","62022","622023","702023","732022","7362020","752023","822023","920242025","972022"]);

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
async function runPdfPass(limit, t0, activeOnly, repair, retryTried){
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
    // A record scanned once almost never yields on a retry: CTC either publishes
    // a ref-named PDF or it does not. Without this marker a nightly backfill
    // rescans every dead record and becomes the costliest job in this system.
    if(activeOnly && !repair && t.itemsTried && !retryTried){ skipped++; continue; }
    scanned++;
    const items=await Promise.race([
      pdfForTender(j,t._ctcId,t.refId).catch(()=>[]),
      new Promise(r=>setTimeout(()=>r([]),6000)),
    ]);
    if(!items.length){
      if(!repair) patch[k+"/itemsTried"]=new Date().toISOString().slice(0,10);
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

    // ?enrich=1 — WRITES. Applies SEED_ITEMS: item schedules the browser sweep
    // already recovered but which never reached /tenders. No CTC login and no PDF
    // work, so this is by far the cheapest way to add real product-level data.
    // Existing items are never overwritten. Also reports how many /tenders records
    // the sweep holds bidder/winner/award data for, so that payload is only
    // embedded if it would actually match something.
    if (u.searchParams.get("enrich")) {
      const all = (await fbGet("tenders")) || {};
      const nrm = (x) => String(x || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      const patch = {};
      let matched = 0, gotItems = 0, awardMatches = 0;
      const awardRefsFound = [];
      for (const k of Object.keys(all)) {
        const t = all[k] || {};
        const rf = nrm(t.refId);
        if (AWARD_REFS.has(rf)) { awardMatches++; if (awardRefsFound.length < 20) awardRefsFound.push(t.refId); }
        const it = SEED_ITEMS[rf];
        if (!it || !it.length) continue;
        matched++;
        if (Array.isArray(t.items) && t.items.length) continue;
        patch[k + "/items"] = it;
        patch[k + "/itemCount"] = it.length;
        patch[k + "/itemsSource"] = "sweep";
        patch[k + "/description"] = describeTender({ title: t.summary, type: t.type,
          entity: String(t.publisher || "").replace("Ministry of Health - ", "") }, it);
        patch[k + "/subSector"] = subSectorFor(t.summary, it);
        gotItems++;
      }
      if (Object.keys(patch).length) { await fbPatch("tenders", patch); await fbPut("tenders_version", Date.now()); }
      return new Response(JSON.stringify({ ok:true, mode:"enrich", total:Object.keys(all).length,
        seedRefs:Object.keys(SEED_ITEMS).length, matched, gotItems,
        awardRefs:AWARD_REFS.size, awardMatches, awardRefsFound,
        patched:Object.keys(patch).length, ms:Date.now()-t0 }), { headers:{ "Content-Type":"application/json" } });
    }

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
      const res = await runPdfPass(Math.min(Number(u.searchParams.get("limit")) || 3, 10), t0, !!u.searchParams.get("active"), repair, !!u.searchParams.get("retry"));
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
