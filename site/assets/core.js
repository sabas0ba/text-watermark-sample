/*
 * core.js - 語選択による本文透かしの符号化・復号
 *
 * 方式概要
 *   1. 辞書に定義した相互置換可能な語のペアを本文から走査し、出現順に「スロット」とする。
 *   2. 各スロットは 1 bit を搬送する (variants[0] = 0, variants[1] = 1)。
 *   3. ペイロードは自己同期フレームへ符号化し、スロット列に巡回反復で書き込む。
 *
 * フレーム構成 (1 ブロック = 36 + 8*D bit)
 *   SYNC(16) | IDX(6) | TOTAL-1(6) | DATA(8*D) | CRC8(8)
 *
 *   ブロックは本文中に周期的に繰り返し配置される。復号側は全ビット位置で SYNC を探索し、
 *   CRC8 を通過したブロックのみ採用する。このため、
 *     - 本文の部分切り出し (先頭位置が不明) → SYNC 探索で再同期
 *     - 語の削除・挿入によるビット列のずれ → 次ブロックの SYNC で再同期
 *     - 一部ブロックの破損 → 別周期の同一 IDX ブロックで補完
 *   に耐える。
 *
 * ペイロード列 S = LEN(varint) | PAYLOAD | CRC16(2) を鍵ストリーム (SHA-256 CTR) で XOR
 * したのち D バイト単位に分割する。鍵が一致しない場合は CRC16 が不一致となり復号失敗となる。
 *
 * 全ブロックを回収するために必要な連続スロット数の上界は span = 周期長 + ブロック長 - 1。
 * DATA サイズ D は既定でこの span を最小化するよう選択する。
 */

const SYNC = 0xb4d2;
const SYNC_BITS = 16;
const IDX_BITS = 6;
const TOTAL_BITS = 6;
const CRC_BITS = 8;
const HEADER_BITS = SYNC_BITS + IDX_BITS + TOTAL_BITS; // 28
const MAX_BLOCKS = 1 << IDX_BITS; // 64
const DATA_BYTES_CANDIDATES = [2, 4, 8, 16, 32];

/* ------------------------------------------------------------------ */
/* 辞書のコンパイルと走査                                              */
/* ------------------------------------------------------------------ */

