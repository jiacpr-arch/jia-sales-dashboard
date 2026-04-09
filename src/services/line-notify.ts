/**
 * LINE Messaging API — Push Message
 *
 * ใช้ 2 token:
 * - LINE_CHANNEL_TOKEN (Pracmed) → ส่งกลุ่ม (LINE_TARGET_ID)
 * - JIAROO_LINE_CHANNEL_TOKEN → ส่งรายคน (ดึง LINE ID จาก Supabase)
 */

const CHANNEL_TOKEN = process.env.LINE_CHANNEL_TOKEN ?? "";
const TARGET_ID     = process.env.LINE_TARGET_ID     ?? "";
const JIAROO_TOKEN  = process.env.JIAROO_LINE_CHANNEL_TOKEN ?? "";
const SUPABASE_URL  = process.env.SUPABASE_URL ?? "";
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY ?? "";

// ── LINE ID lookup from Supabase ─────────────────────────────────────────────
interface SalesLineRecord {
  sales_name: string;
  line_user_id: string;
}

let _salesLineCache: SalesLineRecord[] = [];
let _cacheExpiry = 0;

async function getSalesLineIds(): Promise<SalesLineRecord[]> {
  if (Date.now() < _cacheExpiry && _salesLineCache.length > 0) return _salesLineCache;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.log("[LINE] No Supabase config — cannot fetch sales LINE IDs");
    return [];
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/jiaroo_sales_line?select=sales_name,line_user_id`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}`);
    _salesLineCache = await res.json() as SalesLineRecord[];
    _cacheExpiry = Date.now() + 5 * 60_000; // cache 5 min
    console.log(`[LINE] Loaded ${_salesLineCache.length} sales LINE IDs`);
    return _salesLineCache;
  } catch (err) {
    console.error("[LINE] Failed to fetch sales LINE IDs:", err);
    return [];
  }
}

function findLineUserId(salesName: string, records: SalesLineRecord[]): string | null {
  // Exact match first
  const exact = records.find(r => r.sales_name === salesName);
  if (exact) return exact.line_user_id;
  // Partial match (FlowAccount name may differ slightly)
  const partial = records.find(r =>
    salesName.includes(r.sales_name) || r.sales_name.includes(salesName)
  );
  return partial?.line_user_id ?? null;
}

// ── Push message helpers ─────────────────────────────────────────────────────

/** ส่งข้อความส่วนตัวผ่าน JiaRoo OA */
export async function jiarooPush(userId: string, text: string): Promise<void> {
  const token = JIAROO_TOKEN || CHANNEL_TOKEN;
  if (!token || !userId) return;
  try {
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to: userId, messages: [{ type: "text", text }] }),
    });
    if (!res.ok) console.error("[JiaRoo] Push error:", res.status, await res.text());
  } catch (err) {
    console.error("[JiaRoo] Push failed:", err);
  }
}

