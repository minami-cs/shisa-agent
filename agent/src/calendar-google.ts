// Google 캘린더(OAuth, 읽기 전용) 읽기: calendars/primary/events 를 기간으로 받아 우리 일정(CalEvent)으로 바꾼다(calendar-sync.ts icsSource 가 부른다).
// 범위는 https://www.googleapis.com/auth/calendar.readonly 하나뿐. 일정을 만들거나 바꾸는 요청은 없다.
// 토큰(리프레시·액세스)은 HOME_DIR/google-calendar-token.json(권한 600)에만 두고 응답·로그·화면에 넣지 않는다(addLogSecret).
// 액세스 토큰이 끝나 가면 리프레시 토큰으로 새로 받는다. 리프레시 토큰이 끝났으면(테스트 모드 앱은 7일 · 권한 취소) code "reauth" 로 다시 로그인하라고 알린다.
// 로그인(브라우저 · 루프백 리디렉션 · 코드 → 토큰)은 calendar-google-connect.ts.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { HOME_DIR } from "./config.ts";
import { stripBom, writeFileAtomic } from "./fs-atomic.ts";
import { addLogSecret } from "./log.ts";
import { calendarId } from "./connectors.ts";
import { zonedToUtc } from "./ics.ts";
import { t } from "./i18n.ts";
import type { CalEvent } from "./calendar-sync.ts";

export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
// 설정 파일 calendars[] 의 Google 줄: account = GOOGLE_ACCOUNT_ID, url = 일정 주소(비밀 아님), id = 그 주소의 calendarId
export const GOOGLE_ACCOUNT_ID = "g-primary";
export const GOOGLE_CALENDAR_ID = calendarId(GOOGLE_EVENTS_URL);
export const googleTokenPath = () => join(HOME_DIR, "google-calendar-token.json");

// 설정 connectors.calendar.google = { clientId, clientSecret }(설정 창에서 넣는다)
export type GoogleClient = { clientId: string; clientSecret: string };
export type GoogleToken = { refreshToken: string; accessToken?: string; expiresAt?: number; scope?: string };
export type GoogleDeps = { fetch?: typeof fetch; tokenPath?: string; now?: () => number };

export class GoogleCalError extends Error {
  code: string; status?: number;
  constructor(code: string, msg: string, status?: number) { super(msg); this.code = code; if (status !== undefined) this.status = status; }
}

// ── 토큰 파일 ──────────────────────────────────────────────

