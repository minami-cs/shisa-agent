// Google 캘린더(OAuth, 읽기 전용) 로그인·빼기: 설정 창 「Google 캘린더」 → POST /connectors/calendar/google { clientId, clientSecret? }
//   · GET /connectors/calendar/google(상태) · DELETE /connectors/calendar/google(빼기).
// 로그인: 이 컴퓨터 안(127.0.0.1)에 빈 포트로 잠깐 받는 곳을 열고(http://127.0.0.1:<포트>/oauth2callback) 로그인 주소를 돌려준다(앱이 브라우저로 연다).
// 주소는 범위 calendar.readonly 하나, access_type=offline · prompt=consent(리프레시 토큰을 늘 받게), state · PKCE(S256).
// 브라우저가 코드를 들고 돌아오면 토큰으로 바꾸고, 기본 캘린더를 한 번 읽어 본 뒤 저장한다: 토큰은 google-calendar-token.json(권한 600)에만,
// 클라이언트 ID·시크릿은 config.json 의 connectors.calendar.google, 기본 캘린더는 calendars[] 에 account "g-primary" 로. 못 읽으면 아무것도 저장하지 않는다.
// 시크릿·토큰은 응답·로그에 넣지 않는다. 시크릿을 비워 보내면 저장된 것을 쓴다(같은 클라이언트 ID 일 때만).
import { createServer, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readConfigObject } from "./mail-connect.ts";
import { calendarValue, writeCalendarConnector, type SavedCalendar } from "./calendar-connect.ts";
import {
  GOOGLE_ACCOUNT_ID, GOOGLE_AUTH_URL, GOOGLE_CALENDAR_ID, GOOGLE_EVENTS_URL, GOOGLE_REVOKE_URL, GOOGLE_SCOPE,
  GoogleCalError, googleEvents, googleFailReason, readGoogleToken, removeGoogleToken, tokenRequest, writeGoogleToken,
  type GoogleClient, type GoogleDeps, type GoogleRead,
} from "./calendar-google.ts";
import type { CalendarState } from "./calendar-state.ts";
import { addLogSecret } from "./log.ts";
import { t } from "./i18n.ts";

export const GOOGLE_CALLBACK_PATH = "/oauth2callback";
const WAIT_MS = 5 * 60e3; // 브라우저 로그인을 기다리는 시간

const obj = (x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined);
const b64url = (b: Buffer) => b.toString("base64url");
// 클라이언트 ID 모양: <숫자>-<영숫자>.apps.googleusercontent.com
export const okGoogleClientId = (v: unknown): v is string => typeof v === "string" && v.trim().length <= 200 && /^[\w.-]+\.apps\.googleusercontent\.com$/.test(v.trim());

export type GooglePhase = "off" | "waiting" | "connected" | "expired" | "failed";
export type GoogleStatus = { ok: true; phase: GooglePhase; clientId: string; hasSecret: boolean; reason?: string; code?: string; redirectUri?: string };
export type GoogleStartResult = { ok: true; url: string; redirectUri: string } | { ok: false; status: 400 | 500; error: string };
export type GoogleRemoveResult = { ok: true; removed: number; left: number } | { ok: false; status: 404 | 500; error: string };

export type GoogleOAuthDeps = {
  path: string;                                  // config.json
  tokenPath?: string;                            // 토큰 파일(시험)
  window: () => { from: string; to: string };    // 시험 읽기 기간(동기화와 같은 창)
  timeZone?: () => string;
  state?: () => CalendarState;                   // 동기화 결과(리프레시 토큰이 끝났는지 보려고)
  apply: () => void;                             // 저장한 뒤: 다시 읽어 전체 동기화
  resync?: () => void;                           // 설정이 그대로여도(같은 클라이언트로 다시 로그인) 바로 한 번 가져오기
  fetch?: typeof fetch;
  read?: GoogleRead;                             // 시험 읽기(가짜)
  now?: () => number;
};

type Flow = { server: Server; state: string; verifier: string; redirectUri: string; client: GoogleClient; timer: ReturnType<typeof setTimeout> };

