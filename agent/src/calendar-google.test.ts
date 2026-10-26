// Google 캘린더(OAuth, 읽기 전용): 일정 모양 바꾸기 · 액세스 토큰 새로 받기·리프레시 만료(reauth) · icsSource 가 Google 줄을 읽기 ·
// 로그인(루프백 · state · PKCE · offline/consent) → 토큰 파일(600)·설정 저장 · 빼기 · 다른 캘린더 저장이 google 클라이언트를 지우지 않기
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GOOGLE_ACCOUNT_ID, GOOGLE_CALENDAR_ID, GOOGLE_EVENTS_URL, GOOGLE_SCOPE, GoogleCalError, googleEventToCal, googleEvents, readGoogleToken, writeGoogleToken } from "./calendar-google.ts";
import { GoogleOAuth, okGoogleClientId } from "./calendar-google-connect.ts";
import { icsSource } from "./calendar-sync.ts";
import { addCalendar } from "./calendar-connect.ts";
import { connectorStatus, resolveConnectors, type CalendarApiConn } from "./connectors.ts";
import { redactLog } from "./log.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "gcal-"));
const W = { from: "2026-10-26T00:00:00+09:00", to: "2026-10-28T00:00:00+09:00" };
const CLIENT = { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-secret-value" };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("googleEventToCal: summary·start·end·attendees·location → CalEvent, 종일은 그 시간대 0시, 나·회의실은 참석자에서 뺀다", () => {
  const ev = googleEventToCal({
    id: "e1", summary: "주간 회의", status: "confirmed", htmlLink: "https://www.google.com/calendar/event?eid=x",
    start: { dateTime: "2026-10-26T14:00:00+09:00" }, end: { dateTime: "2026-10-26T15:00:00+09:00" },
    location: "본사 3층 회의실", hangoutLink: "https://meet.google.com/abc-defg-hij", description: "안건",
    attendees: [{ email: "me@gmail.com", self: true, responseStatus: "accepted" }, { email: "kim@example.com", displayName: "Kim" }, { email: "room@resource.calendar.google.com", resource: true }],
  }, "Asia/Seoul")!;
  assert.equal(ev.subject, "주간 회의");
  assert.equal(ev.start, "2026-10-26T05:00:00.000Z");
  assert.equal(ev.end, "2026-10-26T06:00:00.000Z");
  assert.equal(ev.location, "본사 3층 회의실");
  assert.equal(ev.joinUrl, "https://meet.google.com/abc-defg-hij");
  assert.equal(ev.online, true);
  assert.equal(ev.response, "accepted");
  assert.equal(ev.attendees, 1);
  assert.deepEqual(ev.attendeeNames, ["Kim"]);
  assert.equal(ev.description, "안건");
  const day = googleEventToCal({ id: "d", summary: "휴가", start: { date: "2026-10-27" }, end: { date: "2026-10-28" }, transparency: "transparent" }, "Asia/Seoul")!;
  assert.equal(day.allDay, true);
  assert.equal(day.start, "2026-10-26T15:00:00.000Z");
  assert.equal(day.showAs, "free");
  assert.equal(day.attendees, undefined);
  const no = googleEventToCal({ id: "x", summary: "", status: "cancelled", start: { dateTime: "2026-10-26T10:00:00Z" }, end: { dateTime: "2026-10-26T11:00:00Z" }, organizer: { self: true }, attendees: [{ email: "a@b.c", responseStatus: "declined" }] }, "Asia/Seoul")!;
  assert.equal(no.cancelled, true);
  assert.equal(no.response, "organizer");
  assert.equal(googleEventToCal({ id: "y", start: {} }, "Asia/Seoul"), null);
});

