(() => {
'use strict';
const wm = globalThis.TextWatermark;
const $ = (id) => document.getElementById(id);
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

let DICT = JSON.parse(JSON.stringify(wm.DEFAULT_DICT));
let lastEmbed = null;

const SAMPLE_JA = [
  '本手順では、計測系の初期化および校正を行います。',
  '設定値はあらかじめ確認してください。',
  '取得したデータはすべて保存され、ほとんどの項目は自動で補完できます。',
  '異常が発生したときは、ただちに停止処理へ移行します。',
  'この設定は、再現性を確保するために必要です。',
  'ログを参照することで、原因をおおむね特定できます。',
  'ただし、電源電圧が規定範囲外のときは動作を保証しません。',
  'なお、詳細は付録Aを参照してください。',
  '測定はさまざまな条件で繰り返し、結果を記録します。',
  'したがって、較正済みの機器を用いることが望ましいです。',
  '入力または出力のいずれかが欠落している場合、処理を中断します。',
  '本方式は、既に公開されている規格に準拠しています。',
  '手順書のとおりに操作していただき、記録を残してください。',
  'センサの応答が遅いときは、配線およびコネクタを点検してください。',
  '例えば、温度が上限を超えた場合は警告を出力します。',
  'これらの値は、すべて構成ファイルから読み込まれます。',
  '再現できない事象については、ログを添えて報告してください。',
  'さらに、統計値は一定周期ごとに更新されます。',
  '較正が完了するまでは、出力を信頼できません。',
  'その他の項目は、規定のとおりに初期化されます。',
];
const SAMPLE_EN = [
  'The controller does not reset while the supply stays within range.',
  'We are going to verify that it is stable under sustained load.',
  'It cannot recover if the watchdog has not been serviced in time.',
  'There is no guarantee that the buffer will not overflow.',
  'I have measured a slow drift toward the upper limit.',
  'That is why the firmware does not enable arbitration among idle nodes.',
  'You are advised to confirm the values before the next run.',
  'Let us assume the reference clock is not skewed.',
  'They are retained whilst the diagnostic session is active.',
  'The log did not indicate an error, and we have archived the capture.',
  'The regulator was not stable, so the margin could not be measured.',
  'I am confident the sequencer will not stall amid the retry window.',
];
const rep = (arr, n, j) => Array.from({ length: n }, () => arr.join(j)).join(j);

/* ---- 設定 ---- */
function opts() {
  return {
    dict: DICT,
    tiers: [...document.querySelectorAll('.tier:checked')].map((e) => e.value),
    langs: [...document.querySelectorAll('.lang:checked')].map((e) => e.value),
    key: $('key').value,
    dataBytes: $('dbytes').value,
    profile: $('profile').value,
  };
}

function payloadBytes() {
  const mode = document.querySelector('input[name=pmode]:checked').value;
  const raw = $('payload').value.trim();
  if (mode === 'hex') {
    const h = raw.replace(/[^0-9a-fA-F]/g, '');
    if (h.length % 2) throw new Error('HEX の桁数が奇数です');
    const b = new Uint8Array(h.length / 2);
    for (let i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16);
    return b;
  }
  return wm.utf8Encode(raw);
}

const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');

function statCards(el, pairs) {
  el.innerHTML = pairs.map(([k, v]) => `<div><b>${esc(k)}</b><span>${esc(String(v))}</span></div>`).join('');
}

function msg(el, text, kind) {
  el.innerHTML = text ? `<div class="msg ${kind || ''}">${text}</div>` : '';
}

/* ---- 容量表示 ---- */
function updateCapacity() {
  const text = $('src').value;
  let pl;
  try { pl = payloadBytes(); } catch (e) { msg($('capMsg'), esc(e.message), 'ng'); return; }
  const o = opts();
  const a = wm.analyze(text, o);
  const cost = wm.frameCost(pl.length, o.dataBytes === 'auto' ? null : o.dataBytes, o.profile);
  statCards($('cap'), [
    ['本文', text.length + ' 文字'],
    ['スロット (容量)', a.capacityBits + ' bit'],
    ['ペイロード', pl.length + ' B'],
    ['DATA / ブロック数', cost.dataBytes + ' B / ' + cost.nBlocks],
    ['周期長', cost.periodBits + ' bit'],
    ['必要連続スロット span', cost.spanBits + ' bit'],
    ['反復', a.capacityBits ? (a.capacityBits / cost.periodBits).toFixed(2) + ' 周' : '0'],
  ]);
  if (!text) { msg($('capMsg'), ''); return; }
  if (a.capacityBits < cost.periodBits) {
    msg($('capMsg'), `容量不足: 周期長 ${cost.periodBits} bit に対しスロットが ${a.capacityBits} bit しかありません。本文を長くするか、ペイロードを短くするか、辞書ティア C を有効にしてください。`, 'ng');
  } else if (a.capacityBits < cost.spanBits * 2) {
    msg($('capMsg'), `復元は可能ですが余裕が小さいため、部分切り出しからの復元は期待できません (span ${cost.spanBits} bit)。`, '');
  } else {
    msg($('capMsg'), `十分な容量があります。連続する ${cost.spanBits} スロット以上を含む抜粋から復元できます。`, 'ok');
  }
}

/* ---- 埋め込み ---- */
async function doEmbed() {
  const text = $('src').value;
  if (!text) { msg($('embedMsg'), '原文が空です', 'ng'); return; }
  let pl;
  try { pl = payloadBytes(); } catch (e) { msg($('embedMsg'), esc(e.message), 'ng'); return; }
  const o = opts();
  let r;
  try { r = await wm.embed(text, pl, o); }
  catch (e) { msg($('embedMsg'), esc(e.message), 'ng'); return; }
  lastEmbed = r;
  $('out').value = r.text;

  // 変更された語を強調
  const outSlots = wm.analyze(r.text, o).slots;
  const parts = [];
  let cur = 0;
  const n = Math.min(outSlots.length, r.slots.length);
  for (let i = 0; i < n; i++) {
    const s = outSlots[i];
    parts.push(esc(r.text.slice(cur, s.start)));
    const changed = r.slots[i].surface !== s.surface;
    parts.push(changed ? `<mark title="${esc(r.slots[i].surface)} → ${esc(s.surface)}">${esc(s.surface)}</mark>` : esc(s.surface));
    cur = s.end;
  }
  parts.push(esc(r.text.slice(cur)));
  $('outHl').innerHTML = parts.join('');

  const verify = await wm.extract(r.text, o);
  const okSelf = verify.ok && toHex(verify.payload) === toHex(pl);
  msg($('embedMsg'),
    `スロット ${r.capacityBits} / 周期 ${r.periodBits} bit / 反復 ${r.cycles.toFixed(2)} 周 / 変更した語 ${r.changed} 箇所 / 文字数 ${text.length} → ${r.text.length}<br>` +
    `スロット構成の安定性: ${r.stable ? '安定' : '不安定 (' + r.mismatches.length + ' 箇所)'} / 自己抽出: ${okSelf ? '成功' : '失敗 — ' + esc(verify.reason || '')}`,
    okSelf && r.stable ? 'ok' : 'ng');
  updateCapacity();
}

/* ---- 抽出 ---- */
async function doExtract() {
  const text = $('exsrc').value;
  const o = opts();
  if (!text) { msg($('exMsg'), '検査対象が空です', 'ng'); return; }
  const r = await wm.extract(text, o);
  statCards($('exStat'), [
    ['スロット', r.slotCount],
    ['DATA', (r.dataBytes || '-') + ' B'],
    ['検出ブロック', `${r.blocksFound} / ${r.blocksTotal}`],
    ['判定', r.ok ? '検出' : '未検出'],
  ]);
  let grid = '';
  if (r.blocksTotal) {
    const hit = new Set(r.presentIndices);
    grid = '<div class="blocks">' + Array.from({ length: r.blocksTotal }, (_, i) =>
      `<i class="${hit.has(i) ? 'hit' : ''}" title="block ${i}">${i}</i>`).join('') + '</div>';
  }
  $('exBlocks').innerHTML = grid;
  if (r.ok) {
    let asText = '';
    try { asText = wm.utf8Decode(r.payload); } catch (e) { asText = '(UTF-8 として解釈できません)'; }
    statCards($('exPayload'), [['テキスト', asText], ['HEX', toHex(r.payload)], ['長さ', r.payload.length + ' B']]);
    msg($('exMsg'), '透かしを検出しました。', 'ok');
  } else {
    $('exPayload').innerHTML = '';
    msg($('exMsg'), '透かしを検出できませんでした — ' + esc(r.reason || ''), 'ng');
  }
}

/* ---- 検証 ---- */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

async function runVerify() {
  const text = $('src').value;
  if (!text) { $('vOut').innerHTML = '<div class="msg ng">埋め込みタブに原文を入力してください</div>'; return; }
  const o = opts();
  const trials = Math.max(4, Math.min(64, parseInt($('vTrials').value, 10) || 12));
  const btn = $('runVerify'); btn.disabled = true; btn.textContent = '実行中...';
  const html = [];
  try {
    const pl = payloadBytes();

    const cons = await wm.checkDictConsistency(text, o, 32, mulberry32(1234));
    html.push(`<div class="msg ${cons.ok ? 'ok' : 'ng'}">辞書整合性: ${cons.ok ? '問題なし' : '不整合 ' + cons.failures.length + ' 件'} (スロット ${cons.slotCount}, 試行 ${cons.trials})</div>`);
    if (!cons.ok) html.push('<pre class="out">' + esc(cons.failures.slice(0, 5).map((f) => f.reason).join('\n')) + '</pre>');

    const emb = await wm.embed(text, pl, o);
    const round = await wm.extract(emb.text, o);
    const rtOk = round.ok && toHex(round.payload) === toHex(pl);
    html.push(`<div class="msg ${rtOk ? 'ok' : 'ng'}">往復: ${rtOk ? '一致' : '不一致'} (周期 ${emb.periodBits} bit, span ${emb.spanBits} bit, 反復 ${emb.cycles.toFixed(2)} 周)</div>`);

    const wrong = await wm.extract(emb.text, Object.assign({}, o, { key: (o.key || '') + 'x' }));
    html.push(`<div class="msg ${wrong.ok ? 'ng' : 'ok'}">誤鍵拒否: ${wrong.ok ? '誤って復元された' : '正しく拒否'}</div>`);

    const plain = await wm.extract(text, o);
    html.push(`<div class="msg ${plain.ok ? 'ng' : 'ok'}">原文の誤検出: ${plain.ok ? 'あり' : 'なし'}</div>`);

    const rng = mulberry32(99);
    html.push('<table><tr><th>連続切り出し</th><th>復元率</th><th></th></tr>');
    for (const frac of [0.1, 0.2, 0.3, 0.4, 0.5, 0.7, 1.0]) {
      let ok = 0;
      for (let t = 0; t < trials; t++) {
        const len = Math.floor(emb.text.length * frac);
        const st = Math.floor(rng() * (emb.text.length - len + 1));
        const r = await wm.extract(emb.text.slice(st, st + len), o);
        if (r.ok && toHex(r.payload) === toHex(pl)) ok += 1;
      }
      const p = ok / trials;
      html.push(`<tr><td>${(frac * 100).toFixed(0)}%</td><td>${(p * 100).toFixed(0)}%</td><td><span class="bar" style="width:${(p * 120).toFixed(0)}px"></span></td></tr>`);
    }
    html.push('</table>');

    html.push('<table><tr><th>無作為削除</th><th>復元率</th><th></th></tr>');
    for (const ratio of [0.002, 0.005, 0.01, 0.02, 0.05]) {
      let ok = 0;
      for (let t = 0; t < trials; t++) {
        let s = emb.text;
        const target = Math.floor(s.length * ratio);
        let removed = 0;
        while (removed < target) {
          const cut = Math.min(4 + Math.floor(rng() * 8), target - removed);
          const at = Math.floor(rng() * Math.max(1, s.length - cut));
          s = s.slice(0, at) + s.slice(at + cut);
          removed += cut;
        }
        const r = await wm.extract(s, o);
        if (r.ok && toHex(r.payload) === toHex(pl)) ok += 1;
      }
      const p = ok / trials;
      html.push(`<tr><td>${(ratio * 100).toFixed(1)}%</td><td>${(p * 100).toFixed(0)}%</td><td><span class="bar" style="width:${(p * 120).toFixed(0)}px"></span></td></tr>`);
    }
    html.push('</table>');
  } catch (e) {
    html.push('<div class="msg ng">' + esc(e.message) + '</div>');
  }
  $('vOut').innerHTML = html.join('');
  btn.disabled = false; btn.textContent = '検証を実行';
}

/* ---- 辞書 ---- */
function showDict() { $('dictJson').value = JSON.stringify(DICT, null, 1); }

function applyDict() {
  try {
    const d = JSON.parse($('dictJson').value);
    if (!Array.isArray(d)) throw new Error('配列ではありません');
    const ids = new Set();
    for (const g of d) {
      if (!g.id || !g.lang || !g.tier || !Array.isArray(g.variants) || g.variants.length !== 2)
        throw new Error('不正なグループ: ' + JSON.stringify(g).slice(0, 80));
      if (ids.has(g.id)) throw new Error('id が重複: ' + g.id);
      ids.add(g.id);
      for (const k of ['prevNot', 'prevMust', 'nextNot'])
        if (g.guards && g.guards[k]) new RegExp(g.guards[k]);
    }
    DICT = d;
    msg($('dictMsg'), `${d.length} グループを適用しました。`, 'ok');
    updateCapacity();
  } catch (e) { msg($('dictMsg'), esc(e.message), 'ng'); }
}

function countDict() {
  const a = wm.analyze($('src').value, opts());
  const rows = [...a.perGroup.entries()].sort((x, y) => y[1] - x[1]);
  $('dictCount').innerHTML =
    `<p style="font-size:12.5px;color:var(--muted)">合計 ${a.capacityBits} スロット / ${rows.length} グループ</p>` +
    '<table><tr><th>グループ</th><th>出現数</th></tr>' +
    rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('') + '</table>';
}

/* ------------------------------------------------------------------ */
/* GET パラメータ                                                      */
/*                                                                     */
/* 静的ホスティング (GitHub Pages) 上で動くため、サーバ側の処理はない。 */
/* クエリ文字列をそのまま入力欄と設定に流し込み、run が指定されていれば */
/* 読み込み時に埋め込み/抽出を実行する。output を指定した場合は UI を   */
/* 描画せず結果のみを出力する。                                        */
/* ------------------------------------------------------------------ */

const TABS = ['embed', 'extract', 'verify', 'dict', 'url'];
const URL_WARN_LEN = 8000;

function b64urlEncode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s + pad);
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b;
}

