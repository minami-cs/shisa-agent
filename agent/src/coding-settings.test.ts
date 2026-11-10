// 실제 데스크톱 IPC 검증과 데몬 설정 저장을 함께 통과해야 코드 작업 AI가 바뀐다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error 데스크톱의 JS 모듈에는 타입 선언이 없다. 실제 IPC 경계를 함께 검증한다.
import { setupSettings } from '../../desktop/src/settings-window.js';
import { Settings, type SettingsView } from './settings.ts';
import { loadConfig } from './config.ts';
import { codingChoice } from './coding.ts';

test('코드 작업 설정: IPC → 데몬 → 파일 → 재시작 후 실행기·모델까지 Codex로 유지한다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cy-coding-ipc-'));
  try {
    const path = join(dir, 'config.json');
    const cfg = loadConfig({}, { brain: { provider: 'claude-code' } });
    const avail = { claude: true, codex: true };
    const daemon = new Settings(cfg, { path, env: {}, coders: () => avail });
    type Event = { sender: object };
    const handlers: Record<string, (event: Event, body?: unknown) => Promise<unknown>> = {};
    const fakeWin = {
      webContents: { setWindowOpenHandler() {}, on() {} },
      loadFile() {}, once() {}, on() {}, show() {}, focus() {}, isDestroyed: () => false,
    };
    class BrowserWindow { constructor() { return fakeWin; } }
    const ui = setupSettings({
      BrowserWindow,
      ipcMain: { handle: (name: string, fn: (event: Event, body?: unknown) => Promise<unknown>) => { handlers[name] = fn; }, on() {} },
      preload: 'preload', html: 'settings',
      request: async (method: string, route: string, body?: unknown) => {
        assert.equal(route, '/settings');
        if (method === 'GET') return { ok: true, data: daemon.view() };
        assert.equal(method, 'PUT');
        const data = daemon.put(body);
        return { ok: data.ok, data };
      },
    });
    ui.show();
    const event = { sender: fakeWin.webContents };
    const put = async (body: unknown) => {
      const response = await handlers['settings-put'](event, body) as { ok: boolean; data: ReturnType<Settings['put']> };
      assert.equal(response.ok, true);
      if (!response.data.ok) throw new Error(response.data.error);
      return response.data;
    };
    const codeSlot = (view: SettingsView) => view.modelSlots.roles.find((r) => r.role === 'code')!;

    const selected = await put({ coding: { provider: 'codex' } });
    assert.equal(selected.ok, true);
    assert.equal(codeSlot(selected.settings).coder!.provider, 'codex');
    const modeled = await put({ brainModels: { provider: 'codex', models: { code: 'gpt-5.4' } } });
    assert.equal(modeled.ok, true);
    assert.equal(codeSlot(modeled.settings).value, 'gpt-5.4');
    assert.deepEqual(codingChoice(cfg, undefined, avail), { provider: 'codex', model: 'gpt-5.4' });

    const reload = () => loadConfig({}, JSON.parse(readFileSync(path, 'utf8')));
    assert.deepEqual(codingChoice(reload(), undefined, avail), { provider: 'codex', model: 'gpt-5.4' });
    assert.equal(reload().brain.provider, 'claude-code', '대화 AI와 코드 작업 AI를 따로 유지한다');
    assert.deepEqual(codingChoice(reload(), undefined, { claude: true, codex: false }), { provider: 'codex', model: 'gpt-5.4' }, '연결이 끊겨도 Claude Code로 바꾸지 않는다');

    assert.equal((await put({ brainModels: { provider: 'codex', models: { code: null } } })).ok, true);
    assert.deepEqual(codingChoice(reload(), undefined, avail), { provider: 'codex' }, '기본 모델 복원도 재시작 후 유지한다');
    assert.equal((await put({ coding: { provider: 'claude-code' } })).ok, true);
    assert.equal(codingChoice(reload(), undefined, avail).provider, 'claude-code', 'Claude Code로 다시 고를 수도 있다');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