test("googleEvents: 액세스 토큰이 끝났으면 리프레시로 새로 받아 파일에 쓰고, 페이지 끝까지 읽는다. 리프레시가 끝났으면 reauth", async () => {
  const dir = tmp();
  const tokenPath = join(dir, "tok.json");
  writeGoogleToken({ refreshToken: "1//refresh-token-abc", accessToken: "old-access", expiresAt: 0 }, tokenPath);
  const calls: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push(String(url).split("?")[0]);
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) {
      const b = new URLSearchParams(String(init?.body));
      assert.equal(b.get("grant_type"), "refresh_token");
      assert.equal(b.get("refresh_token"), "1//refresh-token-abc");
      return json(200, { access_token: "new-access", expires_in: 3600, scope: GOOGLE_SCOPE });
    }
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer new-access");
    const q = new URL(String(url)).searchParams;
    assert.equal(q.get("singleEvents"), "true");
    if (!q.get("pageToken")) return json(200, { summary: "me@gmail.com", items: [{ id: "a", summary: "A", start: { dateTime: "2026-10-26T10:00:00+09:00" }, end: { dateTime: "2026-10-26T11:00:00+09:00" } }], nextPageToken: "p2" });
    return json(200, { items: [{ id: "b", summary: "B", start: { dateTime: "2026-10-27T10:00:00+09:00" }, end: { dateTime: "2026-10-27T11:00:00+09:00" } }] });
  }) as typeof fetch;
  const r = await googleEvents(CLIENT, W, { timeZone: "Asia/Seoul" }, { fetch: f, tokenPath, now: () => 1000 });
  assert.equal(r.name, "me@gmail.com");
  assert.deepEqual(r.events.map((e) => e.id), ["a", "b"]);
  assert.deepEqual(calls, ["https://oauth2.googleapis.com/token", GOOGLE_EVENTS_URL, GOOGLE_EVENTS_URL]);
  assert.equal(readGoogleToken(tokenPath)?.accessToken, "new-access");
  assert.equal(readGoogleToken(tokenPath)?.refreshToken, "1//refresh-token-abc");
  assert.equal(statSync(tokenPath).mode & 0o777, 0o600);
  // 토큰·시크릿은 로그에 나오지 않는다
  assert.doesNotMatch(redactLog("refresh 1//refresh-token-abc access new-access secret GOCSPX-secret-value"), /refresh-token-abc|new-access|GOCSPX-secret-value/);

  // 리프레시 토큰이 끝남(테스트 모드 7일) → reauth
  writeGoogleToken({ refreshToken: "1//expired", expiresAt: 0 }, tokenPath);
  const dead = (async () => json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." })) as unknown as typeof fetch;
  await assert.rejects(googleEvents(CLIENT, W, { timeZone: "Asia/Seoul" }, { fetch: dead, tokenPath }), (e: any) => e.code === "reauth");
  // 토큰 파일이 없으면 reauth
  await assert.rejects(googleEvents(CLIENT, W, { timeZone: "Asia/Seoul" }, { fetch: dead, tokenPath: join(dir, "none.json") }), (e: any) => e.code === "reauth");
});

test("icsSource: Google 줄(account g-primary)은 일정 API 로 읽고(ICS 로 받지 않는다), 실패하면 그 캘린더만 다시 로그인 안내", async () => {
  const list = [{ id: GOOGLE_CALENDAR_ID, name: "", url: GOOGLE_EVENTS_URL, enabled: true, account: GOOGLE_ACCOUNT_ID }];
  const noIcs = async () => { throw new Error("ICS 로 받으면 안 된다"); };
  const ok = icsSource(list, { timeZone: "Asia/Seoul", google: CLIENT }, noIcs, undefined, async (c, w) => {
    assert.equal(c.clientId, CLIENT.clientId);
    assert.equal(w.from, W.from);
    return { name: "me@gmail.com", events: [googleEventToCal({ id: "a", summary: "A", start: { dateTime: "2026-10-26T10:00:00+09:00" }, end: { dateTime: "2026-10-26T11:00:00+09:00" }, attendees: [{ email: "k@x.com" }] }, "Asia/Seoul")!] };
  });
  const r = await ok({} as never, W);
  assert.equal(r.ok, true);
  assert.equal(r.events[0].calId, GOOGLE_CALENDAR_ID);
  assert.equal(r.events[0].calendar, "me@gmail.com");
  assert.equal(r.parts?.[0].events, 1);
  const bad = icsSource(list, { timeZone: "Asia/Seoul", google: CLIENT }, noIcs, undefined, async () => { throw new GoogleCalError("reauth", "invalid_grant"); });
  const b = await bad({} as never, W);
  assert.equal(b.ok, false);
  assert.equal(b.code, "reauth");
  assert.match(b.reason ?? "", /Google 로그인이 만료/);
  // 클라이언트(ID·시크릿)가 설정에 없으면 그 캘린더만 실패
  const none = await icsSource(list, { timeZone: "Asia/Seoul" }, noIcs)({} as never, W);
  assert.equal(none.parts?.[0].code, "client");
});