const b64urlText = (s) => b64urlEncode(wm.utf8Encode(s));

/** q から name または alias の値を取り出す (先に見つかった方)。 */
function pick(q, ...names) {
  for (const n of names) {
    const v = q.get(n);
    if (v !== null) return v;
  }
  return null;
}

/** "A,B" / "AB" / "a b" のいずれの記法も受ける。 */
function parseList(value, allowed) {
  const found = [];
  const upper = allowed.every((a) => a.length === 1);
  const tokens = upper
    ? value.split(/[\s,|+]+/).join('').split('')
    : value.split(/[\s,|+]+/);
  for (const raw of tokens) {
    const t = upper ? raw.toUpperCase() : raw.toLowerCase();
    if (allowed.indexOf(t) >= 0 && found.indexOf(t) < 0) found.push(t);
  }
  return found;
}

function setChecks(selector, values) {
  document.querySelectorAll(selector).forEach((e) => { e.checked = values.indexOf(e.value) >= 0; });
}

function setSelect(el, value, allowed) {
  if (allowed.indexOf(value) >= 0) el.value = value;
}

/**
 * クエリ文字列を UI に反映する。
 * @returns {{action:string|null, output:string|null, tab:string, dictUrl:string|null, errors:string[]}}
 */
function readParams(q) {
  const errors = [];
  const state = { action: null, output: null, tab: 'embed', dictUrl: null, errors };

  const t64 = pick(q, 'text64', 't64');
  const text = pick(q, 'text', 't');
  let body = null;
  if (t64 !== null) {
    try { body = wm.utf8Decode(b64urlDecode(t64)); }
    catch (e) { errors.push('text64 を base64url として解釈できません'); }
  } else if (text !== null) {
    body = text;
  }

  const p64 = pick(q, 'payload64', 'p64');
  const payload = pick(q, 'payload', 'p');
  if (p64 !== null) {
    try { $('payload').value = wm.utf8Decode(b64urlDecode(p64)); }
    catch (e) { errors.push('payload64 を base64url として解釈できません'); }
  } else if (payload !== null) {
    $('payload').value = payload;
  }

  const pmode = pick(q, 'pmode', 'pm');
  if (pmode !== null) {
    const m = pmode.toLowerCase() === 'hex' ? 'hex' : 'text';
    const el = document.querySelector(`input[name=pmode][value=${m}]`);
    if (el) el.checked = true;
  }

  const key = pick(q, 'key', 'k');
  if (key !== null) $('key').value = key;

  const data = pick(q, 'data', 'd', 'dbytes');
  if (data !== null) {
    const v = data.toLowerCase();
    if (['auto', '2', '4', '8', '16', '32'].indexOf(v) >= 0) $('dbytes').value = v;
    else errors.push('data の値が不正です: ' + data);
  }

  const profile = pick(q, 'profile');
  if (profile !== null) setSelect($('profile'), profile.toLowerCase(), ['span', 'compact']);

  const tiers = pick(q, 'tiers', 'tier');
  if (tiers !== null) {
    const v = parseList(tiers, ['A', 'B', 'C']);
    if (v.length) setChecks('.tier', v);
    else errors.push('tiers に有効な値がありません: ' + tiers);
  }

  const langs = pick(q, 'langs', 'lang');
  if (langs !== null) {
    const v = parseList(langs, ['ja', 'en']);
    if (v.length) setChecks('.lang', v);
    else errors.push('langs に有効な値がありません: ' + langs);
  }

  state.dictUrl = pick(q, 'dict');

  const run = pick(q, 'run', 'action', 'a');
  const tab = (pick(q, 'tab') || '').toLowerCase();
  if (run !== null) {
    const r = run.toLowerCase();
    if (r === 'embed' || r === 'extract') state.action = r;
    else if (r === '1' || r === 'true' || r === 'yes' || r === '') {
      state.action = tab === 'extract' ? 'extract' : 'embed';
    } else errors.push('run の値が不正です: ' + run);
  }

  state.tab = TABS.indexOf(tab) >= 0 ? tab : state.action === 'extract' ? 'extract' : 'embed';

  // 本文は動作に応じた欄へ入れる。抽出時は検査対象、それ以外は原文。
  if (body !== null) {
    if (state.action === 'extract' || state.tab === 'extract') $('exsrc').value = body;
    else $('src').value = body;
  }

  const output = (pick(q, 'output', 'o') || '').toLowerCase();
  if (output === 'text' || output === 'json') state.output = output;
  else if (output) errors.push('output の値が不正です: ' + output);

  return state;
}

