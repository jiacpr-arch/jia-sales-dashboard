import { getDb } from "./database";
import { lineMessage, notifySalesPerson } from "./line-notify";
import { faGet } from "./flowaccount-api";

interface FAQuotation {
  documentId?: number;
  recordId?: number;
  documentSerial?: string;
  contactName?: string;
  contactTaxId?: string;
  publishedOn?: string;
  dueDate?: string;
  status?: string;
  grandTotal?: number | string;
  salesName?: string;
  items?: Array<{ name?: string }>;
}

export async function syncQuotations(): Promise<{ added: number; updated: number }> {
  const db = getDb();
  let added = 0;
  let updated = 0;

  try {
    // ดึงหลาย page — 12 เดือนล่าสุด
    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - 12);
    const cutoff = cutoffDate.toISOString().slice(0, 10);

    const allRows: FAQuotation[] = [];
    let page = 1;
    const maxPages = 200; // safety limit (200 pages × 100 = 20,000 records)
    let keepGoing = true;

    while (page <= maxPages && keepGoing) {
      const data = await faGet(
        `/quotations?currentPage=${page}&pageSize=100`
      ) as { data?: { totalDocument?: string; list?: FAQuotation[] } };

      const list = data?.data?.list ?? [];
      if (list.length === 0) break;

      for (const q of list) {
        const pubDate = (q.publishedOn ?? "").slice(0, 10);
        if (pubDate >= cutoff) {
          allRows.push(q);
        } else {
          keepGoing = false; // ถึงข้อมูลเก่ากว่า 12 เดือน หยุด
          break;
        }
      }

      console.log(`[Sync] Page ${page}: ${list.length} records (total so far: ${allRows.length})`);
      page++;
    }

    console.log(`[Sync] Total fetched: ${allRows.length} quotations (${page - 1} pages, cutoff: ${cutoff})`);
    const rows = allRows;

    // ── Normalize salesName (จัดกลุ่มชื่อซ้ำ) ──────────────────────────────
    const SALES_NAME_MAP: Record<string, string> = {
      // J variants
      "J 0909791212": "J",
      "เจ 0909791212": "J",
      "Jia Cpr": "J",
      "Fern-J": "J",
      "F-J": "J",
      // แก้มใส variants
      "แก้มใส": "แก้มใส 093-1271669",
      "แกัมใส": "แก้มใส 093-1271669",  // typo
      // อลิตา variants
      "อลิตา ภู่กัน": "อลิตา 0810120169",
      "อลิตา ภู่กัน 0810120169": "อลิตา 0810120169",
      "Alita 0810120169": "อลิตา 0810120169",
      // นวพรรธน์ variants
      "นวพรรธน์ 098 6693266": "นวพรรธน์ 098 669 3266",
      // แพท
      "แพท 098 669 3266": "แพท 098 669 3266",
      // Fah variants
      "Fah Jia0625200270": "Fah Jia",
      // Vanida
      "วนิดา": "Vanida",
    };

    function normalizeSalesName(name: string): string {
      return SALES_NAME_MAP[name] ?? name;
    }

    // Auto-create users from salesName
    const findOrCreateUser = (salesName: string): number | null => {
      if (!salesName) return null;
      const existing = db.prepare("SELECT id FROM users WHERE full_name = ?").get(salesName) as { id: number } | undefined;
      if (existing) return existing.id;
      // Create new user (sales role, random password — login via admin only)
      const username = salesName.replace(/\s+/g, "_").toLowerCase().slice(0, 30);
      try {
        const result = db.prepare(
          "INSERT INTO users (username, password_hash, full_name, role) VALUES (?, 'NOLOGIN', ?, 'sales')"
        ).run(username, salesName);
        console.log(`[Sync] Auto-created user: ${salesName} (id=${result.lastInsertRowid})`);
        return Number(result.lastInsertRowid);
      } catch {
        // Duplicate username — try with suffix
        const result = db.prepare(
          "INSERT INTO users (username, password_hash, full_name, role) VALUES (?, 'NOLOGIN', ?, 'sales')"
        ).run(username + "_" + Date.now().toString(36), salesName);
        return Number(result.lastInsertRowid);
      }
    };

    for (const q of rows) {
      try {
        const faId = String(q.documentId ?? q.recordId ?? "");
        if (!faId) continue;
        const productCodes = JSON.stringify((q.items ?? []).map((i) => i.name).filter(Boolean));
        const grandTotal = typeof q.grandTotal === "string" ? parseFloat(q.grandTotal) : (q.grandTotal ?? 0);
        const salesUserId = findOrCreateUser(normalizeSalesName(q.salesName ?? ""));
        const existing = db.prepare("SELECT id FROM quotations WHERE fa_document_id = ?").get(faId);
        if (existing) {
          db.prepare(`
            UPDATE quotations
            SET document_number=?, contact_name=?, contact_tax_id=?,
                product_codes=?, total_amount=?, issue_date=?,
                expiry_date=?, fa_status=?, sales_user_id=?, updated_at=datetime('now','localtime')
            WHERE fa_document_id=?
          `).run(
            q.documentSerial ?? "", q.contactName ?? "", q.contactTaxId ?? "",
            productCodes, grandTotal,
            q.publishedOn?.slice(0, 10) ?? "",
            q.dueDate?.slice(0, 10) ?? null,
            q.status ?? "1",
            salesUserId,
            faId
          );
          updated++;
        } else {
          db.prepare(`
            INSERT INTO quotations
              (fa_document_id, document_number, contact_name, contact_tax_id,
               product_codes, total_amount, issue_date, expiry_date, fa_status, sales_user_id)
            VALUES (?,?,?,?,?,?,?,?,?,?)
          `).run(
            faId, q.documentSerial ?? "", q.contactName ?? "", q.contactTaxId ?? "",
            productCodes, grandTotal,
            q.publishedOn?.slice(0, 10) ?? "",
            q.dueDate?.slice(0, 10) ?? null,
            q.status ?? "1",
            salesUserId
          );
          added++;
        }
      } catch (err) {
        // Skip individual record errors (FK constraint, etc.)
        continue;
      }
    }
    db.prepare("INSERT INTO sync_log (status, records, message) VALUES (?,?,?)")
      .run("success", added + updated, `added=${added} updated=${updated}`);

    // Auto-resolve conflicts (DB changes only, no LINE notifications during sync)
    await autoResolveConflicts(db, false);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.prepare("INSERT INTO sync_log (status, records, message) VALUES (?,?,?)")
      .run("error", 0, msg);
    console.error("FlowAccount sync error:", msg);
  }
  return { added, updated };
}

