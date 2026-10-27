import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialChat, chatReducer, isBusy, latestStep, stepLabel, summarizeReply } from '../src/chat.js';

const run = (actions, s = initialChat()) => actions.reduce(chatReducer, s);
const ev = (o) => ({ type: 'event', ev: o });

test('내가 보낸 대화: thinking → step → done 이면 replies 에 들어간다', () => {
  let s = run([{ type: 'local', msg: { role: 'user', text: '프로젝트 보여줘', at: 'x' } }, { type: 'accepted', chatId: 'c1' }]);
  assert.ok(isBusy(s));
  s = run([ev({ chatId: 'c1', status: 'thinking' }), ev({ chatId: 'c1', status: 'step', step: 'git.log' })], s);
  assert.equal(latestStep(s), 'git.log');
  s = chatReducer(s, ev({ chatId: 'c1', status: 'done', text: '여기요', show: 'projects' }));
  assert.ok(!isBusy(s));
  assert.deepEqual(s.replies, [{ chatId: 'c1', text: '여기요', show: 'projects', error: false }]);
  assert.deepEqual(s.messages.map((m) => [m.role, m.text, m.show]), [['user', '프로젝트 보여줘', undefined], ['assistant', '여기요', 'projects']]);
  assert.deepEqual(chatReducer(s, { type: 'consumed' }).replies, []);
});

test('다른 창에서 보낸 대화는 바쁨 표시만, replies 없음', () => {
  const s = run([ev({ chatId: 'x', status: 'thinking' })]);
  assert.ok(isBusy(s));
  const t = chatReducer(s, ev({ chatId: 'x', status: 'done', text: 'ok' }));
  assert.ok(!isBusy(t));
  assert.deepEqual(t.replies, []);
  assert.equal(t.messages.length, 1);
});

test('캐릭터 대화방 따라가기(follow): 패널에서 같은 대화방에 이어 말해도 답이 이 창 replies 로, 다른 대화방은 아니다', () => {
  let s = run([{ type: 'accepted', chatId: 'h1', threadId: 'hv', follow: true }, ev({ chatId: 'h1', threadId: 'hv', status: 'done', text: '첫 답' })]);
  assert.equal(s.follow, 'hv');
  assert.deepEqual(s.replies.map((r) => r.text), ['첫 답']);
  s = chatReducer(s, { type: 'consumed' });
  // 패널에서 같은 대화방에 보낸 말(이 창 mine 아님)
  s = run([ev({ chatId: 'p1', threadId: 'hv', status: 'thinking' }), ev({ chatId: 'p1', threadId: 'hv', status: 'done', text: '패널 말의 답' })], s);
  assert.deepEqual(s.replies.map((r) => r.text), ['패널 말의 답']);
  s = chatReducer(s, { type: 'consumed' });
  s = run([ev({ chatId: 'p2', threadId: 'other', status: 'done', text: '다른 방' })], s);
  assert.deepEqual(s.replies, []);
  // 답이 POST 응답보다 먼저 왔고 이미 따라가던 방이면 두 번 보이지 않는다
  s = run([ev({ chatId: 'h2', threadId: 'hv', status: 'done', text: '빠른 답' })], s);
  assert.equal(s.replies.length, 1);
  s = run([{ type: 'consumed' }, { type: 'accepted', chatId: 'h2', threadId: 'hv', follow: true }], s);
  assert.deepEqual(s.replies, []);
  // follow 없는 창(패널)은 그대로
  assert.equal(run([{ type: 'accepted', chatId: 'z', threadId: 'hv' }]).follow, null);
});

test('답이 POST 응답보다 먼저 와도 짝을 맞춘다', () => {
  const s = run([ev({ chatId: 'c2', status: 'done', text: '빠름' }), { type: 'accepted', chatId: 'c2' }]);
  assert.equal(s.replies.length, 1);
  assert.equal(s.replies[0].text, '빠름');
  assert.ok(!isBusy(s));
});