/** output=text|json のときに、UI を描画せず結果だけを返す。 */
async function runHeadless(state) {
  const o = opts();
  if (state.action === 'extract') {
    const text = $('exsrc').value || $('src').value;
    const r = await wm.extract(text, o);
    let asText = null;
    if (r.ok) { try { asText = wm.utf8Decode(r.payload); } catch (e) { asText = null; } }
    const json = {
      action: 'extract',
      ok: !!r.ok,
      reason: r.reason || null,
      slots: r.slotCount,
      dataBytes: r.dataBytes,
      blocksFound: r.blocksFound,
      blocksTotal: r.blocksTotal,
      payloadText: asText,
      payloadHex: r.ok ? toHex(r.payload).replace(/ /g, '') : null,
      payloadLength: r.ok ? r.payload.length : 0,
    };
    return { json, text: r.ok ? (asText === null ? json.payloadHex : asText) : '' , ok: !!r.ok };
  }

  const pl = payloadBytes();
  const r = await wm.embed($('src').value, pl, o);
  const check = await wm.extract(r.text, o);
  const ok = r.sufficient && r.stable && check.ok && toHex(check.payload) === toHex(pl);
  const json = {
    action: 'embed',
    ok,
    text: r.text,
    capacityBits: r.capacityBits,
    periodBits: r.periodBits,
    spanBits: r.spanBits,
    cycles: Number(r.cycles.toFixed(3)),
    blocks: r.blocks,
    dataBytes: r.dataBytes,
    changed: r.changed,
    stable: r.stable,
    sufficient: r.sufficient,
    selfExtract: !!check.ok,
  };
  return { json, text: r.text, ok };
}

