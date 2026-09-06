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

const PLACEHOLDER = "Medical / healthcare procurement — Kuwait (CTC)";

export default async (req) => {
  const t0 = Date.now();
  try {
    if (!FB) return new Response(JSON.stringify({ ok:false, error:"Missing FIREBASE_URL" }), { status:500, headers:{ "Content-Type":"application/json" } });
    const u = new URL(req.url);
    const limit = Math.min(Number(u.searchParams.get("limit")) || 1500, 5000);
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