test('중복 done·늦은 step 무시, error 는 show 없음', () => {
  let s = run([{ type: 'accepted', chatId: 'e' }, ev({ chatId: 'e', status: 'error', text: '실패', show: 'todos' })]);
  assert.deepEqual(s.replies, [{ chatId: 'e', text: '실패', show: null, error: true }]);
  s = run([ev({ chatId: 'e', status: 'done', text: 'dup' }), ev({ chatId: 'e', status: 'step', step: 'late' })], s);
  assert.equal(s.messages.length, 1);
  assert.ok(!isBusy(s));
  assert.equal(chatReducer(s, ev({ status: 'done' })), s); // chatId 없음
});

test('history 는 대화를 교체하고 이상한 항목은 버린다', () => {
  const s = run([{ type: 'history', items: [{ role: 'user', text: 'a', at: '1' }, { role: 'system', text: 'x' }, { role: 'assistant', text: '  ' }, { role: 'assistant', text: 'b', show: 'nope' }] }]);
  assert.deepEqual(s.messages, [{ role: 'user', text: 'a', at: '1' }, { role: 'assistant', text: 'b', at: '' }]);
});

test('stepLabel', () => {
  assert.equal(stepLabel('slack.slack_search_messages'), 'Slack · search messages');
  assert.equal(stepLabel('ms365.list_events'), '메일·일정 · list events');
  assert.equal(stepLabel('read_file'), 'read file');
  assert.equal(stepLabel(null), '생각 중…');
  // 승인 카드 대기(agent permissions.ts waitStep) — 그대로 보인다
  const wait = '승인을 기다리고 있어요 — 채팅 창의 카드에서 허용해 주세요';
  assert.equal(stepLabel(wait), wait);
  const s = run([{ type: 'accepted', chatId: 'w1' }, ev({ chatId: 'w1', status: 'step', step: 'Bash' }), ev({ chatId: 'w1', status: 'step', step: wait })]);
  assert.equal(stepLabel(latestStep(s)), wait);
});

test('summarizeReply: 마크다운 걷어내고 줄은 살린다(5줄 이하는 그대로)', () => {
  assert.deepEqual(summarizeReply('## 제목\n- **굵게** [링크](https://x) `코드`'), { text: '제목\n굵게 링크 코드', truncated: false });
  assert.deepEqual(summarizeReply('하나\n\n둘\n![그림](a.png) 셋\n4. 넷\n> 다섯'), { text: '하나\n둘\n그림 셋\n넷\n다섯', truncated: false });
  assert.deepEqual(summarizeReply('• 점\n- [ ] 할 일\n- [x] 끝'), { text: '점\n할 일\n끝', truncated: false });
  // 한 줄이 아무리 길어도 글자 수로 자르지 않는다(시각적 5줄은 CSS line-clamp)
  assert.deepEqual(summarizeReply('가'.repeat(300)), { text: '가'.repeat(300), truncated: false });
  // 형광펜·글자색은 그대로 남겨 말풍선이 그린다
  assert.deepEqual(summarizeReply('==중요== :red[빨강]'), { text: '==중요== :red[빨강]', truncated: false });
});

test('summarizeReply: 6줄 이상이면 앞 5줄 + …', () => {
  const r = summarizeReply('1줄\n2줄\n\n3줄\n4줄\n5줄\n6줄\n7줄');
  assert.deepEqual(r, { text: '1줄\n2줄\n3줄\n4줄\n5줄…', truncated: true });
  assert.deepEqual(summarizeReply('a\nb\nc', 2), { text: 'a\nb…', truncated: true });
  assert.deepEqual(summarizeReply('제목\n===\n본문\n***'), { text: '제목\n본문', truncated: false }); // 제목 밑줄·가로줄은 줄로 안 친다
});

test('summarizeReply: 표 행은 칸을 · 로 잇고 구분선·콜아웃 머리·가로줄은 건너뛴다', () => {
  const md = '| 이름 | 상태 |\n| --- | :---: |\n| **A** | 끝 |\n\n> [!WARNING]\n> 조심해요\n\n---\n> [!NOTE] 한 줄 머리';
  assert.deepEqual(summarizeReply(md), { text: '이름 · 상태\nA · 끝\n조심해요\n한 줄 머리', truncated: false });
});