async function renderHeadless(state) {
  // 入力欄を読んでから DOM を差し替える (順序を逆にすると入力が失われる)。
  let body;
  let ok = false;
  try {
    const r = await runHeadless(state);
    ok = r.ok;
    body = state.output === 'json' ? JSON.stringify(r.json, null, 2) : r.text;
  } catch (e) {
    ok = false;
    body = state.output === 'json'
      ? JSON.stringify({ ok: false, error: e.message }, null, 2)
      : 'ERROR: ' + e.message;
  }
  document.body.innerHTML = '<pre class="out" id="result" style="max-height:none"></pre>';
  $('result').textContent = body;
  document.documentElement.dataset.result = ok ? 'ok' : 'ng';
}

/* ---- 共有 URL の生成 ---- */
function buildUrl() {
  const q = new URLSearchParams();
  const action = $('uAction').value;
  const useB64 = $('uB64').checked;
  const isExtract = action === 'extract';
  const body = isExtract ? ($('exsrc').value || $('src').value) : $('src').value;

  if (body) q.set(useB64 ? 'text64' : 'text', useB64 ? b64urlText(body) : body);
  if (!isExtract) {
    const pl = $('payload').value;
    if (pl) q.set(useB64 ? 'payload64' : 'payload', useB64 ? b64urlText(pl) : pl);
    const pm = document.querySelector('input[name=pmode]:checked').value;
    if (pm !== 'text') q.set('pmode', pm);
  }
  if ($('uKey').checked && $('key').value) q.set('key', $('key').value);
  if ($('dbytes').value !== 'auto') q.set('data', $('dbytes').value);
  if ($('profile').value !== 'span') q.set('profile', $('profile').value);

  const tiers = [...document.querySelectorAll('.tier:checked')].map((e) => e.value);
  const langs = [...document.querySelectorAll('.lang:checked')].map((e) => e.value);
  if (tiers.join(',') !== 'A,B') q.set('tiers', tiers.join(','));
  if (langs.join(',') !== 'ja,en') q.set('langs', langs.join(','));

  if (action) q.set('run', action);
  if ($('uOutput').value) q.set('output', $('uOutput').value);

  const base = location.origin + location.pathname;
  const url = q.toString() ? base + '?' + q.toString() : base;
  $('uOut').value = url;

  // 実運用では URL 長に上限がある (中継や配信基盤により 8 KB 前後で切られる)。
  if (url.length > URL_WARN_LEN) {
    msg($('uMsg'),
      `URL が ${url.length} 文字あります。${URL_WARN_LEN} 文字を超えると環境によっては切り捨てられます。` +
      (useB64 ? '本文を短くしてください。' : 'base64url を有効にすると短くなります。'), 'ng');
  } else {
    msg($('uMsg'), `URL 長 ${url.length} 文字`, 'ok');
  }
  return url;
}

