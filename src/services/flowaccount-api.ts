/**
 * FlowAccount API Client — shared module
 * ใช้ร่วมกันระหว่าง sync, dashboard, และฟีเจอร์อื่น
 */

const TOKEN_URL = process.env.FLOWACCOUNT_TOKEN_URL ?? "https://openapi.flowaccount.com/test/token";
const BASE_URL  = process.env.FLOWACCOUNT_BASE_URL  ?? "https://openapi.flowaccount.com/test";
const CLIENT_ID = process.env.FLOWACCOUNT_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.FLOWACCOUNT_CLIENT_SECRET ?? "";

let cachedToken = "";
let tokenExpiresAt = 0;

export async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: "flowaccount-api",
    }),
  });
  if (!res.ok) throw new Error(`FlowAccount token error: ${res.status}`);
  const data = await res.json() as { access_token: string; expires_in: number };
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

export async function faGet<T = unknown>(path: string): Promise<T> {
  const token = await getToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`FlowAccount GET ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export async function faPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const token = await getToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`FlowAccount POST ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}
