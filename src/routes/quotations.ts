import { Router, Request, Response } from "express";
import { getDb, type Stmt as _Stmt } from "../services/database";
import { requireAuth, requireAdmin, JwtPayload } from "../middleware/auth";

const router = Router();

// ── List quotations ──────────────────────────────────────────────────────────
router.get("/", requireAuth, (req: Request, res: Response) => {
  const { status, sales, search, page = "1", limit = "20" } = req.query as Record<string, string>;
  const db = getDb();
  const offset = (parseInt(page) - 1) * parseInt(limit);
  let where = "1=1";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any[] = [];
  if (status) { where += " AND health=?"; params.push(status); }
  if (sales)  { where += " AND sales_user_id=?"; params.push(Number(sales)); }
  if (search) { where += " AND (contact_name LIKE ? OR document_number LIKE ?)"; params.push(`%${search}%`, `%${search}%`); }

  const rows = db.prepare(`SELECT * FROM v_quotation_status WHERE ${where} ORDER BY issue_date DESC LIMIT ? OFFSET ?`)
    .all(...params, parseInt(limit), offset);
  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM v_quotation_status WHERE ${where}`).get(...params) as { total: number };
  res.json({ ok: true, data: rows, total, page: parseInt(page), limit: parseInt(limit) });
});

// ── Get single quotation ─────────────────────────────────────────────────────
router.get("/:id", requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare("SELECT * FROM v_quotation_status WHERE id=?").get(req.params.id);
  if (!row) { res.status(404).json({ error: "ไม่พบเอกสาร" }); return; }
  const followUps = db.prepare(`
    SELECT f.*, u.full_name AS user_name FROM follow_ups f
    LEFT JOIN users u ON u.id=f.user_id
    WHERE f.quotation_id=? ORDER BY f.followed_at DESC
  `).all(req.params.id);
  res.json({ ok: true, data: row, followUps });
});

// ── Add follow-up ────────────────────────────────────────────────────────────
router.post("/:id/followup", requireAuth, (req: Request, res: Response) => {
  const user = (req as Request & { user: JwtPayload }).user;
  const { note } = req.body as { note?: string };
  const db = getDb();
  const q = db.prepare("SELECT id FROM quotations WHERE id=?").get(req.params.id);
  if (!q) { res.status(404).json({ error: "ไม่พบเอกสาร" }); return; }
  const result = db.prepare("INSERT INTO follow_ups (quotation_id, user_id, note) VALUES (?,?,?)").run(
    req.params.id, user.userId, note ?? null
  );
  res.json({ ok: true, id: result.lastInsertRowid });
});

// ── Conflicts ────────────────────────────────────────────────────────────────
router.get("/check/conflicts", requireAuth, (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM v_conflicts").all();
  res.json({ ok: true, data: rows, total: rows.length });
});

// ── Resolve conflict (admin only) ────────────────────────────────────────────
router.post("/check/resolve", requireAdmin, (req: Request, res: Response) => {
  const admin = (req as Request & { user: JwtPayload }).user;
  const { winnerId, loserId, reason } = req.body as { winnerId: number; loserId: number; reason?: string };
  if (!winnerId || !loserId) { res.status(400).json({ error: "ต้องระบุ winnerId และ loserId" }); return; }

  const db = getDb();
  // Check 90-day rule: winner must have follow-up within 90 days
  const lastFollow = db.prepare(`
    SELECT MAX(followed_at) AS last FROM follow_ups WHERE quotation_id=?
  `).get(winnerId) as { last: string | null };

  const daysSinceFollow = lastFollow?.last
    ? (Date.now() - new Date(lastFollow.last).getTime()) / 86400000
    : Infinity;

  if (daysSinceFollow > 90) {
    res.status(409).json({
      error: `เซลล์ผู้ชนะไม่ได้ follow-up ลูกค้านานกว่า 90 วัน (${Math.floor(daysSinceFollow)} วัน) — สิทธิ์หลุดแล้ว`,
      daysSinceFollow: Math.floor(daysSinceFollow)
    });
    return;
  }
  db.prepare(`
    INSERT INTO conflict_resolutions (winner_quot_id, loser_quot_id, resolved_by, reason)
    VALUES (?,?,?,?)
  `).run(winnerId, loserId, admin.userId, reason ?? null);
  res.json({ ok: true, message: "ตัดสินสิทธิ์เรียบร้อย" });
});

// ── Sales ranking ─────────────────────────────────────────────────────────────
router.get("/stats/ranking", requireAuth, (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT u.id, u.full_name, u.username,
      COUNT(DISTINCT q.id)                                       AS total_quotes,
      COUNT(DISTINCT CASE WHEN v.health='safe'    THEN q.id END) AS safe,
      COUNT(DISTINCT CASE WHEN v.health='warning' THEN q.id END) AS warning,
      COUNT(DISTINCT CASE WHEN v.health='expired' THEN q.id END) AS expired,
      COALESCE((SELECT SUM(total_amount) FROM quotations WHERE sales_user_id=u.id), 0) AS total_amount,
      (SELECT MAX(f.followed_at) FROM follow_ups f WHERE f.user_id=u.id) AS last_activity
    FROM users u
    LEFT JOIN quotations q ON q.sales_user_id=u.id
    LEFT JOIN v_quotation_status v ON v.id=q.id
    WHERE u.role='sales'
    GROUP BY u.id
    ORDER BY total_amount DESC
  `).all();
  res.json({ ok: true, data: rows });
});