/** ส่งข้อความไปยัง group (Pracmed) */
export async function lineMessage(text: string): Promise<void> {
  if (!CHANNEL_TOKEN || !TARGET_ID) {
    console.log("[LINE] ยังไม่ได้ตั้งค่า — ข้ามการแจ้งเตือน");
    return;
  }
  try {
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { Authorization: `Bearer ${CHANNEL_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to: TARGET_ID, messages: [{ type: "text", text }] }),
    });
    if (!res.ok) console.error("[LINE] Push error:", res.status, await res.text());
    else console.log("[LINE] ส่งข้อความกลุ่มสำเร็จ");
  } catch (err) {
    console.error("[LINE] Push failed:", err);
  }
}

/** ส่งข้อความส่วนตัวให้เซลล์ตาม salesName */
export async function notifySalesPerson(salesName: string, text: string): Promise<boolean> {
  const records = await getSalesLineIds();
  const userId = findLineUserId(salesName, records);
  if (!userId) {
    console.log(`[LINE] ไม่พบ LINE ID ของเซลล์: ${salesName}`);
    return false;
  }
  await jiarooPush(userId, text);
  return true;
}

// ── Daily Report (ส่งกลุ่ม) ──────────────────────────────────────────────────
export async function sendDailyReport(): Promise<void> {
  const { getDb } = await import("./database.js");
  const db = getDb();

  const expired   = db.prepare("SELECT COUNT(*) AS n FROM v_quotation_status WHERE health='expired'").get() as { n: number };
  const warning   = db.prepare("SELECT COUNT(*) AS n FROM v_quotation_status WHERE health='warning'").get() as { n: number };
  const safe      = db.prepare("SELECT COUNT(*) AS n FROM v_quotation_status WHERE health='safe'").get() as { n: number };
  const conflicts = db.prepare("SELECT COUNT(*) AS n FROM v_conflicts").get() as { n: number };

  const pipelineNew    = db.prepare("SELECT COUNT(*) AS n FROM quotations WHERE pipeline_stage='new'").get() as { n: number };
  const pipelineQuoted = db.prepare("SELECT COUNT(*) AS n FROM quotations WHERE pipeline_stage='quoted'").get() as { n: number };
  const pipelineNeg    = db.prepare("SELECT COUNT(*) AS n FROM quotations WHERE pipeline_stage='negotiating'").get() as { n: number };
  const wonThisWeek    = db.prepare("SELECT COUNT(*) AS n FROM quotations WHERE pipeline_stage='won' AND pipeline_updated_at >= date('now','localtime','-7 days')").get() as { n: number };
  const lostThisWeek   = db.prepare("SELECT COUNT(*) AS n FROM quotations WHERE pipeline_stage='lost' AND pipeline_updated_at >= date('now','localtime','-7 days')").get() as { n: number };

  const today = new Date().toLocaleDateString("th-TH", { dateStyle: "short" });
  const lines = [
    `📊 รายงานใบเสนอราคา ประจำวัน ${today}`,
    `🟢 ปลอดภัย: ${safe.n} ใบ`,
    `🟡 ใกล้หมดอายุ/ไม่ได้ติดตาม: ${warning.n} ใบ`,
    `🔴 หมดอายุแล้ว: ${expired.n} ใบ`,
    ...(conflicts.n > 0 ? [`⚠️ ลูกค้าชน: ${conflicts.n} คู่ — รอตัดสิน`] : []),
    ``,
    `🔀 Pipeline:`,
    `   🆕 ใหม่: ${pipelineNew.n}  📝 เสนอราคา: ${pipelineQuoted.n}  🤝 เจรจา: ${pipelineNeg.n}`,
    `   🎉 ปิดดีลสัปดาห์นี้: ${wonThisWeek.n}  ❌ เสียดีล: ${lostThisWeek.n}`,
  ];
  await lineMessage(lines.join("\n"));

  // ส่งสรุปรายคนด้วย
  await sendPersonalDailySummary(db);
}

// ── Personal daily summary (ส่งรายคน) ────────────────────────────────────────
async function sendPersonalDailySummary(db: ReturnType<typeof import("./database.js").getDb>): Promise<void> {
  const { generateFollowUpToken } = await import("../routes/sales-followup.js");
  const records = await getSalesLineIds();
  if (records.length === 0) return;

  const BASE_URL = process.env.PUBLIC_URL ?? "http://localhost:3001";

  // Get per-salesperson stats
  const salesStats = db.prepare(`
    SELECT u.id AS user_id, u.full_name AS sales_name,
      COUNT(*) AS total,
      SUM(CASE WHEN v.health='expired' THEN 1 ELSE 0 END) AS expired,
      SUM(CASE WHEN v.health='warning' THEN 1 ELSE 0 END) AS warning,
      SUM(CASE WHEN v.health='safe' THEN 1 ELSE 0 END) AS safe
    FROM v_quotation_status v
    JOIN users u ON u.id = v.sales_user_id
    GROUP BY u.id, u.full_name
  `).all() as Array<{ user_id: number; sales_name: string; total: number; expired: number; warning: number; safe: number }>;

  for (const stat of salesStats) {
    const userId = findLineUserId(stat.sales_name, records);
    if (!userId) continue;

    const token = generateFollowUpToken(stat.user_id);
    const link = `${BASE_URL}/followup/${token}`;

    const msg = [
      `📊 สรุปของคุณวันนี้ (${stat.sales_name})`,
      `📋 ใบทั้งหมด: ${stat.total}`,
      `🟢 ปลอดภัย: ${stat.safe}`,
      `🟡 ใกล้หมดอายุ: ${stat.warning}`,
      `🔴 หมดอายุ: ${stat.expired}`,
      ...(stat.expired > 0 || stat.warning > 0
        ? [`\n⚠️ มี ${stat.expired + stat.warning} ใบต้องตามลูกค้า!`, `👉 ดูรายชื่อ: ${link}`]
        : []),
    ].join("\n");

    await jiarooPush(userId, msg);
  }
}

// ── Test helper ──────────────────────────────────────────────────────────────
export async function sendTestMessage(): Promise<void> {
  await lineMessage("✅ ทดสอบ LINE Messaging API จาก Jia Raksa Sales Portal — ระบบพร้อมใช้งาน!");
}