// ── Auto-resolve conflicts ──────────────────────────────────────────────────
// กฎ:
// 1. ดูใบล่าสุดของแต่ละคน — ถ้าเกิน 90 วัน → หมดสิทธิ์
// 2. ถ้ายังไม่เกิน 90 วันทั้งคู่ → คนออกใบแรกก่อน ได้สิทธิ์
// 3. ถ้าทั้งคู่เกิน 90 วัน → รอ admin ตัดสิน
const CONFLICT_EXPIRE_DAYS = 90; // 3 เดือน — ใบล่าสุดเกินนี้ถือว่าหมดสิทธิ์

export async function autoResolveConflicts(db: ReturnType<typeof getDb>, sendNotifications = true): Promise<void> {
  const conflicts = db.prepare("SELECT * FROM v_conflicts").all() as Array<{
    quot_a_id: number; quot_a_date: string; sales_a_id: number; sales_a_name: string;
    quot_b_id: number; quot_b_date: string; sales_b_id: number; sales_b_name: string;
    contact_name: string; product_codes: string;
  }>;

  const now = Date.now();

  for (const c of conflicts) {
    const resolved = db.prepare(
      "SELECT id FROM conflict_resolutions WHERE (winner_quot_id=? AND loser_quot_id=?) OR (winner_quot_id=? AND loser_quot_id=?)"
    ).get(c.quot_a_id, c.quot_b_id, c.quot_b_id, c.quot_a_id);
    if (resolved) continue;

    // หาใบล่าสุดของแต่ละเซลล์กับลูกค้านี้
    const aLatest = db.prepare(
      "SELECT MAX(issue_date) AS d FROM quotations WHERE sales_user_id=? AND contact_name=?"
    ).get(c.sales_a_id, c.contact_name) as { d: string | null };
    const bLatest = db.prepare(
      "SELECT MAX(issue_date) AS d FROM quotations WHERE sales_user_id=? AND contact_name=?"
    ).get(c.sales_b_id, c.contact_name) as { d: string | null };

    const aDaysAgo = aLatest?.d ? Math.round((now - new Date(aLatest.d).getTime()) / 86400000) : 9999;
    const bDaysAgo = bLatest?.d ? Math.round((now - new Date(bLatest.d).getTime()) / 86400000) : 9999;

    const aExpired = aDaysAgo > CONFLICT_EXPIRE_DAYS;
    const bExpired = bDaysAgo > CONFLICT_EXPIRE_DAYS;

    // หาใครออกใบแรกก่อน
    const aFirstDate = db.prepare(
      "SELECT MIN(issue_date) AS d FROM quotations WHERE sales_user_id=? AND contact_name=?"
    ).get(c.sales_a_id, c.contact_name) as { d: string | null };
    const bFirstDate = db.prepare(
      "SELECT MIN(issue_date) AS d FROM quotations WHERE sales_user_id=? AND contact_name=?"
    ).get(c.sales_b_id, c.contact_name) as { d: string | null };
    const aIssuedFirst = (aFirstDate?.d ?? "9999") <= (bFirstDate?.d ?? "9999");

    let winner: string | null = null;
    let loserName: string | null = null;
    let winnerId: number, loserId: number;
    let reason: string;

    if (aExpired && bExpired) {
      // ทั้งคู่หมดสิทธิ์ → รอ admin
      continue;
    } else if (aExpired && !bExpired) {
      // A หมดสิทธิ์ → B ได้
      winner = c.sales_b_name; loserName = c.sales_a_name;
      winnerId = c.quot_b_id; loserId = c.quot_a_id;
      reason = `${c.sales_a_name} ใบล่าสุด ${aDaysAgo} วันก่อน (>90 วัน หมดสิทธิ์) → ${c.sales_b_name} ได้สิทธิ์`;
    } else if (!aExpired && bExpired) {
      // B หมดสิทธิ์ → A ได้
      winner = c.sales_a_name; loserName = c.sales_b_name;
      winnerId = c.quot_a_id; loserId = c.quot_b_id;
      reason = `${c.sales_b_name} ใบล่าสุด ${bDaysAgo} วันก่อน (>90 วัน หมดสิทธิ์) → ${c.sales_a_name} ได้สิทธิ์`;
    } else {
      // ทั้งคู่ยังตามอยู่ → คนออกก่อนได้
      if (aIssuedFirst) {
        winner = c.sales_a_name; loserName = c.sales_b_name;
        winnerId = c.quot_a_id; loserId = c.quot_b_id;
        reason = `ทั้งคู่ยังตามอยู่ — ${c.sales_a_name} ออกใบก่อน`;
      } else {
        winner = c.sales_b_name; loserName = c.sales_a_name;
        winnerId = c.quot_b_id; loserId = c.quot_a_id;
        reason = `ทั้งคู่ยังตามอยู่ — ${c.sales_b_name} ออกใบก่อน`;
      }
    }

    try {
      db.prepare(
        "INSERT INTO conflict_resolutions (winner_quot_id, loser_quot_id, resolved_by, reason) VALUES (?,?,0,?)"
      ).run(winnerId, loserId, `ตัดสินอัตโนมัติ: ${reason}`);
    } catch { continue; }

    if (sendNotifications) {
      await lineMessage(`⚖️ ตัดสินอัตโนมัติ: ลูกค้า "${c.contact_name}"\n✅ ${winner} ได้สิทธิ์\n❌ ${loserName} สิทธิ์หลุด\nเหตุผล: ${reason}`);
      await notifySalesPerson(winner, `🎉 คุณได้สิทธิ์ลูกค้า "${c.contact_name}"\nเหตุผล: ${reason}`);
      await notifySalesPerson(loserName, `❌ สิทธิ์ลูกค้า "${c.contact_name}" ตกไป ${winner}\nเหตุผล: ${reason}`);
    }
  }
}