// ── Pipeline: get quotations grouped by stage ────────────────────────────────
const PIPELINE_STAGES = ['new', 'contacted', 'quoted', 'negotiating', 'won', 'lost'] as const;

router.get("/pipeline/board", requireAuth, (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      v.*,
      CASE
        WHEN v.last_follow_up IS NOT NULL
          THEN CAST(julianday('now','localtime') - julianday(v.last_follow_up) AS INTEGER)
        ELSE NULL
      END AS days_since_follow_up
    FROM v_quotation_status v
    ORDER BY v.total_amount DESC
  `).all() as Record<string, unknown>[];

  // Group by stage
  const grouped: Record<string, unknown[]> = {};
  for (const stage of PIPELINE_STAGES) grouped[stage] = [];
  for (const row of rows) {
    const stage = (row.pipeline_stage as string) || 'new';
    if (grouped[stage]) grouped[stage].push(row);
    else grouped['new'].push(row);
  }

  // Summary counts
  const summary: Record<string, { count: number; totalAmount: number }> = {};
  for (const stage of PIPELINE_STAGES) {
    summary[stage] = {
      count: grouped[stage].length,
      totalAmount: (grouped[stage] as Array<Record<string, unknown>>).reduce((s: number, r) => s + Number(r.total_amount || 0), 0),
    };
  }

  res.json({ ok: true, stages: PIPELINE_STAGES, data: grouped, summary });
});

// ── Pipeline: update stage ───────────────────────────────────────────────────
router.put("/:id/stage", requireAuth, async (req: Request, res: Response) => {
  const user = (req as Request & { user: JwtPayload }).user;
  const { stage } = req.body as { stage?: string };
  if (!stage || !(PIPELINE_STAGES as readonly string[]).includes(stage)) {
    res.status(400).json({ error: `stage ต้องเป็น: ${PIPELINE_STAGES.join(', ')}` });
    return;
  }
  const db = getDb();
  const q = db.prepare("SELECT q.*, u.full_name AS sales_name FROM quotations q LEFT JOIN users u ON u.id=q.sales_user_id WHERE q.id=?").get(req.params.id) as Record<string, unknown> | undefined;
  if (!q) { res.status(404).json({ error: "ไม่พบเอกสาร" }); return; }

  const oldStage = q.pipeline_stage || 'new';
  db.prepare("UPDATE quotations SET pipeline_stage=?, pipeline_updated_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?")
    .run(stage, req.params.id);

  void oldStage;
  res.json({ ok: true, message: `อัปเดต pipeline เป็น "${stage}" เรียบร้อย` });
});

// ── Export CSV ────────────────────────────────────────────────────────────────
router.get("/export/csv", requireAuth, (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM v_quotation_status ORDER BY issue_date DESC").all() as Record<string, unknown>[];
  const headers = Object.keys(rows[0] ?? {});
  const csv = [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => `"${String(r[h] ?? "").replace(/"/g, '""')}"`).join(",")),
  ].join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="quotations-${Date.now()}.csv"`);
  res.send("\uFEFF" + csv); // BOM for Excel Thai
});

router.post("/sync", requireAdmin, (_req: Request, res: Response) => {
  res.status(503).json({ error: "Sync disabled — migration to jiaraksa-crm in progress" });
});

export default router;
