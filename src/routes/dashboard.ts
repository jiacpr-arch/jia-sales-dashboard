import { Router } from "express";
import { faGet } from "../services/flowaccount-api";
import { requireAuth } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

// ── Types ────────────────────────────────────────────────────────────────────
interface FAInvoice {
  documentSerial?: string;
  contactName?: string;
  grandTotal?: number | string;
  publishedOn?: string;
  statusString?: string;
  salesName?: string;
  items?: Array<{ name?: string; quantity?: string | number; total?: string | number }>;
}

interface FAListResponse {
  data?: { totalDocument?: string; list?: FAInvoice[] };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function toNum(v: unknown): number {
  return Number(v) || 0;
}

function startOfMonth(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;
}

function endOfMonth(date: Date): string {
  const last = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  return `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, "0")}-${String(last.getDate()).padStart(2, "0")}`;
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function fetchInvoices(dateFrom: string, dateTo: string, pageSize = 100): Promise<FAInvoice[]> {
  const all: FAInvoice[] = [];
  let page = 1;
  const maxPages = 10; // safety limit
  while (page <= maxPages) {
    const res = await faGet<FAListResponse>(
      `/cash-invoices?currentPage=${page}&pageSize=${pageSize}`
    );
    const list = res?.data?.list ?? [];
    if (list.length === 0) break;

    for (const inv of list) {
      const pubDate = (inv.publishedOn ?? "").slice(0, 10);
      if (pubDate >= dateFrom && pubDate <= dateTo) {
        all.push(inv);
      } else if (pubDate < dateFrom) {
        return all; // past our range, stop
      }
    }
    page++;
  }
  return all;
}

// ── GET /api/dashboard/overview ─────────────────────────────────────────────
router.get("/overview", async (_req, res) => {
  try {
    const now = new Date();
    const today = todayStr();
    const monthStart = startOfMonth(now);
    const monthEnd = endOfMonth(now);

    // Previous month
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevStart = startOfMonth(prevMonth);
    const prevEnd = endOfMonth(prevMonth);

    const [thisMonthInvoices, prevMonthInvoices] = await Promise.all([
      fetchInvoices(monthStart, monthEnd),
      fetchInvoices(prevStart, prevEnd),
    ]);

    const todayInvoices = thisMonthInvoices.filter(
      (i) => (i.publishedOn ?? "").slice(0, 10) === today
    );

    const todaySales = todayInvoices.reduce((s, i) => s + toNum(i.grandTotal), 0);
    const todayCount = todayInvoices.length;
    const monthSales = thisMonthInvoices.reduce((s, i) => s + toNum(i.grandTotal), 0);
    const monthCount = thisMonthInvoices.length;
    const prevMonthSales = prevMonthInvoices.reduce((s, i) => s + toNum(i.grandTotal), 0);

    const awaiting = thisMonthInvoices.filter((i) => i.statusString === "awaiting");
    const awaitingTotal = awaiting.reduce((s, i) => s + toNum(i.grandTotal), 0);
    const awaitingCount = awaiting.length;

    const changePercent = prevMonthSales > 0
      ? ((monthSales - prevMonthSales) / prevMonthSales) * 100
      : 0;

    res.json({
      today: { sales: todaySales, count: todayCount },
      thisMonth: { sales: monthSales, count: monthCount },
      prevMonth: { sales: prevMonthSales },
      awaiting: { total: awaitingTotal, count: awaitingCount },
      changePercent: Math.round(changePercent * 10) / 10,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/dashboard/sales-ranking ────────────────────────────────────────
router.get("/sales-ranking", async (_req, res) => {
  try {
    const now = new Date();
    const invoices = await fetchInvoices(startOfMonth(now), endOfMonth(now));
    const today = todayStr();

    const byName: Record<string, { monthSales: number; monthCount: number; todaySales: number; todayCount: number }> = {};

    for (const inv of invoices) {
      const name = inv.salesName || "ไม่ระบุ";
      if (!byName[name]) byName[name] = { monthSales: 0, monthCount: 0, todaySales: 0, todayCount: 0 };
      const amount = toNum(inv.grandTotal);
      byName[name].monthSales += amount;
      byName[name].monthCount++;
      if ((inv.publishedOn ?? "").slice(0, 10) === today) {
        byName[name].todaySales += amount;
        byName[name].todayCount++;
      }
    }

    const ranking = Object.entries(byName)
      .map(([name, data]) => ({ name, ...data }))
      .sort((a, b) => b.monthSales - a.monthSales);

    res.json(ranking);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/dashboard/top-customers ────────────────────────────────────────
router.get("/top-customers", async (_req, res) => {
  try {
    const now = new Date();
    const invoices = await fetchInvoices(startOfMonth(now), endOfMonth(now));

    const byCustomer: Record<string, { total: number; count: number }> = {};
    for (const inv of invoices) {
      const name = inv.contactName || "ไม่ระบุ";
      if (!byCustomer[name]) byCustomer[name] = { total: 0, count: 0 };
      byCustomer[name].total += toNum(inv.grandTotal);
      byCustomer[name].count++;
    }

    const top = Object.entries(byCustomer)
      .map(([name, data]) => ({ name, ...data }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);

    res.json(top);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/dashboard/top-products ─────────────────────────────────────────
router.get("/top-products", async (_req, res) => {
  try {
    const now = new Date();
    const invoices = await fetchInvoices(startOfMonth(now), endOfMonth(now));

    const byProduct: Record<string, { qty: number; revenue: number }> = {};
    for (const inv of invoices) {
      for (const item of inv.items ?? []) {
        const name = item.name || "ไม่ระบุ";
        if (!byProduct[name]) byProduct[name] = { qty: 0, revenue: 0 };
        byProduct[name].qty += toNum(item.quantity);
        byProduct[name].revenue += toNum(item.total);
      }
    }

    const top = Object.entries(byProduct)
      .map(([name, data]) => ({ name, ...data }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    res.json(top);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