// ── Notify new (unresolved) conflicts ──
export async function notifyNewConflicts(db: ReturnType<typeof getDb>): Promise<void> {
  const unresolved = db.prepare(`
    SELECT c.*,
      NOT EXISTS (
        SELECT 1 FROM conflict_resolutions cr
        WHERE (cr.winner_quot_id=c.quot_a_id AND cr.loser_quot_id=c.quot_b_id)
           OR (cr.winner_quot_id=c.quot_b_id AND cr.loser_quot_id=c.quot_a_id)
      ) AS is_new
    FROM v_conflicts c
  `).all() as Array<{
    contact_name: string; sales_a_name: string; sales_b_name: string;
    quot_a_number: string; quot_b_number: string; is_new: number;
  }>;

  const newConflicts = unresolved.filter(c => c.is_new);
  if (newConflicts.length === 0) return;

  const lines = [
    `⚠️ พบลูกค้าชนกัน ${newConflicts.length} คู่ (รอตัดสิน)`,
    "",
    ...newConflicts.slice(0, 5).map(c =>
      `• ${c.contact_name}: ${c.sales_a_name} vs ${c.sales_b_name}`
    ),
    ...(newConflicts.length > 5 ? [`... และอีก ${newConflicts.length - 5} คู่`] : []),
  ];
  await lineMessage(lines.join("\n"));

  // ส่งแจ้งเตือนรายคนให้ทั้งสองคนที่ชนกัน
  for (const c of newConflicts) {
    const msg = `⚠️ ลูกค้าชน: "${c.contact_name}"\nคุณชนกับ `;
    await notifySalesPerson(c.sales_a_name, msg + c.sales_b_name + `\nใบ: ${c.quot_a_number} vs ${c.quot_b_number}`);
    await notifySalesPerson(c.sales_b_name, msg + c.sales_a_name + `\nใบ: ${c.quot_b_number} vs ${c.quot_a_number}`);
  }
}