test("설정: connectors.calendar.google 을 읽고, 연결 카드에서 Google 줄은 네이버로 세지 않는다", () => {
  const c = resolveConnectors({}, { connectors: { calendar: { mode: "api", calendars: [{ url: GOOGLE_EVENTS_URL, account: GOOGLE_ACCOUNT_ID }], google: CLIENT } } }).calendar as CalendarApiConn;
  assert.deepEqual(c.google, CLIENT);
  assert.equal(c.calendars[0].id, GOOGLE_CALENDAR_ID);
  const st = connectorStatus({ ...resolveConnectors({}, {}), calendar: c }, () => false).find((x) => x.cap === "calendar")!;
  assert.doesNotMatch(st.detail, /네이버/);
  const half = resolveConnectors({}, { connectors: { calendar: { mode: "api", google: { clientId: CLIENT.clientId } } } }).calendar as CalendarApiConn;
  assert.equal(half.google, undefined); // 시크릿이 없으면 클라이언트 없음
});

test("다른 캘린더를 더해도(POST /connectors/calendar) google 클라이언트는 그대로 남는다", async () => {
  const dir = tmp();
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ connectors: { calendar: { mode: "api", calendars: [{ id: GOOGLE_CALENDAR_ID, name: "", url: GOOGLE_EVENTS_URL, enabled: true, account: GOOGLE_ACCOUNT_ID }], google: CLIENT } } }));
  const r = await addCalendar({ url: "https://cal.example.com/feed/x1" }, { path, probe: async () => ({ ok: true, calName: "X", events: 0 }), apply: () => {} });
  assert.equal(r.ok, true);
  const saved = JSON.parse(readFileSync(path, "utf8")).connectors.calendar;
  assert.deepEqual(saved.google, CLIENT);
  assert.equal(saved.calendars.length, 2);
});

test("GoogleOAuth: 로그인 주소(범위 하나 · offline · consent · PKCE · 루프백) → 브라우저가 코드를 들고 오면 토큰 파일(600)·설정 저장 → 빼기", async () => {
  const dir = tmp();
  const path = join(dir, "config.json");
  const tokenPath = join(dir, "google-calendar-token.json");
  writeFileSync(path, JSON.stringify({ port: 1, connectors: { calendar: { mode: "off" } } }));
  let applied = 0;
  let exchanged: URLSearchParams | undefined;
  let revoked = "";
  const f = (async (url: string, init?: RequestInit) => {
    if (String(url) === "https://oauth2.googleapis.com/token") { exchanged = new URLSearchParams(String(init?.body)); return json(200, { access_token: "acc-1", refresh_token: "1//ref-1", expires_in: 3599, scope: GOOGLE_SCOPE, token_type: "Bearer" }); }
    if (String(url) === "https://oauth2.googleapis.com/revoke") { revoked = new URLSearchParams(String(init?.body)).get("token") ?? ""; return json(200, {}); }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  const g = new GoogleOAuth({ path, tokenPath, window: () => W, apply: () => { applied++; }, fetch: f, read: async () => ({ name: "me@gmail.com", events: [] }) });

  assert.equal(g.status().phase, "off");
  assert.equal((await g.start({ clientId: "nope" })).ok, false);
  assert.equal((await g.start({ clientId: CLIENT.clientId })).ok, false); // 시크릿 없음(저장된 것도 없음)
  assert.equal((await g.start({ clientId: CLIENT.clientId, clientSecret: "x", extra: 1 })).ok, false);
  const s = await g.start(CLIENT);
  assert.ok(s.ok);
  if (!s.ok) return;
  const u = new URL(s.url);
  assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(u.searchParams.get("scope"), GOOGLE_SCOPE);
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.equal(u.searchParams.get("prompt"), "consent");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.match(s.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/);
  assert.equal(u.searchParams.get("redirect_uri"), s.redirectUri);
  assert.doesNotMatch(JSON.stringify(s), /GOCSPX/);
  assert.equal(g.status().phase, "waiting");

  // state 가 다르면 받지 않고 계속 기다린다
  const wrong = await fetch(`${s.redirectUri}?state=bad&code=c`);
  assert.equal(wrong.status, 400);
  assert.equal(g.status().phase, "waiting");

  const done = await fetch(`${s.redirectUri}?state=${u.searchParams.get("state")}&code=auth-code-1`);
  assert.equal(done.status, 200);
  assert.match(await done.text(), /연결했어요/);
  assert.equal(exchanged?.get("grant_type"), "authorization_code");
  assert.equal(exchanged?.get("code"), "auth-code-1");
  assert.equal(exchanged?.get("redirect_uri"), s.redirectUri);
  assert.equal(exchanged?.get("client_secret"), CLIENT.clientSecret);
  assert.ok((exchanged?.get("code_verifier") ?? "").length >= 43);
  assert.equal(applied, 1);
  assert.equal(statSync(tokenPath).mode & 0o777, 0o600);
  assert.equal(readGoogleToken(tokenPath)?.refreshToken, "1//ref-1");
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(cfg.port, 1);
  assert.equal(cfg.connectors.calendar.mode, "api");
  assert.deepEqual(cfg.connectors.calendar.google, CLIENT);
  assert.deepEqual(cfg.connectors.calendar.calendars, [{ id: GOOGLE_CALENDAR_ID, name: "me@gmail.com", url: GOOGLE_EVENTS_URL, enabled: true, account: GOOGLE_ACCOUNT_ID }]);
  assert.doesNotMatch(JSON.stringify(cfg), /ref-1|acc-1/); // 토큰은 설정 파일에 없다
  const st = g.status();
  assert.equal(st.phase, "connected");
  assert.equal(st.hasSecret, true);
  assert.doesNotMatch(JSON.stringify(st), /GOCSPX|ref-1|acc-1/);
  // 동기화가 리프레시 만료를 봤으면 「다시 로그인」
  const g2 = new GoogleOAuth({ path, tokenPath, window: () => W, apply: () => {}, state: () => ({ phase: "failed", calendars: [{ id: GOOGLE_CALENDAR_ID, name: "me", phase: "failed", code: "reauth", reason: "만료" }] }) });
  assert.equal(g2.status().phase, "expired");
  // 저장된 시크릿으로 다시 로그인(같은 클라이언트 ID)
  const again = await g.start({ clientId: CLIENT.clientId, clientSecret: "" });
  assert.ok(again.ok);
  g.stop();
  assert.equal(g.status().phase, "connected");

  const rm = g.remove();
  assert.ok(rm.ok);
  assert.equal(revoked, "1//ref-1");
  assert.equal(existsSync(tokenPath), false);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).connectors.calendar.mode, "off");
  assert.equal(g.status().phase, "off");
  assert.equal(g.remove().ok, false);
});