export function readGoogleToken(path = googleTokenPath()): GoogleToken | null {
  try {
    const v = JSON.parse(stripBom(readFileSync(path, "utf8")));
    if (!v || typeof v.refreshToken !== "string" || !v.refreshToken) return null;
    addLogSecret(v.refreshToken);
    if (typeof v.accessToken === "string") addLogSecret(v.accessToken);
    return {
      refreshToken: v.refreshToken,
      ...(typeof v.accessToken === "string" && v.accessToken ? { accessToken: v.accessToken } : {}),
      ...(Number.isFinite(v.expiresAt) ? { expiresAt: v.expiresAt } : {}),
      ...(typeof v.scope === "string" ? { scope: v.scope } : {}),
    };
  } catch { return null; }
}
export function writeGoogleToken(tok: GoogleToken, path = googleTokenPath()): void {
  addLogSecret(tok.refreshToken);
  addLogSecret(tok.accessToken);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify(tok, null, 2)}\n`, { mode: 0o600 });
}
export function removeGoogleToken(path = googleTokenPath()): boolean {
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

// ── 오류 → 사람 말 ─────────────────────────────────────────

export function googleFailReason(e: any): { code: string; reason: string } {
  const code = e instanceof GoogleCalError ? e.code : "";
  const msg = String(e?.message ?? e ?? "");
  const cause = String(e?.cause?.code ?? e?.code ?? "");
  if (code === "reauth") return { code, reason: t("status.gcal_reauth") };
  if (code === "client") return { code, reason: t("status.gcal_client") };
  if (code === "scope") return { code, reason: t("status.gcal_scope") };
  if (code === "api") return { code, reason: t("status.gcal_api") };
  if (code === "http") return { code, reason: t("status.gcal_http", { st: e.status ?? "?" }) };
  if (code === "format") return { code, reason: t("status.gcal_format") };
  if (e?.name === "TimeoutError" || e?.name === "AbortError" || /timeout|timed out/i.test(msg)) return { code: "timeout", reason: t("status.gcal_timeout") };
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT/i.test(cause) || /fetch failed/i.test(msg)) return { code: "network", reason: t("status.gcal_network") };
  return { code: "other", reason: t("status.ics_other", { msg: msg.slice(0, 60) || t("status.unknown_error") }) };
}

// ── 토큰 받기 · 새로 고침 ──────────────────────────────────

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

// 토큰 주소에 폼으로 묻는다. Google 오류(invalid_grant 등)를 우리 code 로
export async function tokenRequest(params: Record<string, string>, deps: GoogleDeps = {}): Promise<any> {
  const r = await (deps.fetch ?? fetch)(GOOGLE_TOKEN_URL, {
    method: "POST", signal: AbortSignal.timeout(20e3),
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form(params),
  });
  let data: any = null;
  try { data = await r.json(); } catch { /* JSON 아님 */ }
  if (!r.ok) {
    const err = String(data?.error ?? "");
    if (err === "invalid_grant") throw new GoogleCalError("reauth", "invalid_grant", r.status);
    if (err === "invalid_client" || err === "unauthorized_client") throw new GoogleCalError("client", err, r.status);
    throw new GoogleCalError("http", `token HTTP ${r.status}`, r.status);
  }
  if (!data || typeof data.access_token !== "string") throw new GoogleCalError("format", "no access_token");
  addLogSecret(data.access_token);
  if (typeof data.refresh_token === "string") addLogSecret(data.refresh_token);
  return data;
}

// 쓸 수 있는 액세스 토큰(1분 넘게 남았으면 그대로, 아니면 리프레시 토큰으로 새로 받아 파일에 쓴다). 토큰 파일이 없으면 reauth
export async function googleAccessToken(client: GoogleClient, deps: GoogleDeps = {}, force = false): Promise<string> {
  const path = deps.tokenPath ?? googleTokenPath();
  const now = deps.now?.() ?? Date.now();
  const tok = readGoogleToken(path);
  if (!tok) throw new GoogleCalError("reauth", "no token");
  if (!force && tok.accessToken && (tok.expiresAt ?? 0) - 60e3 > now) return tok.accessToken;
  addLogSecret(client.clientSecret);
  const d = await tokenRequest({ grant_type: "refresh_token", refresh_token: tok.refreshToken, client_id: client.clientId, client_secret: client.clientSecret }, deps);
  const next: GoogleToken = {
    ...tok,
    refreshToken: typeof d.refresh_token === "string" && d.refresh_token ? d.refresh_token : tok.refreshToken,
    accessToken: d.access_token,
    expiresAt: now + (Number(d.expires_in) > 0 ? Number(d.expires_in) : 3600) * 1000,
    ...(typeof d.scope === "string" ? { scope: d.scope } : {}),
  };
  writeGoogleToken(next, path);
  return d.access_token;
}

// ── 일정 읽기 ──────────────────────────────────────────────

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const httpUrl = (s: string) => { try { const u = new URL(s); return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined; } catch { return undefined; } };

// { dateTime } → ISO(UTC), { date }(종일) → 캘린더 시간대의 그날 0시
function when(x: any, tz: string): { iso: string; allDay: boolean } | null {
  const dt = str(x?.dateTime);
  if (dt) { const ms = Date.parse(dt); return Number.isNaN(ms) ? null : { iso: new Date(ms).toISOString(), allDay: false }; }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(x?.date));
  if (!m) return null;
  return { iso: new Date(zonedToUtc({ y: +m[1], mo: +m[2], d: +m[3], h: 0, mi: 0, s: 0 }, tz)).toISOString(), allDay: true };
}

const RESPONSE: Record<string, string> = { accepted: "accepted", declined: "declined", tentative: "tentativelyaccepted", needsAction: "notresponded" };

// Google 일정 하나 → CalEvent(제목 summary · 시작 start · 끝 end · 참석자 attendees · 장소 location). 시각이 없으면 null
export function googleEventToCal(it: any, tz: string): CalEvent | null {
  const id = str(it?.id), s = when(it?.start, tz), e = when(it?.end, tz);
  if (!id || !s || !e) return null;
  const people = Array.isArray(it?.attendees) ? it.attendees.filter((a: any) => a && typeof a === "object") : null;
  const me = people?.find((a: any) => a.self === true);
  const response = it?.organizer?.self === true ? "organizer" : me ? RESPONSE[str(me.responseStatus)] ?? "none" : "none";
  const loc = str(it?.location).replace(/\s+/g, " ");
  const video = Array.isArray(it?.conferenceData?.entryPoints) ? it.conferenceData.entryPoints.find((p: any) => p?.entryPointType === "video") : undefined;
  const join = httpUrl(str(it?.hangoutLink)) ?? httpUrl(str(video?.uri)) ?? (/^https?:\/\//i.test(loc) ? httpUrl(loc) : undefined);
  const type = str(it?.eventType);
  const ev: CalEvent = {
    id, subject: str(it?.summary) || t("status.no_title"), start: s.iso, end: e.iso,
    allDay: s.allDay, cancelled: str(it?.status) === "cancelled",
    showAs: type === "outOfOffice" ? "oof" : type === "workingLocation" ? "workingelsewhere" : str(it?.transparency) === "transparent" ? "free" : "busy",
    response, online: !!join,
  };
  if (join) ev.joinUrl = join;
  const web = httpUrl(str(it?.htmlLink));
  if (web) ev.webLink = web;
  if (loc && !/^https?:\/\//i.test(loc)) ev.location = loc;
  if (people) {
    const others = people.filter((a: any) => a.self !== true && a.resource !== true);
    ev.attendees = others.length;
    const names = others.map((a: any) => str(a.displayName) || str(a.email)).filter(Boolean);
    if (names.length) ev.attendeeNames = names;
  }
  const desc = str(it?.description);
  if (desc) ev.description = desc;
  return ev;
}

export type GoogleRead = (client: GoogleClient, w: { from: string; to: string }, opts: { timeZone: string }, deps?: GoogleDeps) => Promise<{ name: string; events: CalEvent[] }>;

// 기간의 기본 캘린더 일정(반복은 회차로 펼쳐 받는다, 페이지 끝까지). 401 이면 토큰을 한 번 새로 받아 다시 묻는다.
// name = 캘린더 이름(기본 캘린더는 보통 Google 계정 이메일)
export const googleEvents: GoogleRead = async (client, w, opts, deps = {}) => {
  const f = deps.fetch ?? fetch;
  let token = await googleAccessToken(client, deps);
  let retried = false;
  const events: CalEvent[] = [];
  let name = "";
  let pageToken = "";
  for (let page = 0; page < 40; page++) {
    const q = new URLSearchParams({ timeMin: new Date(w.from).toISOString(), timeMax: new Date(w.to).toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "250", timeZone: opts.timeZone });
    if (pageToken) q.set("pageToken", pageToken);
    const r = await f(`${GOOGLE_EVENTS_URL}?${q}`, { signal: AbortSignal.timeout(20e3), headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    let data: any = null;
    try { data = await r.json(); } catch { /* JSON 아님 */ }
    if (r.status === 401 && !retried) { retried = true; token = await googleAccessToken(client, deps, true); page--; continue; }
    if (!r.ok) {
      const why = String(data?.error?.errors?.[0]?.reason ?? data?.error?.status ?? "");
      if (r.status === 401) throw new GoogleCalError("reauth", "unauthorized", 401);
      if (r.status === 403 && /accessNotConfigured|SERVICE_DISABLED/i.test(why)) throw new GoogleCalError("api", why, 403);
      if (r.status === 403 && /insufficient|PERMISSION_DENIED/i.test(why)) throw new GoogleCalError("scope", why, 403);
      throw new GoogleCalError("http", `events HTTP ${r.status}`, r.status);
    }
    if (!data || !Array.isArray(data.items)) throw new GoogleCalError("format", "no items");
    name ||= str(data.summary);
    for (const it of data.items) { const ev = googleEventToCal(it, opts.timeZone); if (ev) events.push(ev); }
    pageToken = str(data.nextPageToken);
    if (!pageToken) break;
  }
  return { name, events };
};
