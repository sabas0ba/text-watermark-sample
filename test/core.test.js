/*
 * core.test.js - 符号化・復号の往復と耐性の回帰テスト
 *
 *   node --test
 */

const test = require('node:test');
const assert = require('node:assert');
const wm = require('../site/assets/core.js');

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
].join('');

const SAMPLE_EN = [
  'The controller does not reset while the supply stays within range.',
  'We are going to verify that it is stable under sustained load.',
  'It cannot recover if the watchdog has not been serviced in time.',
  'There is no guarantee that the buffer will not overflow.',
  'I have measured a slow drift toward the upper limit.',
].join(' ');

const repeat = (s, n) => Array.from({ length: n }, () => s).join('');
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** 決定的な擬似乱数 (試験の再現性のため)。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('辞書は id 一意・2 変種・正規表現として妥当', () => {
  const ids = new Set();
  for (const g of wm.DEFAULT_DICT) {
    assert.ok(g.id && g.lang && g.tier, `欠損フィールド: ${JSON.stringify(g)}`);
    assert.strictEqual(g.variants.length, 2, `variants が 2 でない: ${g.id}`);
    assert.ok(!ids.has(g.id), `id が重複: ${g.id}`);
    ids.add(g.id);
    for (const k of ['prevNot', 'prevMust', 'nextNot']) {
      if (g.guards && g.guards[k]) new RegExp(g.guards[k]);
    }
  }
});

test('日本語本文の往復', async () => {
  const text = repeat(SAMPLE_JA, 20);
  const payload = wm.utf8Encode('ID:0042');
  const emb = await wm.embed(text, payload, {});
  assert.ok(emb.sufficient, '容量不足');
  assert.ok(emb.stable, 'スロット構成が不安定');
  const got = await wm.extract(emb.text, {});
  assert.ok(got.ok, got.reason || '抽出失敗');
  assert.strictEqual(hex(got.payload), hex(payload));
});

test('英語本文の往復', async () => {
  const text = repeat(SAMPLE_EN + ' ', 30);
  const payload = wm.utf8Encode('EN-01');
  const emb = await wm.embed(text, payload, { langs: ['en'] });
  const got = await wm.extract(emb.text, { langs: ['en'] });
  assert.ok(got.ok, got.reason || '抽出失敗');
  assert.strictEqual(hex(got.payload), hex(payload));
});

test('鍵が一致する場合のみ復号できる', async () => {
  const text = repeat(SAMPLE_JA, 20);
  const payload = wm.utf8Encode('secret');
  const emb = await wm.embed(text, payload, { key: 'k1' });

  const right = await wm.extract(emb.text, { key: 'k1' });
  assert.ok(right.ok);
  assert.strictEqual(hex(right.payload), hex(payload));

  const wrong = await wm.extract(emb.text, { key: 'k2' });
  assert.ok(!wrong.ok, '誤った鍵で復号されてしまった');
});

test('透かしのない本文からは検出しない', async () => {
  const plain = await wm.extract(repeat(SAMPLE_JA, 20), {});
  assert.ok(!plain.ok, '原文から誤検出した');
});

test('埋め込みは本文の意味的な構造を壊さない (スロット数が保存される)', async () => {
  const text = repeat(SAMPLE_JA, 20);
  const before = wm.analyze(text, {});
  const emb = await wm.embed(text, wm.utf8Encode('x'), {});
  const after = wm.analyze(emb.text, {});
  assert.strictEqual(after.capacityBits, before.capacityBits);
});

test('部分切り出しから復元できる', async () => {
  const text = repeat(SAMPLE_JA, 40);
  const payload = wm.utf8Encode('ID:0042');
  const emb = await wm.embed(text, payload, {});
  const rng = mulberry32(99);
  let ok = 0;
  const trials = 12;
  for (let i = 0; i < trials; i++) {
    const len = Math.floor(emb.text.length * 0.5);
    const at = Math.floor(rng() * (emb.text.length - len + 1));
    const r = await wm.extract(emb.text.slice(at, at + len), {});
    if (r.ok && hex(r.payload) === hex(payload)) ok += 1;
  }
  assert.strictEqual(ok, trials, `50% 切り出しの復元率 ${ok}/${trials}`);
});