function showExamples() {
  const base = location.origin + location.pathname;
  $('uExamples').textContent = [
    '# 本文と埋め込みデータを指定して画面を開く',
    base + '?text=' + encodeURIComponent('この設定は再現性を確保するために必要です。') + '&payload=ID:0042',
    '',
    '# 読み込み時に埋め込みまで実行する',
    base + '?text=...&payload=ID:0042&run=embed',
    '',
    '# 埋め込み結果の本文だけを返す (UI なし)',
    base + '?text=...&payload=ID:0042&run=embed&output=text',
    '',
    '# JSON で統計込みの結果を返す',
    base + '?text=...&payload=ID:0042&key=s3cret&run=embed&output=json',
    '',
    '# 抽出する',
    base + '?text=...&run=extract&output=json',
    '',
    '# 長文や記号を含む場合は base64url (text64 / payload64)',
    base + '?text64=' + b64urlText('できるだけ短い例。') + '&payload64=' + b64urlText('ID:0042') + '&run=embed&output=text',
  ].join('\n');
}

/* ---- 配線 ---- */
document.querySelectorAll('nav .tab').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('nav .tab').forEach((x) => x.classList.toggle('on', x === b));
    TABS.forEach((id) => { $(id).hidden = id !== b.dataset.t; });
  };
});
$('doEmbed').onclick = doEmbed;
$('doExtract').onclick = doExtract;
$('runVerify').onclick = runVerify;
$('applyDict').onclick = applyDict;
$('resetDict').onclick = () => { DICT = JSON.parse(JSON.stringify(wm.DEFAULT_DICT)); showDict(); msg($('dictMsg'), '既定辞書に戻しました。', 'ok'); updateCapacity(); };
$('countDict').onclick = countDict;
$('sampleJa').onclick = () => { $('src').value = rep(SAMPLE_JA, 20, ''); updateCapacity(); };
$('sampleEn').onclick = () => { $('src').value = rep(SAMPLE_EN, 30, ' '); updateCapacity(); };
$('clearSrc').onclick = () => { $('src').value = ''; updateCapacity(); };
$('fromEmbed').onclick = () => { $('exsrc').value = $('out').value; };
$('copyOut').onclick = () => navigator.clipboard && navigator.clipboard.writeText($('out').value);

