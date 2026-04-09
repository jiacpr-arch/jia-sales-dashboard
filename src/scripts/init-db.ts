import "dotenv/config";
import bcrypt from "bcryptjs";
import { initSchema, getDb } from "../services/database";

initSchema();
const db = getDb();

const adminPassword = process.env.ADMIN_PASSWORD ?? "admin1234";
const hash = bcrypt.hashSync(adminPassword, 10);

// Upsert admin
const existing = db.prepare("SELECT id FROM users WHERE username='admin'").get();
if (!existing) {
  db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)")
    .run("admin", hash, "ผู้ดูแลระบบ", "admin");
  console.log("✅ สร้าง admin user เรียบร้อย password:", adminPassword);
} else {
  db.prepare("UPDATE users SET password_hash=? WHERE username='admin'").run(hash);
  console.log("✅ อัปเดต admin password เรียบร้อย password:", adminPassword);
}

// Seed demo sales users
const demoUsers = [
  { username: "sales1", name: "สมศรี ขายดี" },
  { username: "sales2", name: "วิชัย โปรโมท" },
];
for (const u of demoUsers) {
  const ex = db.prepare("SELECT id FROM users WHERE username=?").get(u.username);
  if (!ex) {
    db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)")
      .run(u.username, bcrypt.hashSync("1234", 10), u.name, "sales");
    console.log(`✅ สร้าง user ${u.username} (password: 1234)`);
  }
}

console.log("✅ Database initialized:", process.env.DB_PATH);