const page = (title: string, body: string) => {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="font-family:system-ui,sans-serif;padding:40px;line-height:1.6"><h2>${esc(title)}</h2><p>${esc(body)}</p></body>`;
};

export class GoogleOAuth {
  private deps: GoogleOAuthDeps;
  private flow?: Flow;
  private last?: { code: string; reason: string };
  private exchanging = false; // 코드를 받아 토큰으로 바꾸고 시험으로 읽는 중(그동안도 「기다리는 중」)
  private okAt = 0;           // 마지막으로 로그인에 성공한 때(그보다 앞선 동기화의 「만료」는 지난 일)
  constructor(deps: GoogleOAuthDeps) { this.deps = deps; }

  private gdeps(): GoogleDeps {
    return { ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}), ...(this.deps.tokenPath ? { tokenPath: this.deps.tokenPath } : {}), ...(this.deps.now ? { now: this.deps.now } : {}) };
  }
  private saved(): { clientId: string; clientSecret: string } {
    try {
      const g = obj(calendarValue(readConfigObject(this.deps.path)).google);
      return { clientId: typeof g?.clientId === "string" ? g.clientId : "", clientSecret: typeof g?.clientSecret === "string" ? g.clientSecret : "" };
    } catch { return { clientId: "", clientSecret: "" }; }
  }
  private hasEntry(): boolean {
    try { return calendarValue(readConfigObject(this.deps.path)).calendars.some((c) => c.account === GOOGLE_ACCOUNT_ID); } catch { return false; }
  }

  // 상태: 로그인 기다리는 중 · 연결됨 · 다시 로그인해야 함(리프레시 토큰 끝남) · 마지막 로그인 실패 · 안 됨. 시크릿·토큰은 없다
  status(): GoogleStatus {
    const s = this.saved();
    const base = { ok: true as const, clientId: s.clientId, hasSecret: !!s.clientSecret };
    if (this.flow || this.exchanging) return { ...base, phase: "waiting", ...(this.flow ? { redirectUri: this.flow.redirectUri } : {}) };
    if (this.last) return { ...base, phase: "failed", ...this.last };
    if (!readGoogleToken(this.deps.tokenPath) || !this.hasEntry()) return { ...base, phase: "off" };
    const st = this.deps.state?.();
    const part = st?.calendars?.find((c) => c.id === GOOGLE_CALENDAR_ID);
    const fresh = !this.okAt || Date.parse(st?.at ?? "") >= this.okAt;
    if (fresh && part?.phase === "failed" && (part.code === "reauth" || part.code === "client")) return { ...base, phase: "expired", code: part.code, reason: part.reason ?? googleFailReason(new GoogleCalError(part.code, part.code)).reason };
    return { ...base, phase: "connected" };
  }

  // 로그인 시작: 받는 곳을 열고 로그인 주소를 돌려준다(앞의 것이 열려 있으면 닫고 새로)
  async start(body: unknown): Promise<GoogleStartResult> {
    const b = obj(body);
    if (!b) return { ok: false, status: 400, error: "json object required" };
    for (const k of Object.keys(b)) if (k !== "clientId" && k !== "clientSecret") return { ok: false, status: 400, error: `unknown key: ${k}` };
    if (!okGoogleClientId(b.clientId)) return { ok: false, status: 400, error: t("status.gcal_check_client_id") };
    if (b.clientSecret !== undefined && (typeof b.clientSecret !== "string" || b.clientSecret.length > 200)) return { ok: false, status: 400, error: t("status.gcal_need_secret") };
    const clientId = b.clientId.trim();
    const s = this.saved();
    const clientSecret = (typeof b.clientSecret === "string" ? b.clientSecret.trim() : "") || (s.clientId === clientId ? s.clientSecret : "");
    if (!clientSecret) return { ok: false, status: 400, error: t("status.gcal_need_secret") };
    addLogSecret(clientSecret);
    this.close();
    this.last = undefined;
    const state = b64url(randomBytes(16));
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const server = createServer((req, res) => { void this.callback(req.url ?? "", res); });
    try {
      await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", () => ok()); });
    } catch (e: any) { return { ok: false, status: 500, error: String(e?.message ?? e) }; }
    const addr = server.address();
    const port = addr && typeof addr === "object" ? addr.port : 0;
    const redirectUri = `http://127.0.0.1:${port}${GOOGLE_CALLBACK_PATH}`;
    const timer = setTimeout(() => { if (this.flow?.state === state) { this.close(); this.last = { code: "timeout", reason: t("status.gcal_login_timeout") }; } }, WAIT_MS);
    timer.unref?.();
    this.flow = { server, state, verifier, redirectUri, client: { clientId, clientSecret }, timer };
    const q = new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: GOOGLE_SCOPE,
      access_type: "offline", prompt: "consent", state, code_challenge: challenge, code_challenge_method: "S256",
    });
    console.log(`[calendar] Google 로그인 기다림(${redirectUri})`); // 클라이언트 시크릿·state 는 남기지 않는다
    return { ok: true, url: `${GOOGLE_AUTH_URL}?${q}`, redirectUri };
  }

  private close() {
    const f = this.flow;
    if (!f) return;
    this.flow = undefined;
    clearTimeout(f.timer);
    f.server.close(); // 새 연결은 안 받는다. 지금 답하는 요청(끝 화면)은 끝까지 보낸다
    f.server.closeIdleConnections?.();
  }

  private fail(code: string, reason: string) {
    this.close();
    this.last = { code, reason };
    console.log(`[calendar] Google 로그인 실패(${code})`);
  }

  // 브라우저가 돌아온 곳: state 확인 → 코드를 토큰으로 → 시험 읽기 → 저장 → 끝 화면
  private async callback(raw: string, res: import("node:http").ServerResponse) {
    const send = (st: number, title: string, body: string) => { res.writeHead(st, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", connection: "close" }); res.end(page(title, body)); };
    const f = this.flow;
    let u: URL;
    try { u = new URL(raw, "http://127.0.0.1"); } catch { return send(400, "Bad request", ""); }
    if (!f || u.pathname !== GOOGLE_CALLBACK_PATH) return send(404, "Not found", "");
    if (u.searchParams.get("state") !== f.state) return send(400, t("status.gcal_page_fail"), t("status.gcal_bad_state")); // 다른 곳에서 온 요청: 계속 기다린다
    const err = u.searchParams.get("error");
    const code = u.searchParams.get("code");
    if (err || !code) {
      const r = err === "access_denied" ? { code: "denied", reason: t("status.gcal_denied") } : { code: "other", reason: t("status.ics_other", { msg: String(err ?? "no code").slice(0, 60) }) };
      this.fail(r.code, r.reason);
      return send(200, t("status.gcal_page_fail"), r.reason);
    }
    this.close(); // 한 번만 받는다
    this.exchanging = true;
    try {
      const d = await tokenRequest({ grant_type: "authorization_code", code, client_id: f.client.clientId, client_secret: f.client.clientSecret, redirect_uri: f.redirectUri, code_verifier: f.verifier }, this.gdeps());
      const scopes = String(d.scope ?? "").split(/\s+/);
      if (!scopes.includes(GOOGLE_SCOPE)) throw new GoogleCalError("scope", "scope not granted");
      if (typeof d.refresh_token !== "string" || !d.refresh_token) throw new GoogleCalError("format", "no refresh_token");
      const now = this.deps.now?.() ?? Date.now();
      const prev = readGoogleToken(this.deps.tokenPath); // 다시 로그인하다 실패하면 되돌린다(잘 되던 연결을 잃지 않게)
      writeGoogleToken({ refreshToken: d.refresh_token, accessToken: d.access_token, expiresAt: now + (Number(d.expires_in) > 0 ? Number(d.expires_in) : 3600) * 1000, scope: GOOGLE_SCOPE }, this.deps.tokenPath);
      let got: { name: string; events: unknown[] };
      try { got = await (this.deps.read ?? googleEvents)(f.client, this.deps.window(), { timeZone: this.deps.timeZone?.() ?? "Asia/Seoul" }, this.gdeps()); }
      catch (e) { if (prev) writeGoogleToken(prev, this.deps.tokenPath); else removeGoogleToken(this.deps.tokenPath); throw e; }
      this.save(f.client, got.name);
      this.okAt = Date.now();
      console.log(`[calendar] Google 캘린더 연결함(일정 ${got.events.length}개)`);
      this.deps.apply();
      this.deps.resync?.();
      return send(200, t("status.gcal_page_ok"), t("status.gcal_page_ok_body"));
    } catch (e: any) {
      const r = googleFailReason(e);
      this.fail(r.code, r.reason);
      return send(200, t("status.gcal_page_fail"), r.reason);
    } finally { this.exchanging = false; }
  }

  // 클라이언트 + 기본 캘린더 줄을 저장(있던 줄은 켜짐·별칭·색 그대로)
  private save(client: GoogleClient, calName: string) {
    const v = calendarValue(readConfigObject(this.deps.path));
    const old = v.calendars.find((c) => c.account === GOOGLE_ACCOUNT_ID);
    const entry: SavedCalendar = old ? { ...old, url: GOOGLE_EVENTS_URL } : { id: GOOGLE_CALENDAR_ID, name: calName.replace(/\s+/g, " ").trim().slice(0, 80), url: GOOGLE_EVENTS_URL, enabled: true, account: GOOGLE_ACCOUNT_ID };
    const calendars = old ? v.calendars.map((c) => (c === old ? entry : c)) : [...v.calendars, entry];
    writeCalendarConnector(this.deps.path, {
      mode: "api", calendars,
      timeZone: typeof v.timeZone === "string" && v.timeZone.trim() ? v.timeZone : "Asia/Seoul",
      ...(v.email !== undefined ? { email: v.email } : {}),
      ...(v.caldav ? { caldav: v.caldav } : {}),
      google: { clientId: client.clientId, clientSecret: client.clientSecret },
    });
  }

  // 빼기: 토큰 파일과 Google 캘린더 줄을 지운다(Google 에도 토큰 취소를 한 번 보낸다, 실패해도 상관없음). 클라이언트 ID·시크릿은 남긴다.
  // 남은 캘린더가 없으면 캘린더 연결이 꺼진다({ mode: "off" })
  remove(): GoogleRemoveResult {
    this.close();
    this.last = undefined;
    try {
      const tok = readGoogleToken(this.deps.tokenPath);
      const v = calendarValue(readConfigObject(this.deps.path));
      const calendars = v.calendars.filter((c) => c.account !== GOOGLE_ACCOUNT_ID);
      const removed = v.calendars.length - calendars.length;
      if (!tok && !removed) return { ok: false, status: 404, error: t("status.gcal_not_connected") };
      if (tok) { this.revoke(tok.refreshToken); removeGoogleToken(this.deps.tokenPath); }
      if (removed) {
        writeCalendarConnector(this.deps.path, calendars.length
          ? { mode: "api", calendars, timeZone: typeof v.timeZone === "string" && v.timeZone.trim() ? v.timeZone : "Asia/Seoul", ...(v.email !== undefined ? { email: v.email } : {}), ...(v.caldav ? { caldav: v.caldav } : {}), ...(v.google ? { google: v.google } : {}) }
          : { mode: "off" });
      }
      console.log(`[calendar] Google 캘린더 뺌(남은 캘린더 ${calendars.length}개)`);
      this.deps.apply();
      return { ok: true, removed, left: calendars.length };
    } catch (e: any) { return { ok: false, status: 500, error: String(e?.message ?? e) }; }
  }

  // Google 에 토큰 취소를 한 번 보낸다(실패해도 상관없음)
  private revoke(token: string) {
    (this.deps.fetch ?? fetch)(GOOGLE_REVOKE_URL, { method: "POST", signal: AbortSignal.timeout(10e3), headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }).toString() }).catch(() => {});
  }

  // 설정에 Google 캘린더 줄이 없는데 토큰만 남았으면(캘린더 목록에서 그 줄만 뺐거나, 데몬이 꺼진 사이 연결 해제) 토큰을 지우고 취소한다.
  // 로그인 중이거나 설정 파일을 못 읽으면 건드리지 않는다
  prune(): boolean {
    if (this.flow || this.exchanging) return false;
    let has: boolean;
    try { has = calendarValue(readConfigObject(this.deps.path)).calendars.some((c) => c.account === GOOGLE_ACCOUNT_ID); } catch { return false; }
    const tok = has ? null : readGoogleToken(this.deps.tokenPath);
    if (!tok) return false;
    this.revoke(tok.refreshToken);
    removeGoogleToken(this.deps.tokenPath);
    console.log("[calendar] Google 캘린더 줄이 없어 토큰을 지움");
    return true;
  }

  // 데몬을 끌 때
  stop() { this.close(); }
}
