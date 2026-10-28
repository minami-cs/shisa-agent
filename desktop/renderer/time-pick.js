// 시각 고르기: 오전/오후 · 시 · 분 세 칸(select). 크롬 기본 시간 칸(type="time")은 고른 항목을 열 맨 위로 올려
// 오후를 고르면 오후가 오전 위에 보여 헷갈려서 대신 쓴다 — 오전/오후 칸은 늘 오전이 위.
// 자리(<span class="time-pick">)는 <input type="time"> 처럼 쓴다: value 는 'HH:MM'(24시간) 또는 ''(다 고르기 전),
// 안쪽 칸의 change 는 자리로 올라온다(값은 자리의 value 로 읽는다), 자리 밖으로 포커스가 나가면 자리에 blur.
// data-required 면 빈 칸(--) 없이 늘 값이 있다
import { t } from '../src/i18n.js';

const pad = (n) => String(n).padStart(2, '0');

export function mountTimePick(host) {
  const doc = host.ownerDocument;
  const required = host.hasAttribute('data-required');
  const option = (value, text, key = null) => {
    const o = doc.createElement('option');
    o.value = value;
    o.textContent = key ? t(key) : text;
    if (key) o.setAttribute('data-i18n', key);
    return o;
  };
  const select = (cls, aria, opts) => {
    const s = doc.createElement('select');
    s.className = cls;
    s.setAttribute('data-i18n-aria-label', aria);
    s.setAttribute('aria-label', t(aria));
    if (required) s.required = true;
    else s.append(option('', '--'));
    s.append(...opts);
    return s;
  };
  const ap = select('tp-ap', 'settings.time_ampm_aria', [option('am', '', 'settings.time_am'), option('pm', '', 'settings.time_pm')]);
  // 시: 12, 1, 2, … 11 (값은 12로 나눈 나머지)
  const hr = select('tp-h', 'settings.time_hour_aria', Array.from({ length: 12 }, (_, i) => option(String(i), String(i || 12))));
  const mi = select('tp-m', 'settings.time_min_aria', Array.from({ length: 60 }, (_, i) => option(pad(i), pad(i))));
  const colon = doc.createElement('span');
  colon.className = 'tp-colon';
  colon.textContent = ':';
  host.replaceChildren(ap, hr, colon, mi);

  Object.defineProperty(host, 'value', {
    configurable: true,
    get() {
      if (ap.value === '' || hr.value === '' || mi.value === '') return '';
      return `${pad(Number(hr.value) + (ap.value === 'pm' ? 12 : 0))}:${mi.value}`;
    },
    set(v) {
      const m = /^(\d{2}):(\d{2})$/.exec(String(v ?? ''));
      if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
        if (!required) ap.value = hr.value = mi.value = '';
        return;
      }
      const h = Number(m[1]);
      ap.value = h < 12 ? 'am' : 'pm';
      hr.value = String(h % 12);
      mi.value = m[2];
    },
  });
  host.addEventListener('focusout', (e) => { if (!host.contains(e.relatedTarget)) host.dispatchEvent(new Event('blur')); });
  return host;
}