test('summarizeReply: 코드블록은 빼고 보이니 잘린 것으로(펼치기로 본다)', () => {
  assert.deepEqual(summarizeReply('고쳤어요:\n```js\nconst x = 1;\n```'), { text: '고쳤어요:…', truncated: true });
  assert.deepEqual(summarizeReply('```\nx\n```'), { text: '…', truncated: true });
});

test('summarizeReply: 빈 입력', () => {
  assert.deepEqual(summarizeReply(undefined), { text: '', truncated: false });
  assert.deepEqual(summarizeReply(''), { text: '', truncated: false });
  assert.deepEqual(summarizeReply('\n\n  \n| --- |'), { text: '', truncated: false });
});

test('replyBubble: 접힌 글 + 원문(full), 스레드면 대화 열기 · 아니면 잘렸을 때 채팅 섹션', async () => {
  const { replyBubble } = await import('../src/chat.js');
  const long = '1\n2\n3\n4\n5\n6';
  assert.deepEqual(replyBubble({ chatId: 'c1', text: long, threadId: 't1' }), {
    id: 'chat-c1', text: '1\n2\n3\n4\n5…', kind: 'info', ttlMs: 20000, reply: true, full: long, truncated: true, open: { section: 'chat', id: 't1' },
  });
  const b = replyBubble({ chatId: 'c2', text: long });
  assert.equal(b.panelSection, 'chat');
  assert.equal(b.open, undefined);
  const s = replyBubble({ chatId: 'c3', text: '짧아요', stopped: true });
  assert.equal(s.ttlMs, 5000);
  assert.equal(s.truncated, false);
  assert.equal(s.panelSection, undefined);
  assert.equal(replyBubble({ chatId: 'c4', text: '안 됐어요', error: true }).kind, 'error');
  assert.equal(replyBubble({ chatId: 'c5', text: '' }).text, '(빈 답)');
  assert.equal(replyBubble({ chatId: 'c6', text: '```\nx\n```' }).panelSection, 'chat'); // 코드뿐이어도 펼치기·대화에서 보기로
});

test('대화 기록: 할 일을 집어 든 사용자 말은 todoId·todoTitle 유지, 답·잘못된 값은 버린다', () => {
  const s = run([{ type: 'history', items: [
    { role: 'user', text: '이거 없애', at: 't', todoId: 'mail:1', todoTitle: '견적 회신' },
    { role: 'user', text: '그냥', at: 't', todoId: 3 },
    { role: 'assistant', text: '지웠어', at: 't', todoId: 'mail:1' },
  ] }, { type: 'local', msg: { role: 'user', text: '끝났어', at: 'u', todoId: 'a' } }]);
  assert.deepEqual(s.messages, [
    { role: 'user', text: '이거 없애', at: 't', todoId: 'mail:1', todoTitle: '견적 회신' },
    { role: 'user', text: '그냥', at: 't' },
    { role: 'assistant', text: '지웠어', at: 't' },
    { role: 'user', text: '끝났어', at: 'u', todoId: 'a' },
  ]);
});

