// 설정 창 Google 캘린더(OAuth) 칸: 연결되면 입력칸을 접고(「클라이언트 바꾸기」로 펼친다) · 클라이언트 ID 검사로 [Google 로그인] 막기 ·
// 기다리는 동안 [취소] · [Google Cloud 콘솔 열기]
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, fakeCy } from './fake-dom.js';

const ROWS = [{ id: 'connector:calendar', group: 'service', label: '캘린더', state: 'ok', check: 'services', detail: 'ICS 1개 · Google 1개' }];

async function open(status, over = {}) {
  const cy = fakeCy({
    getSettings: { ok: false }, getConnections: { ok: true, data: { rows: ROWS } },
    getCalendars: { ok: true, items: [{ id: '0123456789abcdef', kind: 'gcal', label: 'Google 로그인', name: '회사', named: true, enabled: true, account: 'g-primary' }] },
    googleCalendarStatus: () => Promise.resolve({ ok: true, data: status() }),
    ...over,
  });
  const page = await loadPage('settings', { cy });
  page.window._ev = new Map();
  await page.settle();
  return page;
}
const box = (page) => page.$('.gcal-oauth');
const btn = (page, text) => box(page).querySelectorAll('button').find((b) => b.textContent === text);

test('연결됨: 입력칸을 접고 「연결됨: 회사」 · [다시 로그인]·[연결 끊기] · 「클라이언트 바꾸기」를 누르면 펼친다', async () => {
  const page = await open(() => ({ phase: 'connected', clientId: '1-a.apps.googleusercontent.com', hasSecret: true }));
  assert.equal(box(page).querySelector('.gcal-client-id'), null);
  assert.equal(box(page).querySelector('.gcal-state').textContent, '연결됨: 회사');
  assert.ok(btn(page, '다시 로그인') && !btn(page, '다시 로그인').disabled);
  assert.ok(btn(page, '연결 끊기'));
  page.click(box(page).querySelector('.gcal-edit-client'));
  await page.settle();
  assert.equal(box(page).querySelector('.gcal-client-id').value, '1-a.apps.googleusercontent.com');
  assert.equal(box(page).querySelector('.gcal-edit-client'), null);
});

test('연결 안 됨: 입력칸이 펼쳐져 있고, 클라이언트 ID 가 비었거나 모양이 틀리면 [Google 로그인]을 못 누른다(힌트 회색 → 빨강)', async () => {
  const page = await open(() => ({ phase: 'off', clientId: '', hasSecret: false }));
  const id = box(page).querySelector('.gcal-client-id');
  const hint = box(page).querySelector('.gcal-id-hint');
  const login = btn(page, 'Google 로그인');
  assert.equal(login.disabled, true);
  assert.match(hint.textContent, /넣어 주세요/);
  assert.equal(hint.classList.contains('error'), false);
  id.value = 'abc.example.com';
  id.dispatchEvent(new page.window.Event('input'));
  assert.equal(login.disabled, true);
  assert.match(hint.textContent, /끝나야/);
  assert.equal(hint.classList.contains('error'), true);
  id.value = ' 1-a.apps.googleusercontent.com ';
  id.dispatchEvent(new page.window.Event('input'));
  assert.equal(login.disabled, false);
  assert.equal(hint.style.display, 'none');
  // 안내는 한 줄 + [Google Cloud 콘솔 열기](메인이 정해 둔 주소로 연다)
  page.click(box(page).querySelector('.gcal-console'));
  assert.deepEqual(page.cy.__calls.filter(([k]) => k === 'openSource'), [['openSource', ['gcloud']]]);
});

test('기다리는 중: [취소]를 누르면 데몬에 취소를 보내고, 기다리기 전 상태로 돌아간다(「연결했어요」라고 하지 않는다)', async () => {
  let phase = 'waiting';
  const page = await open(() => ({ phase, clientId: '1-a.apps.googleusercontent.com', hasSecret: true }), {
    googleCalendarCancel: () => { phase = 'off'; return Promise.resolve({ ok: true }); },
  });
  assert.match(box(page).querySelector('.gcal-state').textContent, /기다리는 중/);
  page.click(btn(page, '취소'));
  await page.settle();
  assert.ok(page.cy.__calls.some(([k]) => k === 'googleCalendarCancel'));
  assert.equal(btn(page, '취소'), undefined);
  assert.equal(box(page).querySelector('.gcal-state').textContent, '아직 연결하지 않았어요.');
  assert.equal(box(page).querySelector('.setup-gate'), null);
});