const EN_WORD_CHAR = /[A-Za-z0-9'’]/;
const PREV_WINDOW = 48;
const NEXT_WINDOW = 48;
const SENT_INIT_RE = /(?:[。．｡.!?！？\n\r]|[「『（(\[])[\s　]*$/;

function isAsciiLetter(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

/**
 * 有効な辞書グループから走査器を構築する。
 * @param {Array} dict     グループ定義の配列
 * @param {Object} options {tiers: string[], langs: string[], ids: string[]|null}
 */
function compileDict(dict, options) {
  const opt = options || {};
  const tiers = opt.tiers || ['A', 'B'];
  const langs = opt.langs || ['ja', 'en'];
  const idFilter = opt.ids ? new Set(opt.ids) : null;

  const groups = dict.filter(
    (g) =>
      Array.isArray(g.variants) &&
      g.variants.length === 2 &&
      tiers.indexOf(g.tier) >= 0 &&
      langs.indexOf(g.lang) >= 0 &&
      (!idFilter || idFilter.has(g.id))
  );

  const entries = [];
  groups.forEach((g, gi) => {
    const guards = g.guards || {};
    const compiled = {
      prevNot: guards.prevNot ? new RegExp(guards.prevNot) : null,
      prevMust: guards.prevMust ? new RegExp(guards.prevMust) : null,
      nextNot: guards.nextNot ? new RegExp(guards.nextNot) : null,
      sentInit: !!guards.sentInit,
    };
    g.variants.forEach((surface, vi) => {
      entries.push({
        surface,
        key: g.lang === 'en' ? surface.toLowerCase() : surface,
        gid: g.id,
        gindex: gi,
        vi,
        lang: g.lang,
        guards: compiled,
      });
    });
  });

  // 最長一致を保証するため長い表層形から試行する
  entries.sort((a, b) => b.surface.length - a.surface.length);

  const byFirst = new Map();
  for (const e of entries) {
    const c = e.key[0];
    if (!byFirst.has(c)) byFirst.set(c, []);
    byFirst.get(c).push(e);
  }

  return { groups, entries, byFirst };
}

function guardsOk(text, start, end, entry) {
  const g = entry.guards;

  if (entry.lang === 'en') {
    const prev = start > 0 ? text[start - 1] : '';
    const next = end < text.length ? text[end] : '';
    if (prev && EN_WORD_CHAR.test(prev)) return false;
    if (next && EN_WORD_CHAR.test(next)) return false;
  }

  if (g.prevNot || g.prevMust || g.sentInit) {
    const from = Math.max(0, start - PREV_WINDOW);
    const pre = text.slice(from, start);
    if (g.prevNot && g.prevNot.test(pre)) return false;
    if (g.prevMust && !g.prevMust.test(pre)) return false;
    if (g.sentInit) {
      const atDocStart = from === 0 && /^[\s　]*$/.test(pre);
      if (!atDocStart && !SENT_INIT_RE.test(pre)) return false;
    }
  }

  if (g.nextNot) {
    const post = text.slice(end, end + NEXT_WINDOW);
    if (g.nextNot.test(post)) return false;
  }

  return true;
}

/**
 * 本文を走査してスロット列を得る。位置は出現順、重なりなし。
 * @returns {Array<{start:number,end:number,gid:string,vi:number,surface:string,lang:string}>}
 */
function scanSlots(text, matcher) {
  const slots = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const key = isAsciiLetter(ch) ? ch.toLowerCase() : ch;
    const cands = matcher.byFirst.get(key);
    let hit = null;
    if (cands) {
      for (const e of cands) {
        const end = i + e.surface.length;
        if (end > text.length) continue;
        const seg = text.slice(i, end);
        const same = e.lang === 'en' ? seg.toLowerCase() === e.key : seg === e.surface;
        if (!same) continue;
        if (!guardsOk(text, i, end, e)) continue;
        hit = { entry: e, end };
        break;
      }
    }
    if (hit) {
      slots.push({
        start: i,
        end: hit.end,
        gid: hit.entry.gid,
        vi: hit.entry.vi,
        surface: text.slice(i, hit.end),
        lang: hit.entry.lang,
      });
      i = hit.end;
    } else {
      i += 1;
    }
  }
  return slots;
}

function restoreCase(original, target, lang) {
  if (lang !== 'en') return target;
  const hasLower = /[a-z]/.test(original);
  const hasUpper = /[A-Z]/.test(original);
  if (hasUpper && !hasLower && original.replace(/[^A-Za-z]/g, '').length > 1) {
    return target.toUpperCase();
  }
  if (original[0] === original[0].toUpperCase() && /[A-Za-z]/.test(original[0])) {
    return target[0].toUpperCase() + target.slice(1);
  }
  return target;
}

/** スロットに bits を書き込んだ本文を返す。bits[i] が未定義のスロットは原文のまま。 */
function applyBits(text, slots, bits, dictById) {
  const out = [];
  let cursor = 0;
  slots.forEach((s, i) => {
    out.push(text.slice(cursor, s.start));
    const bit = bits[i];
    if (bit === undefined || bit === null) {
      out.push(s.surface);
    } else {
      const group = dictById.get(s.gid);
      const target = group.variants[bit];
      out.push(restoreCase(s.surface, target, s.lang));
    }
    cursor = s.end;
  });
  out.push(text.slice(cursor));
  return out.join('');
}

/* ------------------------------------------------------------------ */
/* CRC / 鍵ストリーム                                                  */
/* ------------------------------------------------------------------ */

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const CRC8_TABLE = (() => {
  const t = new Uint8Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    t[n] = c;
  }
  return t;
})();

function crc8(bytes) {
  let c = 0;
  for (let i = 0; i < bytes.length; i++) c = CRC8_TABLE[c ^ bytes[i]];
  return c;
}

/** CRC-16/CCITT-FALSE。ペイロード全体の完全性と鍵一致の確認に用いる。 */
function crc16(bytes) {
  let c = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i] << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c & 0xffff;
}

/** 可変長整数 (7 bit ごと、MSB が継続フラグ)。 */
function varintEncode(n) {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
}

function varintDecode(bytes, offset) {
  let n = 0;
  let shift = 0;
  let i = offset;
  for (; i < bytes.length && i < offset + 4; i++) {
    n |= (bytes[i] & 0x7f) << shift;
    if (!(bytes[i] & 0x80)) return { value: n >>> 0, next: i + 1 };
    shift += 7;
  }
  return null;
}

function utf8Encode(str) {
  return new TextEncoder().encode(str);
}

function utf8Decode(bytes) {
  return new TextDecoder().decode(bytes);
}

/** SHA-256(key || "|" || counter) を連結した鍵ストリーム。key が空なら全 0。 */
async function keystream(key, nBytes) {
  const out = new Uint8Array(nBytes);
  if (!key) return out;
  const subtle = (globalThis.crypto && globalThis.crypto.subtle) || null;
  if (!subtle) throw new Error('WebCrypto (crypto.subtle) が利用できません');
  let off = 0;
  let ctr = 0;
  while (off < nBytes) {
    const src = utf8Encode(key + '|' + ctr);
    const digest = new Uint8Array(await subtle.digest('SHA-256', src));
    const n = Math.min(32, nBytes - off);
    out.set(digest.subarray(0, n), off);
    off += n;
    ctr += 1;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* フレーム符号化                                                      */
/* ------------------------------------------------------------------ */

function blockBitsFor(dataBytes) {
  return HEADER_BITS + dataBytes * 8 + CRC_BITS;
}

/**
 * ブロック先頭からのビット位置がどのフィールドに属するかを返す。
 * DATA の場合は何バイト目の何ビット目かも返す。
 * @returns {{name:'sync'|'idx'|'total'|'data'|'crc', byte?:number, bit?:number}}
 */
function fieldAt(offset, dataBytes) {
  if (offset < SYNC_BITS) return { name: 'sync' };
  if (offset < SYNC_BITS + IDX_BITS) return { name: 'idx' };
  if (offset < HEADER_BITS) return { name: 'total' };
  const d = offset - HEADER_BITS;
  if (d < dataBytes * 8) return { name: 'data', byte: d >> 3, bit: d & 7 };
  return { name: 'crc' };
}

function writeBits(arr, offset, value, nbits) {
  for (let k = nbits - 1; k >= 0; k--) arr[offset++] = (value >>> k) & 1;
  return offset;
}

function readBits(arr, offset, nbits) {
  let v = 0;
  for (let k = 0; k < nbits; k++) v = (v << 1) | arr[offset + k];
  return v >>> 0;
}

/**
 * DATA サイズの選択。
 *
 * 全ブロックを取得するために必要な連続スロット数の上界は
 *   span = 周期長 + ブロック長 - 1
 * である (周期の途中から切り出しても、どの IDX も必ず 1 回は完全に含まれる条件)。
 * 既定ではこの span を最小化する。'compact' では周期長のみを最小化する。
 */
function chooseDataBytes(streamLen, requested, mode) {
  if (requested && requested !== 'auto') return Number(requested);
  let best = null;
  for (const d of DATA_BYTES_CANDIDATES) {
    const nBlocks = Math.ceil(streamLen / d);
    if (nBlocks > MAX_BLOCKS) continue;
    const bb = blockBitsFor(d);
    const cost = mode === 'compact' ? nBlocks * bb : (nBlocks + 1) * bb;
    if (!best || cost < best.cost) best = { d, cost };
  }
  return best ? best.d : DATA_BYTES_CANDIDATES[DATA_BYTES_CANDIDATES.length - 1];
}

/** 鍵を用いずに、指定バイト長のペイロードに必要な周期長を見積もる。 */
function frameCost(payloadLen, dataBytesOpt, mode) {
  const streamLen = varintEncode(payloadLen).length + payloadLen + 2;
  const dataBytes = chooseDataBytes(streamLen, dataBytesOpt, mode);
  const nBlocks = Math.ceil(streamLen / dataBytes);
  return {
    streamLen,
    dataBytes,
    nBlocks,
    blockBits: blockBitsFor(dataBytes),
    periodBits: nBlocks * blockBitsFor(dataBytes),
    spanBits: (nBlocks + 1) * blockBitsFor(dataBytes) - 1,
    overflow: nBlocks > MAX_BLOCKS,
  };
}

/** ペイロードから 1 周期分のビット列を作る。 */
async function buildFrameBits(payload, key, dataBytesOpt) {
  if (payload.length > 0x1fffff) throw new Error('ペイロードが長すぎます');
  const lenBytes = varintEncode(payload.length);
  const head = new Uint8Array(lenBytes.length + payload.length);
  head.set(lenBytes, 0);
  head.set(payload, lenBytes.length);
  const sum = crc16(head);
  const stream = new Uint8Array(head.length + 2);
  stream.set(head, 0);
  stream[head.length] = (sum >>> 8) & 0xff;
  stream[head.length + 1] = sum & 0xff;

  const ks = await keystream(key, stream.length);
  for (let i = 0; i < stream.length; i++) stream[i] ^= ks[i];

  const dataBytes = chooseDataBytes(stream.length, dataBytesOpt);
  const nBlocks = Math.ceil(stream.length / dataBytes);
  if (nBlocks > MAX_BLOCKS) {
    throw new Error(
      `ブロック数が上限を超えました (${nBlocks} > ${MAX_BLOCKS})。DATA サイズを大きくしてください`
    );
  }
  const padded = new Uint8Array(nBlocks * dataBytes);
  padded.set(stream, 0);

  const bb = blockBitsFor(dataBytes);
  const bits = new Uint8Array(nBlocks * bb);
  let off = 0;
  for (let b = 0; b < nBlocks; b++) {
    const data = padded.subarray(b * dataBytes, (b + 1) * dataBytes);
    const chk = new Uint8Array(2 + dataBytes);
    chk[0] = b;
    chk[1] = nBlocks - 1;
    chk.set(data, 2);
    off = writeBits(bits, off, SYNC, SYNC_BITS);
    off = writeBits(bits, off, b, IDX_BITS);
    off = writeBits(bits, off, nBlocks - 1, TOTAL_BITS);
    for (let i = 0; i < dataBytes; i++) off = writeBits(bits, off, data[i], 8);
    off = writeBits(bits, off, crc8(chk), CRC_BITS);
  }
  return { bits, nBlocks, dataBytes, blockBits: bb, streamLen: stream.length };
}

/**
 * 抽出ビット列から特定 DATA サイズを仮定してブロックを収集する。
 * 各候補には検出されたビット位置 (positions) を記録する。復号後に、
 * どのビット — ひいては本文中のどの語 — が何を搬送していたかを辿るために使う。
 */
function collectBlocks(bits, dataBytes) {
  const bb = blockBitsFor(dataBytes);
  const found = new Map(); // idx -> Map(hex -> {count, data, total, positions})
  const totals = new Map();
  for (let p = 0; p + bb <= bits.length; p++) {
    if (readBits(bits, p, SYNC_BITS) !== SYNC) continue;
    const idx = readBits(bits, p + SYNC_BITS, IDX_BITS);
    const tot = readBits(bits, p + SYNC_BITS + IDX_BITS, TOTAL_BITS);
    if (idx > tot) continue;
    const data = new Uint8Array(dataBytes);
    for (let i = 0; i < dataBytes; i++) data[i] = readBits(bits, p + HEADER_BITS + i * 8, 8);
    const chk = new Uint8Array(2 + dataBytes);
    chk[0] = idx;
    chk[1] = tot;
    chk.set(data, 2);
    if (crc8(chk) !== readBits(bits, p + HEADER_BITS + dataBytes * 8, CRC_BITS)) continue;

    totals.set(tot, (totals.get(tot) || 0) + 1);
    if (!found.has(idx)) found.set(idx, new Map());
    const bucket = found.get(idx);
    const hex = tot + ':' + Array.from(data).join(',');
    if (!bucket.has(hex)) bucket.set(hex, { count: 0, data, total: tot, positions: [] });
    const v = bucket.get(hex);
    v.count += 1;
    v.positions.push(p);
  }
  return { found, totals, blockBits: bb };
}

/** ビット列を復号する。DATA サイズが未指定なら候補を総当たりする。 */
async function decodeBits(bits, key, dataBytesOpt) {
  const candidates =
    dataBytesOpt && dataBytesOpt !== 'auto' ? [Number(dataBytesOpt)] : DATA_BYTES_CANDIDATES;
  let best = null;

  for (const dataBytes of candidates) {
    const { found, totals, blockBits } = collectBlocks(bits, dataBytes);
    if (totals.size === 0) continue;
    let bestTotal = -1;
    let bestCount = -1;
    for (const [t, c] of totals) {
      if (c > bestCount) {
        bestCount = c;
        bestTotal = t;
      }
    }
    const nBlocks = bestTotal + 1;
    const present = [];
    const parts = [];
    const placements = [];
    let complete = true;
    for (let i = 0; i < nBlocks; i++) {
      const bucket = found.get(i);
      let pick = null;
      if (bucket) {
        for (const v of bucket.values()) {
          if (v.total !== bestTotal) continue;
          if (!pick || v.count > pick.count) pick = v;
        }
      }
      if (pick) {
        present.push(i);
        parts.push(pick.data);
        pick.positions.forEach((p, k) => {
          placements.push({ idx: i, bitStart: p, primary: k === 0, occurrences: pick.positions.length });
        });
      } else {
        complete = false;
        parts.push(new Uint8Array(dataBytes));
      }
    }
    placements.sort((a, b) => a.bitStart - b.bitStart);

    const result = {
      ok: false,
      dataBytes,
      blockBits,
      blocksTotal: nBlocks,
      blocksFound: present.length,
      presentIndices: present,
      placements,
      payload: null,
      payloadOffset: null,
      reason: complete ? null : '一部ブロックが未検出',
    };

    if (complete) {
      const merged = new Uint8Array(nBlocks * dataBytes);
      parts.forEach((d, i) => merged.set(d, i * dataBytes));
      const ks = await keystream(key, merged.length);
      for (let i = 0; i < merged.length; i++) merged[i] ^= ks[i];
      const lv = varintDecode(merged, 0);
      if (lv && lv.next + lv.value + 2 <= merged.length) {
        const end = lv.next + lv.value;
        const head = merged.subarray(0, end);
        const got = (merged[end] << 8) | merged[end + 1];
        if (crc16(head) === got) {
          result.ok = true;
          result.payload = merged.slice(lv.next, end);
          // 結合後のバイト列におけるペイロード先頭位置。placements と併せると、
          // ペイロードの各バイトがどのブロックのどのビットに載っていたかを特定できる。
          result.payloadOffset = lv.next;
          result.reason = null;
        } else {
          result.reason = 'CRC16 不一致 (鍵の相違またはデータ破損)';
        }
      } else {
        result.reason = '長さフィールドが不正 (鍵の相違が疑われます)';
      }
    }

    if (!best || result.ok > best.ok || (result.ok === best.ok && result.blocksFound > best.blocksFound)) {
      best = result;
    }
    if (result.ok) break;
  }

  return (
    best || {
      ok: false,
      dataBytes: null,
      blocksTotal: 0,
      blocksFound: 0,
      presentIndices: [],
      placements: [],
      payload: null,
      payloadOffset: null,
      reason: '同期パターンを検出できませんでした',
    }
  );
}

/* ------------------------------------------------------------------ */
/* 公開 API                                                            */
/* ------------------------------------------------------------------ */

function dictIndex(dict) {
  const m = new Map();
  for (const g of dict) m.set(g.id, g);
  return m;
}

/** 既定辞書の解決 (ブラウザでは同一スクリプトの DEFAULT_DICT、Node では dict.js)。 */
function defaultDict() {
  if (typeof DEFAULT_DICT !== 'undefined' && DEFAULT_DICT) return DEFAULT_DICT;
  if (typeof module !== 'undefined' && module.exports) {
    return require('./dict.js').DEFAULT_DICT;
  }
  return [];
}

/**
 * 本文に透かしを埋め込む。
 * @param {string} text
 * @param {Uint8Array} payload
 * @param {Object} opts {dict, tiers, langs, key, dataBytes}
 */
async function embed(text, payload, opts) {
  const o = opts || {};
  const dict = o.dict || defaultDict();
  const matcher = compileDict(dict, o);
  const slots = scanSlots(text, matcher);

  // DATA サイズの自動選択。周期が短いほど切り出しに強く、ブロックが短いほど
  // 散発的な削除に強い。容量に 2 周期以上の余裕がある最小の DATA サイズを選び、
  // 余裕がなければ周期最小の構成にフォールバックする。
  let dataBytes = o.dataBytes;
  if (!dataBytes || dataBytes === 'auto') {
    const streamLen = varintEncode(payload.length).length + payload.length + 2;
    dataBytes = chooseDataBytes(streamLen, null, o.profile || 'span');
  }

  const frame = await buildFrameBits(payload, o.key || '', dataBytes);

  const capacity = slots.length;
  const period = frame.bits.length;
  const cycles = period > 0 ? capacity / period : 0;

  const bits = new Array(capacity);
  for (let i = 0; i < capacity; i++) bits[i] = frame.bits[i % period];

  const output = applyBits(text, slots, bits, dictIndex(dict));

  // 埋め込み後の再走査で、置換によりスロット構成が変化していないかを検証する
  const reslots = scanSlots(output, matcher);
  const stable =
    reslots.length === slots.length && reslots.every((s, i) => s.gid === slots[i].gid);
  const mismatches = [];
  if (!stable) {
    const n = Math.min(reslots.length, slots.length);
    for (let i = 0; i < n; i++) if (reslots[i].gid !== slots[i].gid) mismatches.push(i);
  }

  return {
    text: output,
    slots,
    capacityBits: capacity,
    periodBits: period,
    cycles,
    blocks: frame.nBlocks,
    dataBytes: frame.dataBytes,
    blockBits: frame.blockBits,
    spanBits: frame.nBlocks * frame.blockBits + frame.blockBits - 1,
    sufficient: cycles >= 1,
    stable,
    mismatches,
    changed: slots.reduce((acc, s, i) => acc + (bits[i] !== undefined && bits[i] !== s.vi ? 1 : 0), 0),
  };
}

/**
 * 本文から透かしを抽出する。
 * @param {string} text
 * @param {Object} opts {dict, tiers, langs, key, dataBytes}
 */
async function extract(text, opts) {
  const o = opts || {};
  const dict = o.dict || defaultDict();
  const matcher = compileDict(dict, o);
  const slots = scanSlots(text, matcher);
  const bits = new Uint8Array(slots.length);
  slots.forEach((s, i) => {
    bits[i] = s.vi;
  });
  const res = await decodeBits(bits, o.key || '', o.dataBytes);
  res.slotCount = slots.length;
  res.slots = slots;
  return res;
}

/** 本文の搬送容量を調べる。 */
function analyze(text, opts) {
  const o = opts || {};
  const dict = o.dict || defaultDict();
  const matcher = compileDict(dict, o);
  const slots = scanSlots(text, matcher);
  const perGroup = new Map();
  for (const s of slots) perGroup.set(s.gid, (perGroup.get(s.gid) || 0) + 1);
  return { slots, capacityBits: slots.length, perGroup };
}

/**
 * 辞書整合性チェック。無作為なビット割り当てで往復し、
 * 置換が別グループの一致を誘発しないことを確認する。
 */
async function checkDictConsistency(text, opts, trials, rng) {
  const o = opts || {};
  const dict = o.dict || defaultDict();
  const matcher = compileDict(dict, o);
  const byId = dictIndex(dict);
  const slots = scanSlots(text, matcher);
  const n = slots.length;
  const rand = rng || Math.random;
  const failures = [];
  const t = trials || 64;
  for (let k = 0; k < t; k++) {
    const bits = new Array(n);
    for (let i = 0; i < n; i++) bits[i] = rand() < 0.5 ? 0 : 1;
    const out = applyBits(text, slots, bits, byId);
    const re = scanSlots(out, matcher);
    if (re.length !== n) {
      failures.push({ trial: k, reason: `スロット数不一致 ${re.length} != ${n}` });
      continue;
    }
    for (let i = 0; i < n; i++) {
      if (re[i].gid !== slots[i].gid || re[i].vi !== bits[i]) {
        failures.push({
          trial: k,
          reason: `スロット ${i} 不一致 (${slots[i].gid} -> ${re[i].gid})`,
          slot: slots[i],
        });
        break;
      }
    }
  }
  return { trials: t, slotCount: n, failures, ok: failures.length === 0 };
}

const API = {
  get DEFAULT_DICT() {
    return defaultDict();
  },
  compileDict,
  scanSlots,
  applyBits,
  analyze,
  embed,
  extract,
  decodeBits,
  buildFrameBits,
  checkDictConsistency,
  crc32,
  crc16,
  crc8,
  frameCost,
  utf8Encode,
  utf8Decode,
  blockBitsFor,
  fieldAt,
  MAX_BLOCKS,
  DATA_BYTES_CANDIDATES,
  SYNC_BITS,
  IDX_BITS,
  TOTAL_BITS,
  CRC_BITS,
  HEADER_BITS,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = API;
} else {
  globalThis.TextWatermark = API;
}
