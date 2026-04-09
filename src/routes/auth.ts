import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { getDb } from "../services/database";
import { signToken, requireAuth, JwtPayload } from "../middleware/auth";

const router = Router();

router.post("/login", (req: Request, res: Response) => {
  const { username, password } = req.body as { username: string; password: string };
  if (!username || !password) {
    res.status(400).json({ error: "กรุณากรอก username และ password" });
    return;
  }
  const db = getDb();
  const user = db.prepare(
    "SELECT id, username, password_hash, full_name, role FROM users WHERE username=? AND is_active=1"
  ).get(username) as { id: number; username: string; password_hash: string; full_name: string; role: string } | undefined;

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    res.status(401).json({ error: "username หรือ password ไม่ถูกต้อง" });
    return;
  }
  const payload: JwtPayload = { userId: user.id, username: user.username, role: user.role as "admin" | "sales" };
  const token = signToken(payload);
  res.cookie("token", token, { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 });
  res.json({ ok: true, user: { id: user.id, username: user.username, fullName: user.full_name, role: user.role } });
});

router.post("/logout", (_req: Request, res: Response) => {
  res.clearCookie("token");
  res.json({ ok: true });
});

router.get("/me", requireAuth, (req: Request, res: Response) => {
  const user = (req as Request & { user: JwtPayload }).user;
  res.json({ ok: true, user });
});

export default router;
