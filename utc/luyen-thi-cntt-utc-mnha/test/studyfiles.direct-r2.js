// Test: up THẲNG lên Cloudflare R2 — direct-init cấp URL PUT ký sẵn → "trình duyệt" (public/js/studyFileForm.js) mã hoá + ghép file-phần + PUT
//       → direct-done kiểm HEAD/header/giải thử khung 0 → chữ ký (thêm 'r2') → checkFile nhận → đọc/giải mã lại. Từ chối: thiếu phần, sai kích thước, sai khoá, khai man store.
// Chạy: node test/studyfiles.direct-r2.js  (không cần Mongo/GitHub/R2 thật: thư viện ngoài + fetch được giả lập)
process.env.ENCRYPTION_MASTER_KEY = 'cd'.repeat(32);
process.env.R2_ACCOUNT_ID = 'acc'; process.env.R2_BUCKET = 'bk'; process.env.R2_ACCESS_KEY_ID = 'AKID'; process.env.R2_SECRET_ACCESS_KEY = 'SECRET';
const Module = require('module'), assert = require('assert'), crypto = require('crypto');
const stub = () => new Proxy(function () { }, { get: (t, k) => (k === '__esModule' ? false : stub()), apply: () => stub(), construct: () => stub() });
const real = Module._load;
const SUBJ = { _id: '0'.repeat(24), slug: 'ctdl-1', name: 'CTDL' };
const gone = [];                                   // file GitHub bị xoá (không được xảy ra với file R2)
const fakeGh = { isConfigured: true, repoFor: async () => null, deleteFile: async (p) => { gone.push(p); }, readBinaryFileLarge: async () => { throw new Error('không được đọc GitHub'); } };
Module._load = function (req) {
  if (/githubService$/.test(req)) return fakeGh;
  if (/githubSyncService$/.test(req)) return { syncKinds: async () => { } };
  if (/userKeyService$/.test(req)) return { getContentScope: async () => ({ filter: {}, canAccess: () => true }) };
  if (/models\/Subject$/.test(req)) return { findOne: async () => SUBJ };
  if (/^mongoose$/.test(req)) return { Types: { ObjectId: { isValid: (v) => /^[a-f0-9]{24}$/i.test(String(v)) } } };
  if (/(models\/|pagination\.controller|utils\/search|config\/github)/.test(req)) return stub();
  try { return real.apply(this, arguments); } catch (e) { if (e.code === 'MODULE_NOT_FOUND') return stub(); throw e; }
};
// ---- R2 giả: fetch(url ký sẵn) → Map trong RAM
const r2 = new Map();
const keyOf = (u) => decodeURIComponent(new URL(u).pathname.replace(/^\/bk\//, ''));
global.fetch = async (url, o = {}) => {
  const method = (o.method || 'GET').toUpperCase(), key = keyOf(url), u = new URL(url);
  assert.ok(u.searchParams.get('X-Amz-Signature') && u.searchParams.get('X-Amz-SignedHeaders') === 'host', 'URL phải được ký');
  const R = (status, body, h) => ({ status, ok: status < 300, headers: { get: (k) => (h || {})[k.toLowerCase()] || null }, arrayBuffer: async () => Uint8Array.from(body || []).buffer });
  if (method === 'PUT') { r2.set(key, Buffer.from(await new Response(o.body).arrayBuffer())); return R(200); }
  if (!r2.has(key)) return R(404);
  const b = r2.get(key);
  if (method === 'HEAD') return R(200, [], { 'content-length': String(b.length) });
  if (method === 'DELETE') { r2.delete(key); return R(204); }
  const m = /bytes=(\d+)-(\d+)/.exec((o.headers || {}).Range || '');
  return m ? R(206, b.subarray(+m[1], +m[2] + 1)) : R(200, b);
};
global.window = { crypto: globalThis.crypto }; require('../public/js/studyFileForm.js');
const F = window.StudyFileForm, sc = require('../services/slideCryptoService.js');
const cfg = require('../config/studyFileConfig.js'), L = cfg.LIMITS;
const { createController, _test } = require('../controllers/studyFile.controller.js');
const app = cfg.APPS.slides, ctrl = createController(app, { exists: async () => false });
const call = async (fn, req) => { req.params = req.params || {}; const out = {}; const res = { status(c) { out.code = c; return this; }, set() { return this; }, json(b) { out.body = b; out.code = out.code || 200; return this; } }; await fn(req, res); return out; };
const S = { frameBytes: L.FRAME_PLAIN_BYTES, frameOverhead: L.FRAME_OVERHEAD, magicBytes: L.FILE_MAGIC_BYTES, partMaxBytes: L.PART_MAX_BYTES };
const ok = (c, m) => { assert.ok(c, m); console.log('  ✓', m); };

// "trình duyệt": mã hoá khung → ghép [magic + khung] theo từng file-phần (đúng như directFlow trong studyFileForm.js)
async function browserBuild(file, only) {
  const sizes = F.frameSizes(file.length, S), groups = F.groupFrames(sizes, S), total = sizes.length, out = [];
  const salts = sizes.map(() => F.newSalt()), keys = sc.deriveFrameKeys(salts.map(F.toB64u));
  for (const g of groups) {
    const pieces = [Buffer.from('SLD2')];
    for (let i = g.startFrame; i < g.startFrame + g.count; i++) pieces.push(Buffer.from(await F.encryptFrame(file.subarray(i * S.frameBytes, (i + 1) * S.frameBytes), i, total, salts[i], keys[i])));
    out.push(Buffer.concat(pieces));
  }
  return out;
}
(async () => {
  const uid = crypto.randomBytes(8).toString('hex'), ts = Math.floor(Date.now() / 1000);
  const plain = Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(L.PART_MAX_BYTES + 3 * 1000 * 1000)]);     // > 23MB → 2 file-phần
  const req = { user: { _id: 'u' }, body: { title: 'Bài 1', ext: 'pdf', uid, ts, size: plain.length, subjectId: SUBJ._id } };

  let r = await call(ctrl.directInit, req);
  ok(r.code === 200 && r.body.parts.length === 2, 'direct-init: 2 file-phần, mỗi phần 1 URL PUT ký sẵn');
  ok(r.body.parts.every((p) => /X-Amz-Signature=/.test(p.url) && !/SECRET/.test(p.url)), 'URL có chữ ký, không lộ khoá R2');
  const plan = r.body.parts, built = await browserBuild(plain);
  ok(built.every((b, k) => b.length === plan[k].enc), 'trình duyệt tính đúng kích thước từng file-phần như server');

  // chưa PUT gì → direct-done báo thiếu
  r = await call(ctrl.directDone, req); ok(r.code === 400 && /Thiếu file-phần 1/.test(r.body.message), 'direct-done: chưa up → báo thiếu');
  // PUT phần 0 (dùng URL ký sẵn như trình duyệt), thiếu phần 1
  await fetch(plan[0].url, { method: 'PUT', body: built[0] });
  r = await call(ctrl.directDone, req); ok(r.code === 400 && /Thiếu file-phần 2/.test(r.body.message), 'direct-done: thiếu phần 2 → từ chối');
  // phần 1 sai kích thước → bị xoá
  await fetch(plan[1].url, { method: 'PUT', body: built[1].subarray(0, built[1].length - 10) });
  r = await call(ctrl.directDone, req); ok(r.code === 422 && !r2.has(keyOf(plan[1].url)), 'direct-done: sai kích thước → 422 và xoá object');
  // phần 1 đúng
  await fetch(plan[1].url, { method: 'PUT', body: built[1] });
  r = await call(ctrl.directDone, req); ok(r.code === 200 && r.body.parts.length === 2 && r.body.parts.every((p) => p.store === 'r2' && p.sig), 'direct-done: đủ phần → trả chữ ký + store=r2');
  const done = r.body.parts;

  // create/update: checkFile nhận chữ ký r2, giữ store
  const ctx = { subject: SUBJ, rec: null };
  const body = { title: 'Bài 1', file: { name: 'bai1.pdf', ext: 'pdf', uid, ts, parts: done } };
  let chk = await ctrl._test.checkFile(body, ctx);
  ok(!chk.error && chk.parts.every((p) => p.store === 'r2') && chk.size === plain.length, 'checkFile: nhận file-phần R2, giữ store=r2, size đúng');
  const forged = JSON.parse(JSON.stringify(body)); delete forged.file.parts[0].store;
  chk = await ctrl._test.checkFile(forged, ctx); ok(!!chk.error, 'checkFile: bỏ cờ store → chữ ký không khớp, từ chối');
  const forged2 = JSON.parse(JSON.stringify(body)); forged2.file.parts[0].enc += 1;
  chk = await ctrl._test.checkFile(forged2, ctx); ok(!!chk.error, 'checkFile: sửa kích thước → từ chối');

  // đọc lại: server (đường dự phòng) giải mã từ R2, KHÔNG đụng GitHub
  chk = await ctrl._test.checkFile(body, ctx);
  const rec = { _id: 'x', parts: chk.parts, githubSha: 's1' };
  const back = await ctrl._test.readRange(rec, 0, plain.length);
  ok(back.equals(plain), 'đọc lại từ R2 + giải mã khớp từng byte với file gốc');

  // khung 0 sai khoá → direct-done từ chối (file-phần đầu giải thử)
  const uid2 = crypto.randomBytes(8).toString('hex'), small = Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(5000)]);
  const req2 = { user: { _id: 'u' }, body: { title: 'Bài 2', ext: 'pdf', uid: uid2, ts, size: small.length, subjectId: SUBJ._id } };
  const p2 = (await call(ctrl.directInit, req2)).body.parts;
  const salt = F.newSalt(), badFrame = Buffer.from(await F.encryptFrame(small, 0, 1, salt, F.toB64u(crypto.randomBytes(32))));
  await fetch(p2[0].url, { method: 'PUT', body: Buffer.concat([Buffer.from('SLD2'), badFrame]) });
  r = await call(ctrl.directDone, req2); ok(r.code === 422 && !r2.has(keyOf(p2[0].url)), 'khung 0 mã hoá sai khoá → 422 và xoá object');
  // không phải PDF
  const notPdf = Buffer.from('hello world, đây không phải pdf'), req3 = { user: { _id: 'u' }, body: { title: 'Bài 3', ext: 'pdf', uid: uid2.replace(/.$/, '0'), ts, size: notPdf.length, subjectId: SUBJ._id } };
  const p3 = (await call(ctrl.directInit, req3)).body.parts, [b3] = await browserBuild(notPdf);
  await fetch(p3[0].url, { method: 'PUT', body: b3 });
  r = await call(ctrl.directDone, req3); ok(r.code === 400 && /không phải \.pdf/.test(r.body.message), 'nội dung không phải .pdf → 400');

  // validation đầu vào
  r = await call(ctrl.directInit, { user: { _id: 'u' }, body: { ...req.body, ext: 'exe' } }); ok(r.code === 400, 'đuôi .exe → 400');
  r = await call(ctrl.directInit, { user: { _id: 'u' }, body: { ...req.body, size: L.MAX_FILE_BYTES + 1 } }); ok(r.code === 413, 'file quá lớn → 413');
  r = await call(ctrl.directInit, { user: { _id: 'u' }, body: { ...req.body, uid: 'zz' } }); ok(r.code === 400, 'uid sai → 400');
  ok(gone.length === 0, 'file R2 không bao giờ bị xử lý như file GitHub');
  console.log('OK studyfiles.direct-r2');
})().catch((e) => { console.error('LỖI', e); process.exit(1); });