test('辞書整合性 — 無作為なビット割り当てで往復しても走査結果が変わらない', async () => {
  const res = await wm.checkDictConsistency(repeat(SAMPLE_JA, 10), {}, 24, mulberry32(1234));
  assert.ok(res.ok, JSON.stringify(res.failures.slice(0, 3)));
});

test('fieldAt がフレームのフィールド境界を返す', () => {
  const D = 4;
  assert.strictEqual(wm.fieldAt(0, D).name, 'sync');
  assert.strictEqual(wm.fieldAt(15, D).name, 'sync');
  assert.strictEqual(wm.fieldAt(16, D).name, 'idx');
  assert.strictEqual(wm.fieldAt(21, D).name, 'idx');
  assert.strictEqual(wm.fieldAt(22, D).name, 'total');
  assert.strictEqual(wm.fieldAt(27, D).name, 'total');
  assert.deepStrictEqual(wm.fieldAt(28, D), { name: 'data', byte: 0, bit: 0 });
  assert.deepStrictEqual(wm.fieldAt(37, D), { name: 'data', byte: 1, bit: 1 });
  assert.strictEqual(wm.fieldAt(28 + D * 8, D).name, 'crc');
  assert.strictEqual(wm.fieldAt(wm.blockBitsFor(D) - 1, D).name, 'crc');
});

test('placements と payloadOffset からペイロードの搬送位置を辿れる', async () => {
  // 鍵を指定しない場合は鍵ストリームが全 0 なので、搬送ビットがそのまま値になる
  const text = repeat(SAMPLE_JA, 30);
  const payload = wm.utf8Encode('ID:0042');
  const emb = await wm.embed(text, payload, {});
  const got = await wm.extract(emb.text, {});
  assert.ok(got.ok, got.reason || '抽出失敗');
  assert.ok(got.placements.length > 0, 'placements が空');
  assert.strictEqual(typeof got.payloadOffset, 'number');

  const bitsAt = (start, n) => {
    let v = 0;
    for (let k = 0; k < n; k++) v = (v << 1) | got.slots[start + k].vi;
    return v >>> 0;
  };

  // 各ブロックの先頭 16 bit が SYNC になっている
  for (const p of got.placements) {
    assert.strictEqual(bitsAt(p.bitStart, 16), 0xb4d2, `block ${p.idx} の SYNC が不一致`);
    assert.strictEqual(bitsAt(p.bitStart + 16, 6), p.idx, `block ${p.idx} の IDX が不一致`);
  }

  // 各ブロックの最初の出現位置を使ってペイロードを組み直す
  const first = new Map();
  for (const p of got.placements) if (!first.has(p.idx)) first.set(p.idx, p);
  for (let j = 0; j < payload.length; j++) {
    const off = got.payloadOffset + j;
    const p = first.get(Math.floor(off / got.dataBytes));
    assert.ok(p, `${j} バイト目のブロックが見つからない`);
    const at = p.bitStart + wm.HEADER_BITS + (off % got.dataBytes) * 8;
    assert.strictEqual(bitsAt(at, 8), payload[j], `${j} バイト目の搬送位置が不一致`);
  }
});

test('透かしが無ければ placements は空になる', async () => {
  const r = await wm.extract(repeat(SAMPLE_JA, 20), {});
  assert.ok(!r.ok);
  assert.deepStrictEqual(r.placements, []);
  assert.strictEqual(r.payloadOffset, null);
});

test('HEX ペイロード (任意バイト列) の往復', async () => {
  const payload = new Uint8Array([0x00, 0xff, 0x10, 0xde, 0xad, 0xbe, 0xef]);
  const text = repeat(SAMPLE_JA, 30);
  const emb = await wm.embed(text, payload, {});
  const got = await wm.extract(emb.text, {});
  assert.ok(got.ok, got.reason || '抽出失敗');
  assert.strictEqual(hex(got.payload), hex(payload));
});
