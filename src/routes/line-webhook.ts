import { Router } from "express";
import { getDb } from "../services/database";
import { jiarooPush } from "../services/line-notify";

const router = Router();

/**
 * LINE Webhook — รับข้อความจาก OA JiaRoo
 * ตั้ง Webhook URL ใน LINE Developers Console:
 *   https://<domain>/api/line/webhook
 */
router.post("/webhook", async (req, res) => {
  // LINE ส่ง verify request ตอนตั้ง webhook
  const events = req.body?.events;
  if (!events || events.length === 0) {
    return res.json({ ok: true });
  }

  for (const event of events) {
    if (event.type !== "message" || event.message?.type !== "text") continue;

    const text: string = event.message.text.trim();
    const userId: string = event.source?.userId ?? "";
    if (!userId) continue;

    // จับคำว่า "ลงทะเบียน"
    const match = text.match(/^ลงทะเบียน\s+(.+)$/i);
    if (!match) {
      // ถ้าไม่ใช่ลงทะเบียน ตอบแนะนำ
      await jiarooPush(userId,
        `👋 สวัสดีค่ะ\n\nพิมพ์ "ลงทะเบียน ชื่อของคุณ" เพื่อลงทะเบียนรับแจ้งเตือน\n\nตัวอย่าง: ลงทะเบียน แก้มใส`
      );
      continue;
    }

    const salesName = match[1].trim();

    // ดึง display name จาก LINE Profile
    let displayName = "";
    try {
      const token = process.env.LINE_CHANNEL_TOKEN ?? "";
      const profileRes = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (profileRes.ok) {
        const profile = await profileRes.json() as { displayName: string };
        displayName = profile.displayName;
      }
    } catch { /* ignore */ }

    // บันทึกลง DB (upsert)
    const db = getDb();
    const existing = db.prepare("SELECT id FROM sales_line_ids WHERE sales_name = ?").get(salesName) as { id: number } | undefined;

    if (existing) {
      db.prepare("UPDATE sales_line_ids SET line_user_id = ?, display_name = ?, registered_at = datetime('now','localtime') WHERE sales_name = ?")
        .run(userId, displayName, salesName);
    } else {
      db.prepare("INSERT INTO sales_line_ids (sales_name, line_user_id, display_name) VALUES (?, ?, ?)")
        .run(salesName, userId, displayName);
    }

    // ตอบกลับ
    await jiarooPush(userId,
      `✅ ลงทะเบียนสำเร็จ!\n\nชื่อ: ${salesName}\nLINE: ${displayName || userId}\n\nระบบจะแจ้งเตือนใบเสนอราคาของคุณทาง LINE ส่วนตัวค่ะ`
    );

    console.log(`[LINE] ลงทะเบียน: ${salesName} → ${userId} (${displayName})`);
  }

  res.json({ ok: true });
});

// ดูรายชื่อเซลล์ที่ลงทะเบียนแล้ว
router.get("/registered", (_req, res) => {
  const db = getDb();
  const list = db.prepare("SELECT sales_name, display_name, registered_at FROM sales_line_ids ORDER BY registered_at DESC").all();
  res.json({ ok: true, count: (list as unknown[]).length, data: list });
});

export default router;