test("GoogleOAuth: 사용자가 거절하거나 시험 읽기가 실패하면 아무것도 저장하지 않는다", async () => {
  const dir = tmp();
  const path = join(dir, "config.json");
  const tokenPath = join(dir, "tok.json");
  writeFileSync(path, JSON.stringify({ connectors: { calendar: { mode: "off" } } }));
  const f = (async () => json(200, { access_token: "a", refresh_token: "r-xyz", expires_in: 3600, scope: GOOGLE_SCOPE })) as unknown as typeof fetch;
  const g = new GoogleOAuth({ path, tokenPath, window: () => W, apply: () => assert.fail("저장하면 안 된다"), fetch: f, read: async () => { throw new GoogleCalError("api", "accessNotConfigured", 403); } });
  let s = await g.start(CLIENT);
  assert.ok(s.ok);
  if (!s.ok) return;
  let state = new URL(s.url).searchParams.get("state");
  await fetch(`${s.redirectUri}?state=${state}&error=access_denied`);
  assert.equal(g.status().phase, "failed");
  assert.equal(g.status().code, "denied");
  s = await g.start(CLIENT);
  assert.ok(s.ok);
  if (!s.ok) return;
  state = new URL(s.url).searchParams.get("state");
  const r = await fetch(`${s.redirectUri}?state=${state}&code=c`);
  assert.match(await r.text(), /Calendar API/);
  assert.equal(g.status().code, "api");
  assert.equal(existsSync(tokenPath), false);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).connectors.calendar.mode, "off");
});

test("okGoogleClientId: …apps.googleusercontent.com 만", () => {
  assert.equal(okGoogleClientId(CLIENT.clientId), true);
  assert.equal(okGoogleClientId(" 123-abc.apps.googleusercontent.com "), true);
  assert.equal(okGoogleClientId("abc.example.com"), false);
  assert.equal(okGoogleClientId(""), false);
});

