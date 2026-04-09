/**
 * Seed ข้อมูลทดสอบ — ใบเสนอราคา + follow-ups + conflict scenarios
 * รัน: node --experimental-sqlite -e "require('dotenv').config(); require('./node_modules/ts-node').register(); require('./src/scripts/seed-demo.ts');"
 */
import { getDb } from "../services/database";

const db = getDb();

// ── helpers ───────────────────────────────────────────────────────────────────
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
function daysFromNow(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── Get user IDs ──────────────────────────────────────────────────────────────
const admin  = db.prepare("SELECT id FROM users WHERE username='admin'").get() as { id: number };
const sales1 = db.prepare("SELECT id FROM users WHERE username='sales1'").get() as { id: number };
const sales2 = db.prepare("SELECT id FROM users WHERE username='sales2'").get() as { id: number };

// ── Quotations ────────────────────────────────────────────────────────────────
const quotations = [
  // 🟢 ปลอดภัย
  {
    fa_document_id: "FA-001", document_number: "QT-2569-0001",
    contact_name: "บริษัท เมดิคัล ซัพพลาย จำกัด", contact_tax_id: "0105565000001",
    product_codes: '["AED-001","CPR-KIT"]', total_amount: 285000,
    issue_date: daysAgo(10), expiry_date: daysFromNow(20), fa_status: "approved",
    sales_user_id: sales1.id,
  },
  {
    fa_document_id: "FA-002", document_number: "QT-2569-0002",
    contact_name: "โรงพยาบาลพระราม 9", contact_tax_id: "0994000234567",
    product_codes: '["DEFI-X200"]', total_amount: 520000,
    issue_date: daysAgo(5), expiry_date: daysFromNow(25), fa_status: "approved",
    sales_user_id: sales1.id,
  },
  {
    fa_document_id: "FA-003", document_number: "QT-2569-0003",
    contact_name: "คลินิกสุขภาพดี เชียงใหม่", contact_tax_id: "0503565001234",
    product_codes: '["OXIMETER-PRO"]', total_amount: 45000,
    issue_date: daysAgo(3), expiry_date: daysFromNow(27), fa_status: "draft",
    sales_user_id: sales2.id,
  },
  // 🟡 ใกล้หมดอายุ
  {
    fa_document_id: "FA-004", document_number: "QT-2569-0004",
    contact_name: "ศูนย์การแพทย์ฉุกเฉินภาคใต้", contact_tax_id: "0845000112233",
    product_codes: '["AED-001","TRAIN-KIT"]', total_amount: 175000,
    issue_date: daysAgo(23), expiry_date: daysFromNow(5), fa_status: "approved",
    sales_user_id: sales1.id,
  },
  {
    fa_document_id: "FA-005", document_number: "QT-2569-0005",
    contact_name: "มูลนิธิกู้ชีพกู้ภัย", contact_tax_id: "0994000099887",
    product_codes: '["CPR-KIT","MASK-SET"]', total_amount: 38500,
    issue_date: daysAgo(20), expiry_date: daysFromNow(3), fa_status: "draft",
    sales_user_id: sales2.id,
  },
  // ❌ ไม่มี follow-up นานกว่า 90 วัน → warning
  {
    fa_document_id: "FA-006", document_number: "QT-2569-0006",
    contact_name: "บริษัท เฮลท์แคร์ อีควิปเมนท์ จำกัด", contact_tax_id: "0115565009876",
    product_codes: '["VENTILATOR-PRO"]', total_amount: 980000,
    issue_date: daysAgo(95), expiry_date: daysFromNow(10), fa_status: "approved",
    sales_user_id: sales1.id,
  },
  // 🔴 หมดอายุ
  {
    fa_document_id: "FA-007", document_number: "QT-2569-0007",
    contact_name: "สถานีอนามัยบ้านท่าดี", contact_tax_id: null,
    product_codes: '["AED-001"]', total_amount: 95000,
    issue_date: daysAgo(45), expiry_date: daysAgo(15), fa_status: "draft",
    sales_user_id: sales2.id,
  },
  {
    fa_document_id: "FA-008", document_number: "QT-2569-0008",
    contact_name: "โรงเรียนพยาบาลรามา", contact_tax_id: "0994001234567",
    product_codes: '["CPR-MANIKIN-SET"]', total_amount: 230000,
    issue_date: daysAgo(60), expiry_date: daysAgo(30), fa_status: "approved",
    sales_user_id: sales1.id,
  },
  // ⚠️ ลูกค้าชน — Tax ID เดียวกัน, สินค้าเดียวกัน, เซลล์คนละคน
  {
    fa_document_id: "FA-009", document_number: "QT-2569-0009",
    contact_name: "บริษัท ไทยเมด จำกัด", contact_tax_id: "0105560012345",
    product_codes: '["AED-001"]', total_amount: 145000,
    issue_date: daysAgo(12), expiry_date: daysFromNow(18), fa_status: "approved",
    sales_user_id: sales1.id,
  },
  {
    fa_document_id: "FA-010", document_number: "QT-2569-0010",
    contact_name: "บริษัท ไทยเมด จำกัด", contact_tax_id: "0105560012345",
    product_codes: '["AED-001"]', total_amount: 145000,
    issue_date: daysAgo(8), expiry_date: daysFromNow(22), fa_status: "draft",
    sales_user_id: sales2.id,
  },
];

// ── Insert quotations ─────────────────────────────────────────────────────────
const insertQ = db.prepare(`
  INSERT OR IGNORE INTO quotations
    (fa_document_id, document_number, contact_name, contact_tax_id,
     product_codes, total_amount, issue_date, expiry_date, fa_status, sales_user_id)
  VALUES (?,?,?,?,?,?,?,?,?,?)
`);

for (const q of quotations) {
  insertQ.run(
    q.fa_document_id, q.document_number, q.contact_name, q.contact_tax_id,
    q.product_codes, q.total_amount, q.issue_date, q.expiry_date,
    q.fa_status, q.sales_user_id
  );
}

// ── Follow-ups ────────────────────────────────────────────────────────────────
const getQId = (num: string) =>
  (db.prepare("SELECT id FROM quotations WHERE document_number=?").get(num) as { id: number } | undefined)?.id;

const insertF = db.prepare(`
  INSERT INTO follow_ups (quotation_id, user_id, note, followed_at) VALUES (?,?,?,?)
`);

const followUps = [
  { qNum: "QT-2569-0001", userId: sales1.id, note: "โทรคุยกับคุณสมชาย แผนก Procurement แล้ว รอ approve งบปีหน้า", daysAgo: 2 },
  { qNum: "QT-2569-0001", userId: sales1.id, note: "ส่งสเปคเพิ่มเติม + ราคา volume discount", daysAgo: 7 },
  { qNum: "QT-2569-0002", userId: sales1.id, note: "นัด demo สินค้าสัปดาห์หน้า ทีมแพทย์ 5 คน", daysAgo: 1 },
  { qNum: "QT-2569-0003", userId: sales2.id, note: "ส่งใบเสนอราคาทาง email แล้ว รอตอบกลับ", daysAgo: 3 },
  { qNum: "QT-2569-0004", userId: sales1.id, note: "ลูกค้าขอต่ออายุ 30 วัน กำลังขออนุมัติ", daysAgo: 1 },
  // QT-0006 ไม่มี follow-up เลย (ไม่ใส่)
  { qNum: "QT-2569-0008", userId: sales1.id, note: "ติดต่อไม่ได้มา 2 เดือน ลองโทรใหม่", daysAgo: 35 },
  { qNum: "QT-2569-0009", userId: sales1.id, note: "ส่งใบเสนอราคาให้ คุณมาลี ฝ่ายจัดซื้อ", daysAgo: 10 },
  { qNum: "QT-2569-0009", userId: sales1.id, note: "Follow-up ครั้งที่ 2 — ลูกค้าสนใจ รอผู้บริหาร approve", daysAgo: 3 },
  { qNum: "QT-2569-0010", userId: sales2.id, note: "นำเสนอสินค้าที่ออฟฟิศลูกค้า", daysAgo: 6 },
];

for (const f of followUps) {
  const qId = getQId(f.qNum);
  if (!qId) continue;
  const dt = new Date();
  dt.setDate(dt.getDate() - f.daysAgo);
  insertF.run(qId, f.userId, f.note, dt.toISOString().replace("T", " ").slice(0, 19));
}

console.log(`✅ Seed เสร็จ:
  📄 ใบเสนอราคา: ${quotations.length} ใบ
  📞 Follow-ups: ${followUps.length} รายการ
  🟢 ปลอดภัย: 3 ใบ
  🟡 ใกล้หมดอายุ/ไม่ได้ติดตาม: 3 ใบ
  🔴 หมดอายุ: 2 ใบ
  ⚠️ ลูกค้าชน: 1 คู่ (บริษัท ไทยเมด จำกัด — sales1 vs sales2)`);
