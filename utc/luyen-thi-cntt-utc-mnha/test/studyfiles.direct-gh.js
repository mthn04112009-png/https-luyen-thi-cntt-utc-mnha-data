// Test: up THẲNG lên GitHub bằng TOKEN TẠM (GitHub App) — không có R2.
//   direct-init (mode 'github' + token tạm của repo đang ghi) → "trình duyệt" (public/js/studyFileForm.js) mã hoá + ghép file-phần + POST /git/blobs
//   → direct-done gom blob vào MỘT commit, kiểm size/header/giải thử khung 0 → chữ ký (KHÔNG có 'r2') → checkFile nhận → đọc/giải mã lại.
//   Từ chối: thiếu/sai danh sách sha, sai kích thước, sai định dạng, file không phải PDF. PAT thật không bao giờ xuống trình duyệt.
// Chạy: node test/studyfiles.direct-gh.js  (không cần Mongo/GitHub thật: thư viện ngoài + fetch được giả lập)
process.env.ENCRYPTION_MASTER_KEY = 'cd'.repeat(32);
process.env.CONNECT_ENC_KEY = 'connect-key-0123456789-abcdefghijklmnop';
process.env.GITHUB_TOKEN = 'PAT_SECRET_KHONG_DUOC_LO';
for (const k of ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_INSTALLATION_ID', 'STUDYFILE_DIRECT', 'GH_DIRECT']) delete process.env[k];
const Module = require('module'), assert = require('assert'), crypto = require('crypto');
const stub = () => new Proxy(function () { }, { get: (t, k) => (k === '__esModule' ? false : stub()), apply: () => stub(), construct: () => stub() });
const real = Module._load;
const SUBJ = { _id: '0'.repeat(24), slug: 'ctdl-1', name: 'CTDL' };

// ---- "GitHub" trong RAM: blob (sha → buffer), cây (path → sha), file JSON cấu hình
const blobs = new Map(), tree = new Map(), jsonFiles = new Map(), commits = [], dropped = [];
const gitSha = (b) => crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + b.length + '\0'), b])).digest('hex');
const fakeGh = {
  isConfigured: true, owner: 'o', repo: 'r', branch: 'main',
  repoFor: async () => ({ owner: 'o', repo: 'r', branch: 'main' }),
  async readJsonFile(p) { return jsonFiles.has(p) ? JSON.parse(jsonFiles.get(p)) : null; },
  async readJsonFileWithSha(p) { return jsonFiles.has(p) ? { data: JSON.parse(jsonFiles.get(p)), sha: 'v' + jsonFiles.get(p).length } : null; },
  async writeJsonFileIfSha(p, d) { jsonFiles.set(p, JSON.stringify(d)); },
  async commitFiles(ch, msg) { commits.push({ ch, msg }); for (const c of ch) { if (!blobs.has(c.sha)) { const e = new Error('blob không tồn tại'); e.status = 422; throw e; } tree.set(c.path, c.sha); } return { commitSha: 'c' + commits.length }; },
  async deleteFile(p) { dropped.push(p); tree.delete(p); },
  async getBlobBuffer(sha) { return blobs.get(sha) || null; },
  async readBinaryFileLarge(p) { return tree.has(p) ? blobs.get(tree.get(p)) : null; }
};
Module._load = function (req) {
  if (/githubService$/.test(req)) return fakeGh;
  if (/githubSyncService$/.test(req)) return { syncKinds: async () => { } };
  if (/userKeyService$/.test(req)) return { getContentScope: async () => ({ filter: {}, canAccess: () => true }) };
  if (/models\/Subject$/.test(req)) return { findOne: async () => SUBJ };
  if (/^mongoose$/.test(req)) return { Types: { ObjectId: { isValid: (v) => /^[a-f0-9]{24}$/i.test(String(v)) } } };
  if (/(models\/|pagination\.controller|utils\/search|config\/github)/.test(req)) return stub();
  try { return real.apply(this, arguments); } catch (e) { if (e.code === 'MODULE_NOT_FOUND') return stub(); throw e; }
};

