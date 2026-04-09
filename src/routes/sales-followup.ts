import { Request, Response } from "express";
import { getDb } from "../services/database";
import crypto from "crypto";

const SECRET = process.env.JWT_SECRET ?? "fallback-secret";

/** สร้าง token สำหรับเซลล์แต่ละคน (ใช้ใน URL) */
export function generateFollowUpToken(salesUserId: number): string {
  const payload = `${salesUserId}:${Math.floor(Date.now() / 86400000)}`; // valid 1 day
  const hmac = crypto.createHmac("sha256", SECRET).update(payload).digest("hex").slice(0, 16);
  return Buffer.from(`${salesUserId}:${hmac}`).toString("base64url");
}

/** ถอด token */
function verifyToken(token: string): number | null {
  try {
    const decoded = Buffer.from(token, "base64url").toString();
    const [idStr, hmac] = decoded.split(":");
    const salesUserId = parseInt(idStr);
    // Verify HMAC (valid today or yesterday)
    for (const dayOffset of [0, -1]) {
      const payload = `${salesUserId}:${Math.floor(Date.now() / 86400000) + dayOffset}`;
      const expected = crypto.createHmac("sha256", SECRET).update(payload).digest("hex").slice(0, 16);
      if (hmac === expected) return salesUserId;
    }
    return null;
  } catch {
    return null;
  }
}

/** API: GET /api/sales-followup?token=xxx — JSON data */
export function getSalesFollowUpData(req: Request, res: Response): void {
  const token = req.query.token as string;
  if (!token) { res.status(400).json({ error: "Missing token" }); return; }
  const salesUserId = verifyToken(token);
  if (!salesUserId) { res.status(401).json({ error: "Invalid or expired token" }); return; }

  const db = getDb();
  const user = db.prepare("SELECT full_name FROM users WHERE id=?").get(salesUserId) as { full_name: string } | undefined;
  if (!user) { res.status(404).json({ error: "User not found" }); return; }

  const quotations = db.prepare(`
    SELECT document_number, contact_name, total_amount, issue_date, expiry_date, health, pipeline_stage
    FROM v_quotation_status
    WHERE sales_user_id = ?
    ORDER BY
      CASE health WHEN 'expired' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
      expiry_date ASC
  `).all(salesUserId) as Array<{
    document_number: string; contact_name: string; total_amount: number;
    issue_date: string; expiry_date: string; health: string; pipeline_stage: string;
  }>;

  res.json({ salesName: user.full_name, quotations });
}

/** Page: GET /followup/:token — HTML page */
export function getSalesFollowUpPage(req: Request, res: Response): void {
  const token = req.params.token;
  const salesUserId = verifyToken(token);
  if (!salesUserId) {
    res.status(401).send("<h1>ลิงก์หมดอายุหรือไม่ถูกต้อง</h1><p>กรุณาขอลิงก์ใหม่จากระบบ</p>");
    return;
  }

  const db = getDb();
  const user = db.prepare("SELECT full_name FROM users WHERE id=?").get(salesUserId) as { full_name: string } | undefined;
  if (!user) { res.status(404).send("User not found"); return; }

  const quotations = db.prepare(`
    SELECT document_number, contact_name, total_amount, issue_date, expiry_date, health, pipeline_stage
    FROM v_quotation_status
    WHERE sales_user_id = ?
    ORDER BY
      CASE health WHEN 'expired' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
      expiry_date ASC
  `).all(salesUserId) as Array<{
    document_number: string; contact_name: string; total_amount: number;
    issue_date: string; expiry_date: string; health: string; pipeline_stage: string;
  }>;

  const expired = quotations.filter(q => q.health === "expired");
  const warning = quotations.filter(q => q.health === "warning");
  const safe = quotations.filter(q => q.health === "safe");

  const fmt = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 0 });
  const badge = (h: string) =>
    h === "expired" ? '<span style="background:#fee2e2;color:#dc2626;padding:2px 8px;border-radius:99px;font-size:12px;font-weight:600">หมดอายุ</span>' :
    h === "warning" ? '<span style="background:#fef9c3;color:#d97706;padding:2px 8px;border-radius:99px;font-size:12px;font-weight:600">ใกล้หมดอายุ</span>' :
    '<span style="background:#dcfce7;color:#16a34a;padding:2px 8px;border-radius:99px;font-size:12px;font-weight:600">ปลอดภัย</span>';

  const rows = quotations.map(q => `
    <tr>
      <td>${q.document_number}</td>
      <td>${q.contact_name}</td>
      <td style="text-align:right">฿${fmt(q.total_amount)}</td>
      <td>${q.issue_date}</td>
      <td>${q.expiry_date || "-"}</td>
      <td>${badge(q.health)}</td>
    </tr>
  `).join("");

  const html = `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>รายชื่อลูกค้าที่ต้องตาม — ${user.full_name}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Noto Sans Thai',system-ui,sans-serif;background:#f8fafc;color:#1e293b;padding:16px}
  h1{font-size:20px;margin-bottom:8px}
  .summary{display:flex;gap:10px;margin:16px 0;flex-wrap:wrap}
  .card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 18px;min-width:100px;text-align:center}
  .card .n{font-size:24px;font-weight:700}
  .card .l{font-size:11px;color:#64748b;margin-top:2px}
  .card.red .n{color:#dc2626}
  .card.yellow .n{color:#d97706}
  .card.green .n{color:#16a34a}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e2e8f0;margin-top:12px}
  th{background:#f1f5f9;font-size:12px;font-weight:600;padding:10px 8px;text-align:left;white-space:nowrap}
  td{padding:8px;font-size:13px;border-top:1px solid #e2e8f0}
  tr:hover td{background:#f8fafc}
  .updated{color:#94a3b8;font-size:11px;margin-top:12px}
  @media(max-width:640px){table{font-size:11px}th,td{padding:6px 4px}}
</style>
</head>
<body>
  <h1>📋 รายชื่อลูกค้าที่ต้องตาม</h1>
  <p style="color:#64748b;font-size:14px">เซลล์: <strong>${user.full_name}</strong></p>

  <div class="summary">
    <div class="card red"><div class="n">${expired.length}</div><div class="l">🔴 หมดอายุ</div></div>
    <div class="card yellow"><div class="n">${warning.length}</div><div class="l">🟡 ใกล้หมดอายุ</div></div>
    <div class="card green"><div class="n">${safe.length}</div><div class="l">🟢 ปลอดภัย</div></div>
    <div class="card"><div class="n">${quotations.length}</div><div class="l">ทั้งหมด</div></div>
  </div>

  <table>
    <thead><tr>
      <th>เลขที่</th><th>ลูกค้า</th><th>มูลค่า</th><th>วันที่ออก</th><th>หมดอายุ</th><th>สถานะ</th>
    </tr></thead>
    <tbody>${rows || '<tr><td colspan="6" style="text-align:center;color:#94a3b8;padding:20px">ไม่มีข้อมูล</td></tr>'}</tbody>
  </table>

  <p class="updated">อัปเดตล่าสุด: ${new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })}</p>
</body>
</html>`;

  res.type("html").send(html);
}
