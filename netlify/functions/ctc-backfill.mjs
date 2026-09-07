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
import zlib from "node:zlib";
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

function pdfText(buf){
  let out=""; const bytes=Buffer.from(buf); let i=0;
  while(true){
    const st=bytes.indexOf("stream",i); if(st<0) break;
    let a=st+6; if(bytes[a]===13)a++; if(bytes[a]===10)a++;
    const e=bytes.indexOf("endstream",a); if(e<0) break;
    i=e+9;
    let chunk=bytes.subarray(a,e);
    try{ chunk=zlib.inflateSync(chunk); }catch{ continue; }
    const txt=chunk.toString("latin1");
    const re=/\((?:\\.|[^\\()])*\)/g; let m, seg="";
    while((m=re.exec(txt))) seg += m[0].slice(1,-1).replace(/\\([()\\])/g,"$1").replace(/\\[rn]/g," ");
    if(seg.trim()) out += seg + "\n";
    if(out.length>60000) break;
  }
  return out;
}
function pdfItems(text){
  const UNIT=/\b(PCS|BOX|VIAL|PKT|SET|EACH|KIT|AMP|TAB|BTL|PACK|ROLL|BAG|TUBE)\b/i;
  const items=[];
  for(const raw of text.split(/\n+/)){
    const line=raw.replace(/\s+/g," ").trim();
    if(line.length<12) continue;
    const u=line.match(UNIT); if(!u) continue;
    const q=line.match(/\b(\d{1,3}(?:,\d{3})+|\d{2,7})\b(?!.*\b\d{2,7}\b)/); if(!q) continue;
    const qty=Number(q[1].replace(/,/g,"")); if(!qty||qty<2) continue;
    const d=line.slice(0,u.index).replace(/[|,;:\s]+$/,"").trim();
    if(d.length<6) continue;
    items.push({d:d.slice(0,160),u:u[1].toUpperCase(),q:qty});
    if(items.length>=40) break;
  }
  return items;
}
async function pdfForTender(j,id,ref){
  const r = await cget(j,`https://www.ctckw.com/TenderDetails.aspx?tdc_id=${id}`);
  const html = await r.text();
  const hrefs=[...html.matchAll(/href\s*=\s*["']([^"']*DataFiles[^"']*\.pdf)["']/gi)].map(m=>m[1]);
  if(!hrefs.length) return [];
  const key=String(ref||"").replace(/[^A-Za-z0-9]/g,"").toUpperCase();
  const score=(h)=>{ const f=h.split("/").pop().replace(/[^A-Za-z0-9]/g,"").toUpperCase();
    if(key&&f.includes(key)) return 0; if(/DOC\d+\.PDF$/i.test(h)) return 2; return 1; };
  hrefs.sort((a,b)=>score(a)-score(b));
  for(const h of hrefs.slice(0,2)){
    const url=h.startsWith("http")?h:`https://www.ctckw.com/${h.replace(/^\/+/,"")}`;
    try{
      const pr=await fetchT(url,{headers:{Cookie:j.hdr(),"User-Agent":UA}},5000);
      if(!pr.ok) continue;
      const buf=await pr.arrayBuffer();
      if(buf.byteLength>6e6) continue;
      const items=pdfItems(pdfText(buf));
      if(items.length) return items;
    }catch{}
  }
  return [];
}

async function runPdfPass(limit, t0){
  const all=(await fbGet("tenders"))||{};
  const keys=Object.keys(all).sort();
  const cursor=String((await fbGet("pipeline/pdfCursor"))||"");
  let start=0; if(cursor){ const i=keys.indexOf(cursor); start=i>=0?i+1:0; }

  const j=jar(); await ctcLogin(j);

  const patch={}; let scanned=0, withItems=0, skipped=0, last=cursor;
  const budget=()=> 22000-(Date.now()-t0);          // stay well inside the timeout
  for(let i=start;i<keys.length&&scanned<limit;i++){
    if(budget()<6000) break;
    const k=keys[i], t=all[k]||{};
    last=k;
    if(Array.isArray(t.items)&&t.items.length){ skipped++; continue; }
    scanned++;
    const items=await Promise.race([
      pdfForTender(j,t._ctcId,t.refId).catch(()=>[]),
      new Promise(r=>setTimeout(()=>r([]),6000)),
    ]);
    if(!items.length) continue;
    withItems++;
    patch[k+"/items"]=items;
    patch[k+"/itemCount"]=items.length;
    patch[k+"/description"]=describeTender({title:t.summary,type:t.type,
      entity:String(t.publisher||"").replace("Ministry of Health - ","")},items);
    patch[k+"/subSector"]=subSectorFor(t.summary,items);
  }
  if(Object.keys(patch).length){ await fbPatch("tenders",patch); await fbPut("tenders_version",Date.now()); }
  const done=(keys.indexOf(last)+1)>=keys.length;
  await fbPut("pipeline/pdfCursor", done?"":last);
  return { mode:"pdf", total:keys.length, scanned, skipped, withItems,
           patched:Object.keys(patch).length, done, ms:Date.now()-t0 };
}

const PLACEHOLDER = "Medical / healthcare procurement — Kuwait (CTC)";

export default async (req) => {
  const t0 = Date.now();
  try {
    if (!FB) return new Response(JSON.stringify({ ok:false, error:"Missing FIREBASE_URL" }), { status:500, headers:{ "Content-Type":"application/json" } });
    const u = new URL(req.url);
    const limit = Math.min(Number(u.searchParams.get("limit")) || 1500, 5000);
    if (u.searchParams.get("reset")) await fbPut("pipeline/backfillCursor", "");

    if (u.searchParams.get("pdf")) {
      if (!process.env.CTC_USER || !process.env.CTC_PASS)
        return new Response(JSON.stringify({ ok:false, error:"Missing CTC_USER / CTC_PASS" }), { status:500, headers:{ "Content-Type":"application/json" } });
      if (u.searchParams.get("reset")) await fbPut("pipeline/pdfCursor", "");
      const res = await runPdfPass(Math.min(Number(u.searchParams.get("limit")) || 25, 60), t0);
      console.log("[ctc-backfill]", JSON.stringify(res));
      return new Response(JSON.stringify({ ok:true, ...res }), { headers:{ "Content-Type":"application/json" } });
    }

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
