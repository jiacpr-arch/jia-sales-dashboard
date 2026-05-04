import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "path";
import cron from "node-cron";
import { initSchema } from "./services/database";
import { syncQuotations, autoResolveConflicts, notifyExpiringQuotations } from "./services/flowaccount-sync";
import { sendDailyReport } from "./services/line-notify";
import { getDb } from "./services/database";
import authRoutes from "./routes/auth";
import quotationRoutes from "./routes/quotations";
import dashboardRoutes from "./routes/dashboard";
import lineWebhookRoutes from "./routes/line-webhook";

// ── Init DB schema ────────────────────────────────────────────────────────────
initSchema();

const app = express();
const PORT = Number(process.env.PORT ?? 3001);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── API Routes ────────────────────────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/quotations", quotationRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/line", lineWebhookRoutes);
// shorthand POST /api/sync → same as POST /api/quotations/sync
app.post("/api/sync", async (_req, res) => {
  try {
    const result = await syncQuotations();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ── Sales follow-up page (no login required, uses token in URL) ──────────────
import { getSalesFollowUpPage, getSalesFollowUpData } from "./routes/sales-followup";
app.get("/api/sales-followup", getSalesFollowUpData);
app.get("/followup/:token", getSalesFollowUpPage);

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ── Serve frontend SPA ────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "../public")));
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

// ── Cron jobs ─────────────────────────────────────────────────────────────────
// Sync FlowAccount ทุกเช้า 07:00
cron.schedule("0 7 * * *", async () => {
  console.log("[cron] Syncing FlowAccount quotations...");
  await syncQuotations().catch(console.error);
}, { timezone: "Asia/Bangkok" });

// LINE Notify ทุกเช้า 08:00 — daily report + conflict/expiry notifications
cron.schedule("0 8 * * *", async () => {
  console.log("[cron] Sending daily LINE report + notifications...");
  await sendDailyReport().catch(console.error);

  const db = getDb();
  await autoResolveConflicts(db, false).catch(console.error);
  await notifyExpiringQuotations(db).catch(console.error);
}, { timezone: "Asia/Bangkok" });

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🚀 Jia Raksa Sales Portal`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   http://0.0.0.0:${PORT}  (LAN access)\n`);
});