// ---- api.github.com + raw.githubusercontent.com giả
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' });
const blobAuth = []; let rawMode = 'ok'; const rawHits = [];
global.fetch = async (url, o = {}) => {
  const u = new URL(String(url)), method = (o.method || 'GET').toUpperCase();
  const R = (status, body, h) => ({ status, ok: status < 300, headers: { get: (k) => (h || {})[k.toLowerCase()] || null }, json: async () => JSON.parse(Buffer.from(body || '{}').toString()), text: async () => Buffer.from(body || '').toString(), arrayBuffer: async () => Uint8Array.from(body || []).buffer });
  const J = (status, obj) => R(status, Buffer.from(JSON.stringify(obj)));
  if (u.hostname === 'api.github.com') {
    const auth = String((o.headers || {}).Authorization || '').replace(/^Bearer /, '');
    if (u.pathname === '/repos/o/r/installation') { const [h, b, s] = auth.split('.'); assert(crypto.createVerify('RSA-SHA256').update(h + '.' + b).verify(publicKey, Buffer.from(s, 'base64url')), 'JWT ký đúng'); return J(200, { id: 77 }); }
    if (u.pathname === '/app/installations/77/access_tokens') { assert.deepStrictEqual(JSON.parse(o.body), { repositories: ['r'], permissions: { contents: 'write' } }); return J(201, { token: 'ghs_TAM_1h', expires_at: '2099-01-01T00:00:00Z' }); }
    if (u.pathname === '/repos/o/r/git/blobs' && method === 'POST') {          // "trình duyệt" tạo blob
      blobAuth.push(auth);
      if (auth !== 'ghs_TAM_1h') return J(401, { message: 'Bad credentials' });
      const buf = Buffer.from(JSON.parse(o.body).content, 'base64'), sha = gitSha(buf); blobs.set(sha, buf);
      return J(201, { sha });
    }
    return J(404, { message: 'Not Found' });
  }
  if (u.hostname === 'raw.githubusercontent.com') {                              // server kiểm header bằng Range
    rawHits.push(u.pathname);
    if (rawMode === 'down') return R(404);
    const path = decodeURIComponent(u.pathname.replace(/^\/o\/r\/main\//, ''));
    if (!tree.has(path)) return R(404);
    const b = blobs.get(tree.get(path)), m = /bytes=(\d+)-(\d+)/.exec((o.headers || {}).Range || '');
    return m ? R(206, b.subarray(+m[1], +m[2] + 1), { 'content-range': `bytes ${m[1]}-${Math.min(+m[2], b.length - 1)}/${b.length}` }) : R(200, b);
  }
  throw new Error('fetch không mong đợi: ' + url);
};
global.FileReader = class { readAsDataURL(b) { b.arrayBuffer().then((ab) => { this.result = 'data:application/octet-stream;base64,' + Buffer.from(ab).toString('base64'); this.onload && this.onload(); }); } };
global.window = { crypto: globalThis.crypto }; require('../public/js/studyFileForm.js');
const F = window.StudyFileForm, sc = require('../services/slideCryptoService.js');
const cfg = require('../config/studyFileConfig.js'), L = cfg.LIMITS;
const { createController } = require('../controllers/studyFile.controller.js');
const githubApp = require('../services/connect/githubApp'), appTok = require('../services/githubAppToken');
const app = cfg.APPS.slides, ctrl = createController(app, { exists: async () => false });
const call = async (fn, req) => { req.params = req.params || {}; const out = {}; const res = { status(c) { out.code = c; return this; }, set() { return this; }, json(b) { out.body = b; out.code = out.code || 200; return this; } }; await fn(req, res); return out; };
const S = { frameBytes: L.FRAME_PLAIN_BYTES, frameOverhead: L.FRAME_OVERHEAD, magicBytes: L.FILE_MAGIC_BYTES, partMaxBytes: L.PART_MAX_BYTES };
const ok = (c, m) => { assert.ok(c, m); console.log('  ✓', m); };

async function browserBuild(file) {                       // đúng như directFlow trong studyFileForm.js
  const sizes = F.frameSizes(file.length, S), groups = F.groupFrames(sizes, S), total = sizes.length, out = [];
  const salts = sizes.map(() => F.newSalt()), keys = sc.deriveFrameKeys(salts.map(F.toB64u));
  for (const g of groups) {
    const pieces = [Buffer.from('SLD2')];
    for (let i = g.startFrame; i < g.startFrame + g.count; i++) pieces.push(Buffer.from(await F.encryptFrame(file.subarray(i * S.frameBytes, (i + 1) * S.frameBytes), i, total, salts[i], keys[i])));
    out.push(Buffer.concat(pieces));
  }
  return out;
}
const postBlob = async (gh, buf) => { const r = await fetch(`https://api.github.com/repos/${gh.owner}/${gh.repo}/git/blobs`, { method: 'POST', headers: { Authorization: 'Bearer ' + gh.token }, body: JSON.stringify({ content: buf.toString('base64'), encoding: 'base64' }) }); assert.strictEqual(r.status, 201); return (await r.json()).sha; };

(async () => {
  const uid = crypto.randomBytes(8).toString('hex'), ts = Math.floor(Date.now() / 1000);
  const plain = Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(L.PART_MAX_BYTES + 3 * 1000 * 1000)]);     // > 23MB → 2 file-phần
  const req = { user: { _id: 'u' }, body: { title: 'Bài 1', ext: 'pdf', uid, ts, size: plain.length, subjectId: SUBJ._id } };

  // 1) chưa nhập GitHub App và không có R2 → từ chối rõ ràng, không cấp gì
  let r = await call(ctrl.directInit, req);
  ok(r.code === 503 && /GitHub App/.test(r.body.message), 'chưa có R2 / GitHub App → direct-init 503, nói rõ phải nhập ở /connect');

  // 2) nhập GitHub App ở /connect (private key MÃ HOÁ trong repo chính)
  await githubApp.saveConfig({ appId: '12345', privateKey: PEM });
  assert(!/BEGIN|MII/.test(jsonFiles.get(githubApp.FILE())), 'file cấu hình không chứa private key dạng rõ');
  ok(await appTok.isConfigured(), 'GitHub App đã cấu hình (khoá mã hoá trong repo chính)');

  // 3) direct-init: mode github + TOKEN TẠM; PAT thật / private key không xuống trình duyệt
  r = await call(ctrl.directInit, req);
  ok(r.code === 200 && r.body.mode === 'github' && r.body.gh.token === 'ghs_TAM_1h' && r.body.gh.repo === 'r' && r.body.parts.length === 2, 'direct-init: mode=github, token tạm, 2 file-phần');
  ok(!JSON.stringify(r.body).includes('PAT_SECRET') && !JSON.stringify(r.body).includes('BEGIN'), 'PAT thật và private key KHÔNG có trong phản hồi');
  const plan = r.body.parts, gh = r.body.gh, built = await browserBuild(plain);
  ok(built.every((b, k) => b.length === plan[k].enc), 'trình duyệt tính đúng kích thước từng file-phần như server');

  // 4) direct-done: danh sách sha sai → từ chối, KHÔNG commit
  const n0 = commits.length;
  r = await call(ctrl.directDone, { ...req, body: { ...req.body, shas: ['a'.repeat(40)] } });
  ok(r.code === 400 && commits.length === n0, 'direct-done: thiếu sha của file-phần → 400, không commit');
  r = await call(ctrl.directDone, { ...req, body: { ...req.body, shas: ['zz', 'yy'] } });
  ok(r.code === 400 && commits.length === n0, 'direct-done: sha sai định dạng → 400, không commit');

  // 5) sai kích thước (cắt cụt) → bị xoá khỏi repo
  const sha0 = await postBlob(gh, built[0]), shaBadSize = await postBlob(gh, built[1].subarray(0, built[1].length - 10));
  r = await call(ctrl.directDone, { ...req, body: { ...req.body, shas: [sha0, shaBadSize] } });
  ok(r.code === 422 && /sai kích thước/.test(r.body.message) && dropped.includes(plan[1].path), 'direct-done: sai kích thước → 422 và xoá file-phần lỗi');
  dropped.length = 0;

  // 6) sai định dạng (không phải SLD2) → xoá
  const shaGarbage = await postBlob(gh, crypto.randomBytes(plan[1].enc));
  r = await call(ctrl.directDone, { ...req, body: { ...req.body, shas: [sha0, shaGarbage] } });
  ok(r.code === 422 && /không đúng định dạng/.test(r.body.message) && dropped.includes(plan[1].path), 'direct-done: sai định dạng mã hoá → 422 và xoá');
  dropped.length = 0;

  // 7) file không phải PDF (khung 0 giải mã được nhưng sai magic) → 400
  const fakeTxt = Buffer.concat([Buffer.from('Day khong phai PDF\n'), crypto.randomBytes(500)]);
  const reqTxt = { user: { _id: 'u' }, body: { title: 'Bài X', ext: 'pdf', uid: crypto.randomBytes(8).toString('hex'), ts, size: fakeTxt.length, subjectId: SUBJ._id } };
  const rTxt = await call(ctrl.directInit, reqTxt), bTxt = await browserBuild(fakeTxt);
  const shaTxt = await postBlob(rTxt.body.gh, bTxt[0]);
  r = await call(ctrl.directDone, { ...reqTxt, body: { ...reqTxt.body, shas: [shaTxt] } });
  ok(r.code === 400 && /không phải \.pdf/.test(r.body.message), 'direct-done: nội dung không phải PDF → 400');
  dropped.length = 0;

  // 8) đúng → MỘT commit gồm cả 2 file-phần; chữ ký KHÔNG có store=r2
  const sha1 = await postBlob(gh, built[1]);
  assert(blobAuth.every((a) => a === 'ghs_TAM_1h'), 'trình duyệt chỉ dùng token tạm');
  const nBefore = commits.length;
  r = await call(ctrl.directDone, { ...req, body: { ...req.body, shas: [sha0, sha1] } });
  ok(r.code === 200 && r.body.parts.length === 2 && r.body.parts.every((p) => p.sig && !p.store), 'direct-done: đủ phần → chữ ký, không có store (lưu ở GitHub)');
  ok(commits.length === nBefore + 1 && commits[commits.length - 1].ch.length === 2, 'gom 2 file-phần vào đúng 1 commit');
  ok(rawHits.length > 0, 'kiểm header bằng Range trên raw GitHub (không tải cả blob 23MB về server)');
  const done = r.body.parts;

  // 9) raw GitHub chưa sẵn sàng → server tự dự phòng bằng tải blob theo sha, vẫn xác nhận được
  rawMode = 'down'; tree.delete(plan[0].path); tree.delete(plan[1].path);
  r = await call(ctrl.directDone, { ...req, body: { ...req.body, shas: [sha0, sha1] } });
  ok(r.code === 200 && r.body.parts.length === 2, 'raw GitHub lỗi → dự phòng đọc blob theo sha, vẫn xác nhận');
  rawMode = 'ok';

  // 10) create/update: checkFile nhận chữ ký; sửa số liệu → từ chối
  const ctx = { subject: SUBJ, rec: null };
  const body = { title: 'Bài 1', file: { name: 'bai1.pdf', ext: 'pdf', uid, ts, parts: done } };
  let chk = await ctrl._test.checkFile(body, ctx);
  ok(!chk.error && chk.parts.every((p) => !p.store) && chk.size === plain.length, 'checkFile: nhận file-phần GitHub, size đúng');
  const forged = JSON.parse(JSON.stringify(body)); forged.file.parts[0].enc += 1;
  chk = await ctrl._test.checkFile(forged, ctx); ok(!!chk.error, 'checkFile: sửa kích thước → từ chối');
  const forged2 = JSON.parse(JSON.stringify(body)); forged2.file.parts[0].store = 'r2';
  chk = await ctrl._test.checkFile(forged2, ctx); ok(!!chk.error, 'checkFile: khai man store=r2 → chữ ký không khớp, từ chối');

  // 11) đọc lại: server giải mã từ GitHub, khớp từng byte
  chk = await ctrl._test.checkFile(body, ctx);
  const rec = { _id: 'x', parts: chk.parts, githubSha: 's1' };
  const back = await ctrl._test.readRange(rec, 0, plain.length);
  ok(back.equals(plain), 'đọc lại + giải mã khớp từng byte với file gốc');

  // 12) tắt bằng STUDYFILE_DIRECT=off → quay về đường cũ
  process.env.STUDYFILE_DIRECT = 'off';
  r = await call(ctrl.directInit, req);
  ok(r.code === 503, 'STUDYFILE_DIRECT=off → không cấp token tạm');
  delete process.env.STUDYFILE_DIRECT;

  console.log('OK studyfiles.direct-gh');
  process.exit(0);
})().catch((e) => { console.error('✘', e); process.exit(1); });