test("CalendarView(캘린더 탭 · calendar_events 가 읽는 길): Google 줄의 일정이 제목·장소·회의 링크와 함께 나온다", async () => {
  const { CalendarView } = await import("./calendar-view.ts");
  const conn = resolveConnectors({}, { connectors: { calendar: { mode: "api", calendars: [{ name: "회사", url: GOOGLE_EVENTS_URL, account: GOOGLE_ACCOUNT_ID }], google: CLIENT } } }).calendar;
  const view = new CalendarView({
    conn: () => conn, configPath: join(tmp(), "none.json"), state: () => ({ phase: "ok" }), meetings: () => [],
    fetchText: async () => { throw new Error("ICS 로 받으면 안 된다"); },
    google: async () => ({ name: "me@gmail.com", events: [googleEventToCal({ id: "a", summary: "고객 미팅", location: "강남", hangoutLink: "https://meet.google.com/x", start: { dateTime: "2026-10-26T10:00:00+09:00" }, end: { dateTime: "2026-10-26T11:00:00+09:00" } }, "Asia/Seoul")!] }),
  });
  const r = await view.events({ from: "2026-10-26T00:00:00+09:00", to: "2026-10-27T00:00:00+09:00" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.calendars.map((c) => c.name), ["회사"]);
  assert.equal(r.events[0].title, "고객 미팅");
  assert.equal(r.events[0].location, "강남");
  assert.equal(r.events[0].joinUrl, "https://meet.google.com/x");
});

test("GoogleOAuth: 다시 로그인이 실패하면 예전 토큰을 되돌리고, 성공하면 예전 「만료」 대신 연결됨 + 바로 한 번 가져온다 · 줄만 빠지면 토큰도 지운다", async () => {
  const dir = tmp();
  const path = join(dir, "config.json");
  const tokenPath = join(dir, "tok.json");
  writeFileSync(path, JSON.stringify({ connectors: { calendar: { mode: "api", calendars: [{ id: GOOGLE_CALENDAR_ID, name: "me", url: GOOGLE_EVENTS_URL, enabled: true, account: GOOGLE_ACCOUNT_ID }], google: CLIENT } } }));
  writeGoogleToken({ refreshToken: "1//old-working" }, tokenPath);
  let readFails = true, resynced = 0;
  const revoked: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/revoke")) { revoked.push(new URLSearchParams(String(init?.body)).get("token") ?? ""); return json(200, {}); }
    return json(200, { access_token: "a2", refresh_token: "1//new", expires_in: 3600, scope: GOOGLE_SCOPE });
  }) as typeof fetch;
  const oldState = { phase: "failed" as const, at: new Date(Date.now() - 60e3).toISOString(), calendars: [{ id: GOOGLE_CALENDAR_ID, name: "me", phase: "failed" as const, code: "reauth", reason: "만료" }] };
  const g = new GoogleOAuth({ path, tokenPath, window: () => W, apply: () => {}, resync: () => { resynced++; }, state: () => oldState, fetch: f, read: async () => { if (readFails) throw new GoogleCalError("http", "x", 503); return { name: "me", events: [] }; } });
  assert.equal(g.status().phase, "expired");
  const login = async () => {
    const s = await g.start({ clientId: CLIENT.clientId });
    assert.ok(s.ok);
    if (!s.ok) return;
    await (await fetch(`${s.redirectUri}?state=${new URL(s.url).searchParams.get("state")}&code=c`)).text();
  };
  await login();
  assert.equal(readGoogleToken(tokenPath)?.refreshToken, "1//old-working", "실패하면 예전 토큰 그대로");
  assert.equal(resynced, 0);
  readFails = false;
  await login();
  assert.equal(readGoogleToken(tokenPath)?.refreshToken, "1//new");
  assert.equal(resynced, 1);
  assert.equal(g.status().phase, "connected", "로그인 전의 동기화 결과(만료)는 지난 일");

  // 캘린더 목록에서 Google 줄만 뺐다(데스크톱이 설정 파일을 고침) → prune 이 토큰을 지우고 취소
  assert.equal(g.prune(), false, "줄이 있으면 그대로");
  writeFileSync(path, JSON.stringify({ connectors: { calendar: { mode: "api", calendars: [{ url: "https://cal.example.com/x" }], google: CLIENT } } }));
  assert.equal(g.prune(), true);
  assert.equal(existsSync(tokenPath), false);
  assert.deepEqual(revoked, ["1//new"]);
  // 설정 파일이 깨졌으면 건드리지 않는다
  writeGoogleToken({ refreshToken: "1//keep" }, tokenPath);
  writeFileSync(path, "{ broken");
  assert.equal(g.prune(), false);
  assert.equal(readGoogleToken(tokenPath)?.refreshToken, "1//keep");
});
