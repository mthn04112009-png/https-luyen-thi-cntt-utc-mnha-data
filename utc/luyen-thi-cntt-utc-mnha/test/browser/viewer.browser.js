const { chromium } = require('playwright');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const http = require('http'), fs = require('fs'), path = require('path');
// Test trình duyệt (cần: playwright + chromium, pdf-lib, pdfjs-dist, jszip, python-pptx):
//   python3 test/browser/make_test_deck.py        → tạo test/browser/deck.pptx (có chuyển cảnh + hiệu ứng)
//   node test/browser/viewer.browser.js           → mở trang xem trong Chromium thật và kiểm tra
const APP = path.join(__dirname, '..', '..');
const NM = process.env.NODE_MODULES_DIR || '/home/claude/.npm-global/lib/node_modules';
const DECK = path.join(__dirname, 'deck.pptx');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error('  ✗', m); } else console.log('  ✓', m); };

(async () => {
  // ---- tệp thử ----
  const doc = await PDFDocument.create(); const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 30; i++) { const land = i % 3 === 0; const p = doc.addPage(land ? [842, 595] : [612, 792]); p.drawText('Trang ' + i + (land ? ' (ngang)' : ' (dọc)').replace(/[^\x00-\x7f]/g, 'o'), { x: 60, y: land ? 500 : 700, size: 36, font, color: rgb(0.1, 0.2, 0.6) }); }
  const pdfBytes = Buffer.from(await doc.save());
  const pptxBytes = fs.readFileSync(DECK);
  const files = { pdf: pdfBytes, pptx: pptxBytes, ppt: Buffer.from('x') };

  const CH = 2000;                                           // phần nhỏ để thử việc ghép
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (p, type) => { res.writeHead(200, { 'Content-Type': type }); res.end(fs.readFileSync(p)); };
    if (u.pathname === '/js/studyFileViewer.js') return send(APP + '/public/js/studyFileViewer.js', 'text/javascript');
    if (u.pathname === '/js/pptxPlayer.js') return send(APP + '/public/js/pptxPlayer.js', 'text/javascript');
    if (u.pathname === '/css/studyfiles.css') return send(APP + '/public/css/studyfiles.css', 'text/css');
    if (u.pathname === '/lib/jszip.min.js') return send(process.env.JSZIP_PATH || NM + '/pptxgenjs/node_modules/jszip/dist/jszip.min.js', 'text/javascript');
    if (u.pathname === '/lib/pdf.min.mjs') return send(NM + '/pdfjs-dist/build/pdf.min.mjs', 'text/javascript');
    if (u.pathname === '/lib/pdf.worker.min.mjs') return send(NM + '/pdfjs-dist/build/pdf.worker.min.mjs', 'text/javascript');
    const m = u.pathname.match(/^\/file\/(pdf|pptx)$/);
    if (m) {
      const b = files[m[1]], i = Number(u.searchParams.get('chunk') || 0), n = Math.ceil(b.length / CH);
      if (i >= n) { res.writeHead(400); return res.end('bad'); }
      const part = b.subarray(i * CH, (i + 1) * CH);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Chunk-Count': String(n), 'X-Total-Size': String(b.length), 'Content-Length': part.length });
      return res.end(part);
    }
    if (u.pathname === '/study') {
      const ext = u.searchParams.get('ext'), viewer = u.searchParams.get('viewer');
      const D = { id: 'x', title: 'Thử', ext, viewer, size: ext === 'pdf' ? pdfBytes.length : files[ext].length, fileName: 'thu.' + ext, fileUrl: '/file/' + ext, downloadUrl: '/file/' + ext + '?download=1' };
      if (u.searchParams.get('big')) D.size = 5e6;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<!doctype html><html><head><meta charset=utf-8><link rel=stylesheet href=/css/studyfiles.css></head><body style="margin:0">
      <div class="sl"><div class="sl-top"><div class="sl-head"><h1>Thử</h1></div><div class="sl-tools"><a id="slDownload" href="${D.downloadUrl}" class="sl-btn sl-btn-pri" download="${D.fileName}"><span>Tải xuống</span></a></div></div>
      <div class="sl-grid"><nav class="sl-units"></nav><div class="sl-pane" id="slPane"><div class="sl-loading" id="slLoading">Đang tải…</div></div></div></div>
      <script id="slData" type="application/json">${JSON.stringify(D)}</script>
      <script>window.__STUDYFILE_URLS__={pdfjsWorker:'/lib/pdf.worker.min.mjs',jszip:'/lib/jszip.min.js',pptx:'/js/pptxPlayer.js'};</script>
      <script type="module">import * as p from '/lib/pdf.min.mjs'; window.pdfjsLib = p; const s=document.createElement('script'); s.src='/js/studyFileViewer.js'; document.body.appendChild(s);</script></body></html>`);
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, r)); const base = 'http://localhost:' + server.address().port;

  const browser = await chromium.launch();
  async function open(q, vp) {
    const page = await browser.newPage({ viewport: vp || { width: 1100, height: 900 }, acceptDownloads: true });
    await page.addInitScript(() => { for (const C of [Map, WeakMap]) { if (!C.prototype.getOrInsertComputed) C.prototype.getOrInsertComputed = function (k, f) { if (!this.has(k)) this.set(k, f(k)); return this.get(k); }; if (!C.prototype.getOrInsert) C.prototype.getOrInsert = function (k, v) { if (!this.has(k)) this.set(k, v); return this.get(k); }; } });  // pdfjs-dist 5.x (chỉ dùng để test) cần API mới
    page.errors = []; page.on('pageerror', (e) => { page.errors.push(e.message); console.log('PAGEERR', e.message); });
    page.on('console', (m) => { if (m.type() === 'error' || m.type()==='warning') { page.errors.push(m.text()); console.log('CONSOLE', m.type(), m.text().slice(0,300)); } });
    await page.goto(base + '/study?' + q); return page;
  }

  console.log('A) Tài liệu PDF — cuộn liên tục, ngang/dọc, zoom');
  let page = await open('ext=pdf&viewer=document');
  await page.waitForTimeout(1500); if (0) console.log('DBG', await page.evaluate(() => ({ pane: document.getElementById('slPane').innerHTML.slice(0, 400), sv: !!window.__scrollViewer, pdf: typeof window.pdfjsLib, n: document.querySelectorAll('.sl-pagebox').length, c: document.querySelectorAll('.sl-pagebox canvas').length, w: Array.from(document.querySelectorAll('.sl-pagebox')).slice(0,2).map(b=>[b.offsetWidth,b.offsetHeight]) })));
  await page.waitForSelector('.sl-pagebox canvas', { timeout: 15000 });
  let info = await page.evaluate(() => { const b = window.__scrollViewer.pages().slice(1); return { n: b.length, sizes: b.slice(0, 6).map((x) => [x.offsetWidth, x.offsetHeight]), canv: b.filter((x) => x.querySelector('canvas')).length }; });
  ok(info.n === 30, '30 trang');
  await page.waitForTimeout(600);
  info = await page.evaluate(() => { const b = window.__scrollViewer.pages().slice(1); return { sizes: b.slice(0, 6).map((x) => [x.offsetWidth, x.offsetHeight]), canv: b.filter((x) => x.querySelector('canvas')).length }; });
  const [p1, , p3] = info.sizes; ok(p1[1] > p1[0] && p3[0] > p3[1], `trang 1 dọc (${p1}), trang 3 ngang (${p3})`);
  ok(Math.abs(p3[0] / p3[1] - 842 / 595) < 0.02 && Math.abs(p1[0] / p1[1] - 612 / 792) < 0.02, 'đúng tỉ lệ khổ giấy từng trang');
  ok(info.canv >= 2 && info.canv < 30, `render lười: ${info.canv}/30 trang đã vẽ`);
  await page.screenshot({ path: 'v_doc.png' });
  const w0 = info.sizes[0][0];
  await page.click('#slZoomIn'); await page.waitForTimeout(400);
  const w1 = await page.evaluate(() => window.__scrollViewer.pages()[1].offsetWidth);
  ok(Math.abs(w1 / w0 - 1.25) < 0.03, `phóng to ×1.25 (${w0}→${w1})`);
  const hs = await page.evaluate(() => { const s = document.querySelector('.sl-stage'); return s.scrollWidth > s.clientWidth; });
  ok(hs, 'zoom lớn → cuộn ngang được');
  await page.click('#slZoomReset'); await page.waitForTimeout(300);
  await page.evaluate(() => window.__scrollViewer.go(20)); await page.waitForTimeout(700);
  const st = await page.evaluate(() => ({ v: document.getElementById('slPageNo').value, c: !!window.__scrollViewer.pages()[20].querySelector('canvas'), far: !!window.__scrollViewer.pages()[1].querySelector('canvas') }));
  ok(st.v === '20' && st.c, 'nhảy tới trang 20 → trang đó được vẽ');
  ok(!st.far, 'trang 1 ở xa đã được giải phóng canvas');
  await page.evaluate(() => document.querySelector('.sl-stage').scrollBy(0, 1500)); await page.waitForTimeout(400);
  const cur = await page.evaluate(() => Number(document.getElementById('slPageNo').value)); ok(cur > 20, `lướt xuống → số trang cập nhật (${cur})`);
  await page.screenshot({ path: 'v_doc2.png' });
  await page.setViewportSize({ width: 600, height: 800 }); await page.waitForTimeout(500);
  const wn = await page.evaluate(() => window.__scrollViewer.pages()[1].offsetWidth); ok(wn < 600, `thu nhỏ cửa sổ → trang co lại vừa chiều rộng (${wn}px)`);
  ok(page.errors.length === 0, 'không lỗi JS ' + JSON.stringify(page.errors)); await page.close();

  console.log('B) Slide PDF — từng trang');
  page = await open('ext=pdf&viewer=slides'); await page.waitForSelector('.sl-stage canvas', { timeout: 15000 });
  await page.waitForTimeout(500);
  await page.click('#slNext'); await page.waitForTimeout(500);
  ok((await page.inputValue('#slPageNo')) === '2', 'bấm ▶ sang trang 2');
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.waitForTimeout(600);
  ok((await page.inputValue('#slPageNo')) === '4', 'phím → sang trang 4');
  const cw = await page.evaluate(() => { const c = document.querySelector('.sl-stage canvas'); return [c.width > 0, parseInt(c.style.width) < parseInt(c.style.height)]; });
  ok(cw[0] && cw[1], 'trang 4 (dọc) đã vẽ đúng khổ dọc');
  await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(500);
  const cw3 = await page.evaluate(() => { const c = document.querySelector('.sl-stage canvas'); return parseInt(c.style.width) > parseInt(c.style.height); });
  ok(cw3, 'lùi về trang 3 → khổ ngang');
  ok(page.errors.length === 0, 'không lỗi JS ' + JSON.stringify(page.errors)); await page.close();

  console.log('C) Slide PPTX — trình chiếu + hiệu ứng');
  page = await open('ext=pptx&viewer=slides', { width: 1100, height: 900 }); await page.waitForSelector('.pp-slide', { timeout: 15000 });
  ok((await page.textContent('.sl-page')).includes('/ 4'), 'đọc được 4 slide');
  await page.click('.sl-stage'); await page.waitForTimeout(1200);          // click = tới slide 2 (có chuyển cảnh push)
  ok((await page.inputValue('#slPageNo')) === '2', 'click → slide 2 (chuyển cảnh)');
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(1300);
  ok((await page.inputValue('#slPageNo')) === '3', 'phím → slide 3');
  ok((await page.textContent('#slStat')).includes('0/5'), 'hiển thị số bước hiệu ứng: ' + (await page.textContent('#slStat')));
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(700);
  ok((await page.textContent('#slStat')).includes('1/5'), 'bấm → chạy hiệu ứng bước 1');
  ok(await page.evaluate(() => !!document.getElementById('slAuto')), 'có nút ⏱ Tự chuyển (file có advTm)');
  await page.screenshot({ path: 'v_pptx.png' });
  ok(page.errors.length === 0, 'không lỗi JS ' + JSON.stringify(page.errors)); await page.close();

  console.log('D) Slide PPT cũ');
  page = await open('ext=ppt&viewer=slides'); await page.waitForSelector('.sl-unsupported');
  ok((await page.textContent('.sl-unsupported')).includes('.pptx'), 'hiện hướng dẫn tải xuống / chuyển .pptx'); await page.close();

  console.log('E) Tải xuống file lớn theo phần');
  page = await open('ext=pdf&viewer=document&big=1'); await page.waitForSelector('.sl-pagebox');
  const dlp = page.waitForEvent('download'); await page.click('#slDownload'); const dl = await dlp;
  const got = fs.readFileSync(await dl.path());
  ok(got.equals(pdfBytes), `tải xuống ghép ${Math.ceil(pdfBytes.length / CH)} phần = file gốc (${got.length} byte)`);
  ok(dl.suggestedFilename() === 'thu.pdf', 'tên file: ' + dl.suggestedFilename()); await page.close();

  await browser.close(); server.close();
  console.log(fails ? `\n${fails} LỖI` : '\nTất cả đạt'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