// ── Notify quotations expiring within 7 days (90-day follow-up rule) ──
// Checks expiry_notifications_sent to avoid duplicate alerts
export async function notifyExpiringQuotations(db: ReturnType<typeof getDb>): Promise<void> {
  const expiring = db.prepare(`
    SELECT q.id AS quotation_id, q.document_number, q.contact_name,
      u.full_name AS sales_name,
      fu.followed_at AS last_follow,
      CAST(JULIANDAY('now','localtime') - JULIANDAY(fu.followed_at) AS INTEGER) AS days_since
    FROM quotations q
    LEFT JOIN users u ON u.id = q.sales_user_id
    LEFT JOIN (
      SELECT quotation_id, MAX(followed_at) AS followed_at
      FROM follow_ups GROUP BY quotation_id
    ) fu ON fu.quotation_id = q.id
    WHERE fu.followed_at IS NOT NULL
      AND JULIANDAY('now','localtime') - JULIANDAY(fu.followed_at) BETWEEN 83 AND 90
  `).all() as Array<{
    quotation_id: number; document_number: string; contact_name: string;
    sales_name: string; days_since: number;
  }>;

  if (expiring.length === 0) return;

  // Filter out quotations that already received this notification type
  const toNotify = expiring.filter(q => {
    const daysLeft = 90 - q.days_since;
    const notifType = daysLeft <= 1 ? "1day" : "7day";
    const already = db.prepare(
      "SELECT 1 FROM expiry_notifications_sent WHERE quotation_id = ? AND notification_type = ?"
    ).get(q.quotation_id, notifType);
    return !already;
  });

  if (toNotify.length === 0) return;

  // ส่งกลุ่ม
  const lines = [
    `🔔 ใบเสนอราคาใกล้หมด 90 วัน — ต้องตามลูกค้า!`,
    "",
    ...toNotify.map(q =>
      `• ${q.document_number} — ${q.contact_name} (${q.sales_name}) เหลือ ${90 - q.days_since} วัน`
    ),
  ];
  await lineMessage(lines.join("\n"));

  // ส่งรายคนให้เซลล์ที่เกี่ยวข้อง + record in dedup table
  for (const q of toNotify) {
    const daysLeft = 90 - q.days_since;
    const notifType = daysLeft <= 1 ? "1day" : "7day";

    await notifySalesPerson(q.sales_name,
      `🔔 ใบเสนอราคาใกล้หมดอายุ!\n\n` +
      `📄 ${q.document_number}\n` +
      `👤 ${q.contact_name}\n` +
      `⏰ เหลืออีก ${daysLeft} วัน\n\n` +
      `กรุณาติดต่อลูกค้าด่วน!`
    );

    // Mark as sent to prevent duplicate notifications
    try {
      db.prepare(
        "INSERT OR IGNORE INTO expiry_notifications_sent (quotation_id, notification_type) VALUES (?, ?)"
      ).run(q.quotation_id, notifType);
    } catch { /* ignore duplicate */ }
  }
}