let timer = null;
const deb = () => { clearTimeout(timer); timer = setTimeout(updateCapacity, 180); };
$('src').addEventListener('input', deb);
$('payload').addEventListener('input', deb);
document.querySelectorAll('.tier,.lang,#dbytes,#profile,input[name=pmode]').forEach((e) => e.addEventListener('change', updateCapacity));

$('uBuild').onclick = buildUrl;
$('uCopy').onclick = () => { const u = buildUrl(); if (navigator.clipboard) navigator.clipboard.writeText(u); };
$('uOpen').onclick = () => window.open(buildUrl(), '_blank', 'noopener');

/* ---- 起動 ---- */
function selectTab(name) {
  const b = document.querySelector(`nav .tab[data-t="${name}"]`);
  if (b) b.onclick();
}

/** dict= で外部辞書を読み込む。失敗しても既定辞書で続行する。 */
async function loadDictFromUrl(url) {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`辞書の取得に失敗しました (HTTP ${res.status})`);
  const d = await res.json();
  if (!Array.isArray(d)) throw new Error('辞書 JSON が配列ではありません');
  DICT = d;
}

(async () => {
  const q = new URLSearchParams(location.search);
  const hasParams = [...q.keys()].length > 0;
  const state = hasParams ? readParams(q) : { action: null, output: null, tab: 'embed', dictUrl: null, errors: [] };

  if (state.dictUrl) {
    try { await loadDictFromUrl(state.dictUrl); }
    catch (e) { state.errors.push(e.message); }
  }

  if (state.output && state.action) { await renderHeadless(state); return; }

  showDict();
  if (!$('src').value && !$('exsrc').value) $('src').value = rep(SAMPLE_JA, 20, '');
  showExamples();
  updateCapacity();
  selectTab(state.tab);

  if (state.errors.length) msg($('paramMsg'), state.errors.map(esc).join('<br>'), 'ng');

  if (state.action === 'embed') await doEmbed();
  else if (state.action === 'extract') await doExtract();

  globalThis.__ready = true; // 自動テスト用の初期化完了マーカ
})();
})();
