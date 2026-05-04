import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "path";
import { initSchema } from "./services/database";
import authRoutes from "./routes/auth";
import quotationRoutes from "./routes/quotations";
import dashboardRoutes from "./routes/dashboard";

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

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🚀 Jia Raksa Sales Portal`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   http://0.0.0.0:${PORT}  (LAN access)\n`);
});
