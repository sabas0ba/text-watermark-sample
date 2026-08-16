/*
 * browser.test.js - GET パラメータ (クエリ文字列) の動作確認
 *
 * site/ を一時サーバで配信し、Chromium で実際に読み込んで検証する。
 * Playwright かブラウザ本体が無い環境ではスキップする。
 *
 *   node --test test/browser.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'site');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

let chromium = null;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  /* Playwright 未導入 */
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let file = path.join(ROOT, decodeURIComponent(url.pathname));
    if (url.pathname.endsWith('/')) file = path.join(file, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url');

// URL に載せる都合上、スロット密度の高い短めの本文を使う (base64url で約 6 KB)。
const SAMPLE =
  '本件の設定はすべて確認できるため、あらかじめログを参照することでおおむね原因を特定できます。' +
  'ただし、異常が発生したときはただちに報告してください。';
const TEXT = Array.from({ length: 20 }, () => SAMPLE).join('');

test('GET パラメータ', { skip: chromium ? false : 'playwright が利用できません' }, async (t) => {
  // 取得先はローカルの一時サーバのみなので、環境のプロキシ設定は無効化する。
  // CHROMIUM_PATH を指定すると Playwright 同梱版ではなくその実行ファイルを使う。
  const launchOpts = { args: ['--no-proxy-server'] };
  if (process.env.CHROMIUM_PATH) launchOpts.executablePath = process.env.CHROMIUM_PATH;
  let browser;
  try {
    browser = await chromium.launch(launchOpts);
  } catch (e) {
    t.skip('Chromium を起動できません: ' + e.message.split('\n')[0]);
    return;
  }
  const { server, port } = await startServer();
  const base = `http://127.0.0.1:${port}/index.html`;
  const page = await browser.newPage();
  const open = async (query) => {
    await page.goto(base + query);
    await page.waitForFunction(() => document.documentElement.dataset.result || window.__ready === true);
  };
  const result = () => page.textContent('#result');

  t.after(async () => {
    await browser.close();
    server.close();
  });

  await t.test('output=text で埋め込み結果の本文だけを返す', async () => {
    await open(`?text64=${b64url(TEXT)}&payload=ID:0042&run=embed&output=text`);
    const out = await result();
    assert.ok(out.length > 0);
    assert.notStrictEqual(out, TEXT, '本文が変化していない');
    assert.ok(!out.startsWith('ERROR'), out.slice(0, 200));
  });

  await t.test('output=json で統計込みの結果を返す', async () => {
    await open(`?text64=${b64url(TEXT)}&payload=ID:0042&run=embed&output=json`);
    const json = JSON.parse(await result());
    assert.strictEqual(json.action, 'embed');
    assert.strictEqual(json.ok, true);
    assert.ok(json.capacityBits > json.periodBits);
    assert.ok(json.changed > 0);
  });

  await t.test('埋め込み → 抽出の往復', async () => {
    await open(`?text64=${b64url(TEXT)}&payload=ID:0042&run=embed&output=text`);
    const marked = await result();
    await open(`?text64=${b64url(marked)}&run=extract&output=json`);
    const json = JSON.parse(await result());
    assert.strictEqual(json.ok, true);
    assert.strictEqual(json.payloadText, 'ID:0042');
  });

  await t.test('鍵つきの往復と誤鍵の拒否', async () => {
    await open(`?text64=${b64url(TEXT)}&payload=s3cret&key=k1&run=embed&output=text`);
    const marked = await result();

    await open(`?text64=${b64url(marked)}&key=k1&run=extract&output=json`);
    assert.strictEqual(JSON.parse(await result()).payloadText, 's3cret');

    await open(`?text64=${b64url(marked)}&key=k2&run=extract&output=json`);
    assert.strictEqual(JSON.parse(await result()).ok, false);
  });

  await t.test('pmode=hex で任意バイト列を指定できる', async () => {
    await open(`?text64=${b64url(TEXT)}&payload=deadbeef&pmode=hex&run=embed&output=text`);
    const marked = await result();
    await open(`?text64=${b64url(marked)}&run=extract&output=json`);
    const json = JSON.parse(await result());
    assert.strictEqual(json.payloadHex, 'deadbeef');
  });

  await t.test('payload64 / text (非 base64) も受け付ける', async () => {
    await open(`?text=${encodeURIComponent(TEXT)}&payload64=${b64url('ID:9')}&run=embed&output=text`);
    const marked = await result();
    await open(`?text64=${b64url(marked)}&run=extract&output=json`);
    assert.strictEqual(JSON.parse(await result()).payloadText, 'ID:9');
  });

  await t.test('容量不足は ok:false として報告される', async () => {
    await open(`?text=${encodeURIComponent('できる。')}&payload=ID:0042&run=embed&output=json`);
    const json = JSON.parse(await result());
    assert.strictEqual(json.ok, false);
    assert.strictEqual(json.sufficient, false);
  });

  await t.test('UI モードでも run と tab が効く', async () => {
    await page.goto(`${base}?text64=${b64url(TEXT)}&payload=ID:0042&run=embed`);
    await page.waitForFunction(() => document.getElementById('out').value.length > 0);
    assert.ok((await page.inputValue('#out')).length > 0);
    assert.strictEqual(await page.getAttribute('#embed', 'hidden'), null);

    await page.goto(`${base}?tab=dict`);
    await page.waitForFunction(() => document.getElementById('dictJson').value.length > 0);
    assert.strictEqual(await page.getAttribute('#dict', 'hidden'), null);
    assert.strictEqual(await page.getAttribute('#embed', 'hidden'), '');
  });

  await t.test('tiers / langs / data を指定できる', async () => {
    await page.goto(`${base}?tiers=A&langs=ja&data=8&profile=compact`);
    await page.waitForFunction(() => window.__ready === true);
    assert.deepStrictEqual(
      await page.$$eval('.tier:checked', (els) => els.map((e) => e.value)),
      ['A']
    );
    assert.deepStrictEqual(
      await page.$$eval('.lang:checked', (els) => els.map((e) => e.value)),
      ['ja']
    );
    assert.strictEqual(await page.inputValue('#dbytes'), '8');
    assert.strictEqual(await page.inputValue('#profile'), 'compact');
  });

  await t.test('埋め込み結果を変更前後の差分として表示できる', async () => {
    await page.goto(`${base}?text64=${b64url(TEXT)}&payload=ID:0042&run=embed`);
    await page.waitForFunction(() => document.getElementById('out').value.length > 0);

    // 既定は併記モード。変更された語は del + ins の対で出る。
    const dels = await page.$$eval('#outHl del.wm', (e) => e.length);
    const ins = await page.$$eval('#outHl ins.wm', (e) => e.length);
    assert.ok(dels > 0, '変更前の語が表示されていない');
    assert.strictEqual(dels, ins);

    // 抜き出しモードでは、文脈の重複なく変更箇所だけが残る
    await page.check('#diffOnly');
    const excerpt = await page.textContent('#outHl');
    const full = await page.inputValue('#out');
    assert.ok(excerpt.includes('…'), '省略記号が出ていない');
    assert.ok(excerpt.length < full.length, '抜き出しても短くなっていない');

    // ビット色分けは全スロットを塗る
    await page.uncheck('#diffOnly');
    await page.selectOption('#diffMode', 'bits');
    const painted = await page.$$eval('#outHl span.bit0, #outHl span.bit1', (e) => e.length);
    assert.strictEqual(painted, 220, 'スロット数と塗られた語の数が一致しない');
  });

  await t.test('抽出結果にペイロードの搬送位置が図示される', async () => {
    await open(`?text64=${b64url(TEXT)}&payload=ID:0042&run=embed&output=text`);
    const marked = await result();

    await page.goto(`${base}?tab=extract`);
    await page.waitForFunction(() => window.__ready === true);
    await page.fill('#exsrc', marked);
    await page.click('#doExtract');
    await page.waitForFunction(() => !document.getElementById('exBytesBox').hidden);

    // フレーム上の役割ごとに色分けされた本文
    assert.strictEqual(await page.getAttribute('#exMapBox', 'hidden'), null);
    const data = await page.$$eval('#exMap span.f-data', (e) => e.length);
    const sync = await page.$$eval('#exMap span.f-sync', (e) => e.length);
    assert.ok(data > 0 && sync > 0, 'DATA / SYNC の色分けが出ていない');

    // ペイロード 7 バイトぶんの行 (+ 見出し行)
    const rows = await page.$$eval('#exBytes tr', (e) => e.length);
    assert.strictEqual(rows, 8);
    const table = await page.textContent('#exBytes');
    assert.match(table, /ID:0042/);
    assert.match(table, /DATA\[/);

    // ブロックの検出状況
    assert.strictEqual(await page.getAttribute('#exFrameBox', 'hidden'), null);
    assert.strictEqual(await page.$$eval('#exBlocks i.hit', (e) => e.length), 3);
  });

  await t.test('不正な値はエラーとして表示され、既定値で動作を続ける', async () => {
    await page.goto(`${base}?data=7&output=bogus`);
    await page.waitForFunction(() => window.__ready === true);
    const text = await page.textContent('#paramMsg');
    assert.match(text, /data/);
    assert.match(text, /output/);
    assert.strictEqual(await page.inputValue('#dbytes'), 'auto');
  });
});