test('stopped: 끝난 것으로 치고(바쁨 해제) 답 메시지는 안 붙인다, 내 대화면 replies 에 stopped', async () => {
  const { stopTargets, sendButton, STOPPED_TEXT } = await import('../src/chat.js');
  const A = '0b6c3a52-5d0e-4c8e-9a51-2f1f8c1e7a10', B = '1b6c3a52-5d0e-4c8e-9a51-2f1f8c1e7a10';
  let s = run([{ type: 'accepted', chatId: A, threadId: 't1' }, ev({ chatId: A, threadId: 't1', status: 'thinking' }), ev({ chatId: B, threadId: 't2', status: 'thinking' })]);
  assert.deepEqual(stopTargets(s, 't1'), [A]);
  assert.deepEqual(stopTargets(s).sort(), [A, B]);
  assert.deepEqual(stopTargets(run([ev({ chatId: 'chat-1', status: 'thinking' })])), []); // chatId 모양이 아니면 안 보낸다
  // 보내기 ↔ 멈추기
  assert.equal(sendButton(s, 't1', '').mode, 'stop');
  assert.equal(sendButton(s, 't1', '').text, '멈추기');
  assert.equal(sendButton(s, 't1', '하나 더').mode, 'send'); // 적은 게 있으면 보내기(줄 서서)
  assert.equal(sendButton(s, 't3', '').mode, 'send');
  assert.equal(sendButton(s, null, '').mode, 'send');
  s = chatReducer(s, ev({ chatId: A, threadId: 't1', status: 'stopped', text: '멈췄어요' }));
  assert.ok(!isBusy(s, 't1'));
  assert.ok(isBusy(s, 't2'));
  assert.deepEqual(s.messages, []);
  assert.deepEqual(s.replies, [{ chatId: A, text: '멈췄어요', show: null, error: false, stopped: true, threadId: 't1' }]);
  assert.equal(chatReducer(s, ev({ chatId: A, status: 'stopped' })), s); // 중복
  assert.equal(chatReducer(s, ev({ chatId: A, status: 'step', step: 'x' })), s); // 늦은 step
  s = chatReducer(s, ev({ chatId: B, status: 'stopped' }));
  assert.equal(s.finished.at(-1).text, STOPPED_TEXT);
  assert.equal(s.replies.length, 1); // 다른 창 것
  assert.equal(sendButton(s, 't1', '').mode, 'send');
});

test('대기 중(queued): 기다리는 말은 queued, thinking 이 오면 돌기 시작 — 늦게 온 queued 는 무시', async () => {
  const { queuedIds, isRunning, localState, runningIds, stopTargets, sendButton } = await import('../src/chat.js');
  const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
  let s = run([ev({ chatId: A, threadId: 't', status: 'thinking' }), ev({ chatId: A, threadId: 't', status: 'step', step: 'git.log' }), ev({ chatId: B, threadId: 't', status: 'queued' })]);
  // POST 응답(accepted)이 queued 보다 늦게 와도 대기 중은 그대로
  s = chatReducer(s, { type: 'accepted', chatId: B, threadId: 't' });
  assert.deepEqual(queuedIds(s, 't'), [B]);
  assert.equal(localState(s, B), 'queued');
  assert.equal(localState(s, A), 'running');
  assert.equal(localState(s, null), 'sending');
  assert.equal(localState(s, 'gone'), 'done');
  assert.deepEqual(runningIds(s, 't'), [A]);
  assert.equal(latestStep(s, 't'), 'git.log', '기다리는 말은 진행 표시에서 뺀다');
  assert.ok(isBusy(s, 't') && isRunning(s, 't'));
  assert.deepEqual(stopTargets(s, 't'), [A, B], '멈추기는 기다리는 것까지');
  assert.equal(sendButton(s, 't', '').mode, 'stop');
  // A 가 멈추고 B 차례
  s = run([ev({ chatId: A, threadId: 't', status: 'stopped', text: '멈췄어요' }), ev({ chatId: B, threadId: 't', status: 'thinking' })], s);
  assert.deepEqual(queuedIds(s, 't'), []);
  assert.equal(localState(s, B), 'running');
  assert.equal(s.pending[B].threadId, 't');
  assert.equal(chatReducer(s, ev({ chatId: B, status: 'queued' })), s, '이미 도는 걸 다시 대기로 돌리지 않는다');
  // 다른 대화에서만 돌고, 이 대화는 기다리기만
  s = run([ev({ chatId: 'c3', threadId: 'u', status: 'queued' })], s);
  assert.equal(isRunning(s, 'u'), false);
  assert.ok(isBusy(s, 'u'));
  // 대기 중이던 걸 취소 → 끝
  s = run([ev({ chatId: 'c3', threadId: 'u', status: 'stopped' })], s);
  assert.equal(isBusy(s, 'u'), false);
  assert.equal(chatReducer(s, ev({ chatId: 'c3', status: 'queued' })), s, '끝난 뒤 늦게 온 queued 는 무시');
});
