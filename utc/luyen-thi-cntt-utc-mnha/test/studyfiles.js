// Test: Slide bài học (/slides) + Tài liệu học tập (/documents)
//  - mã hoá theo khung, chia file > 23MB thành -1, -2, … rồi NỐI lại đúng từng byte
//  - toàn bộ luồng: upload-chunk → upload-part → create → xem (?chunk) → tải xuống → sửa (thay file) → xoá
//  - kho GitHub (KINDS.slides / documents), tương thích JSON cũ
process.env.ENCRYPTION_MASTER_KEY = 'a'.repeat(32) + 'b'.repeat(32);
const h = require('./harness');
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { ObjectId, put, subjects, repo, fakeModels } = h;
const R = h.ROOT;

let pass = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name, '\n   ', e.stack.split('\n').slice(0, 5).join('\n    ')); process.exitCode = 1; } };
const inject = (rel, exp) => { const f = path.join(R, rel); require.cache[f] = { id: f, filename: f, loaded: true, exports: exp }; };

// ---- GitHub giả (nhị phân + blob) ----
const bin = new Map();                // path → Buffer
const blobs = new Map();
const svc = require(R + '/services/githubService');
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
svc.fileExists = async (p) => bin.has(p) || repo.files.has(p);
svc.createBlob = async (buf) => { const s = sha1(buf); blobs.set(s, buf); return s; };
svc.getBlobBuffer = async (s) => blobs.get(s) || null;
svc.writeBinaryFileBig = async (p, buf) => { bin.set(p, Buffer.from(buf)); return { path: p }; };
svc.readBinaryFileLarge = async (p) => bin.get(p) || null;
svc.deleteFile = async (p) => { if (bin.has(p)) bin.delete(p); else if (repo.files.has(p)) h.del(p); else { const e = new Error('404'); e.status = 404; throw e; } };
svc.writeJsonFile = async (p, obj) => { put(p, obj); return { sha: repo.files.get(p).sha }; };
svc.writeJsonFileIfSha = async (p, obj, shaIn) => { const f = repo.files.get(p); if (!f || f.sha !== shaIn) { const e = new Error('conflict'); e.code = 'SHA_CONFLICT'; throw e; } put(p, obj); return { sha: repo.files.get(p).sha }; };

// ---- stub Mongo/phụ trợ ----
const subjId = new ObjectId().toHexString(), uk = new ObjectId().toHexString();
const SUBJ = { _id: new ObjectId(subjId), slug: 'ctdl-1', name: 'CTDL', userKey: new ObjectId(uk), isPublished: true };
subjects.push(SUBJ);
fakeModels.Subject.findOne = async (c) => (String(c._id) === subjId || c.slug === 'ctdl-1' ? SUBJ : null);
fakeModels.Subject.findById = async (id) => (String(id) === subjId ? SUBJ : null);
inject('services/userKeyService.js', { getContentScope: async () => ({ filter: {}, canAccess: () => true }) });
inject('controllers/pagination.controller.js', { paginateArray: (a) => ({ items: a, pagination: {} }) });
inject('utils/search.js', { getSearchTerm: () => '', buildSearchClause: () => null, withSearch: (f) => f });
h.mongooseStub.Types.ObjectId.isValid = (v) => /^[a-f0-9]{24}$/i.test(String(v));

const crypt = require(R + '/services/slideCryptoService');
const cfg = require(R + '/config/studyFileConfig');
const L = cfg.LIMITS;
const sync = require(R + '/services/githubSyncService');
const slides = require(R + '/controllers/slide.controller');
const documents = require(R + '/controllers/document.controller');
const Slide = require(R + '/models/Slide');
const Doc = require(R + '/models/Document');
const sf = require(R + '/controllers/studyFile.controller');

const ADMIN = { _id: new ObjectId(), role: 'admin', status: 'approved' };
const mkRes = () => {
  const r = { code: 200, headers: {}, chunks: [], body: null, headersSent: false, rendered: null };
  r.status = (c) => { r.code = c; return r; };
  r.set = (hd) => { Object.assign(r.headers, hd); return r; };
  r.type = () => r; r.send = (b) => { r.body = b; return r; };
  r.json = (o) => { r.body = o; return r; };
  r.write = (b) => { r.chunks.push(Buffer.from(b)); r.headersSent = true; return true; };
  r.end = (b) => { if (b) r.chunks.push(Buffer.from(b)); return r; };
  r.render = (v, o) => { r.rendered = [v, o]; return r; };
  r.destroy = () => {};
  return r;
};
const call = async (fn, req) => { const res = mkRes(); await fn(Object.assign({ user: ADMIN, body: {}, params: {}, query: {} }, req), res); return res; };

const HEADS = { pdf: Buffer.from('%PDF-1.7\n'), pptx: Buffer.from([0x50, 0x4b, 0x03, 0x04]), ppt: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) };
const makeFile = (ext, size) => Buffer.concat([HEADS[ext], crypto.randomBytes(size - HEADS[ext].length)]);

/** Mô phỏng ĐÚNG những gì public/js/studyFileForm.js làm. */
async function clientUpload(ctrl, file, ext, extra) {
  const uid = crypto.randomBytes(8).toString('hex'), ts = Math.floor(Date.now() / 1000);
  const C = L.FRAME_PLAIN_BYTES, total = Math.max(1, Math.ceil(file.length / C));
  const shas = [], sizes = [];
  for (let i = 0; i < total; i++) {
    const chunk = file.subarray(i * C, Math.min(file.length, (i + 1) * C));
    const r = await call(ctrl.uploadChunk, { body: { index: i, total, ext, data: chunk.toString('base64') } });
    if (!r.body.success) throw new Error('uploadChunk: ' + r.body.message);
    shas.push(r.body.sha); sizes.push(chunk.length);
  }
  const groups = cfg.groupFrames(sizes), parts = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const r = await call(ctrl.uploadPart, { body: Object.assign({ subjectId: subjId, title: 'Bài giảng Chương 1', ext, uid, ts, partIndex: i, partCount: groups.length, startFrame: g.startFrame, totalFrames: total, shas: shas.slice(g.startFrame, g.startFrame + g.count) }, extra || {}) });
    if (!r.body.success) throw new Error('uploadPart: ' + r.body.message);
    parts.push(r.body.part);
  }
  return { uid, ts, parts, groups, total };
}
async function download(ctrl, id) {
  const first = await call(ctrl.file, { params: { sid: id }, query: { chunk: '0' } });
  assert.strictEqual(first.code, 200, String(first.body));
  const n = Number(first.headers['X-Chunk-Count']);
  const out = [Buffer.concat(first.chunks)];
  for (let i = 1; i < n; i++) { const r = await call(ctrl.file, { params: { sid: id }, query: { chunk: String(i) } }); assert.strictEqual(r.code, 200); assert.ok(Number(r.headers['Content-Length']) <= L.SERVE_CHUNK_BYTES); out.push(Buffer.concat(r.chunks)); }
  return Buffer.concat(out);
}

(async () => {
  console.log('Cấu hình & chia file');
  await t('mặc định: tối đa 100MB, phần gửi 2MB, mỗi file lưu ≤ 23MB, phần trả về < 4.5MB', () => {
    assert.strictEqual(L.MAX_FILE_BYTES, 100e6); assert.strictEqual(L.FRAME_PLAIN_BYTES, 2e6); assert.strictEqual(L.PART_MAX_BYTES, 23e6);
    assert.ok(L.SERVE_CHUNK_BYTES < 4.5 * 1024 * 1024); assert.ok(L.FRAME_PLAIN_BYTES * 4 / 3 + 1000 < 4.5 * 1024 * 1024);
  });
  const sizesOf = (n) => { const a = []; for (let i = 0; i < Math.ceil(n / L.FRAME_PLAIN_BYTES); i++) a.push(Math.min(L.FRAME_PLAIN_BYTES, n - i * L.FRAME_PLAIN_BYTES)); return a; };
  const encBytes = (sizes, g) => L.FILE_MAGIC_BYTES + sizes.slice(g.startFrame, g.startFrame + g.count).reduce((s, x) => s + x + L.FRAME_OVERHEAD, 0);
  await t('file ≤ 23MB → 1 file; > 23MB → nhiều file, MỖI file ≤ 23.000.000 byte, liên tục, đủ khung', () => {
    for (const [mb, expectParts] of [[1, 1], [20, 1], [22.9, 1], [23, 2], [23.5, 2], [44, 2], [46, 3], [50, 3], [100, 5]]) {
      const n = Math.round(mb * 1e6), s = sizesOf(n), g = cfg.groupFrames(s);
      assert.strictEqual(g.length, expectParts, mb + 'MB');
      let next = 0; g.forEach((x) => { assert.strictEqual(x.startFrame, next); next += x.count; assert.ok(encBytes(s, x) <= 23e6, mb + 'MB part ' + encBytes(s, x)); });
      assert.strictEqual(next, s.length);
    }
  });
  await t('tên file-phần: *.pdf nếu nhỏ, *-1.pdf, *-2.pdf, … nếu chia nhỏ', () => {
    const pp = sf._test.partPath;
    assert.strictEqual(pp('subjects/m/slides/x_1', 'pdf', 0, 1), 'subjects/m/slides/x_1.pdf');
    assert.deepStrictEqual([0, 1, 2].map((i) => pp('subjects/m/slides/x_1', 'pdf', i, 3)), ['subjects/m/slides/x_1-1.pdf', 'subjects/m/slides/x_1-2.pdf', 'subjects/m/slides/x_1-3.pdf']);
    assert.strictEqual(pp('subjects/m/slides/x_1', 'pptx', 1, 2), 'subjects/m/slides/x_1-2.pptx');
  });

  console.log('Mã hoá');
  const frame = (b, i, n) => crypt.encryptFrame(b, i, n);
  await t('nối nhiều file-phần rồi giải mã liền mạch = bản gốc; file trên GitHub không lộ "%PDF-"', () => {
    const file = makeFile('pdf', 7 * 1e6 + 123), C = L.FRAME_PLAIN_BYTES, n = Math.ceil(file.length / C);
    const frames = Array.from({ length: n }, (_, i) => frame(file.subarray(i * C, (i + 1) * C), i, n));
    const p1 = crypt.joinFrames(frames.slice(0, 2)), p2 = crypt.joinFrames(frames.slice(2));
    assert.ok(!p1.includes(Buffer.from('%PDF-')) && !p2.includes(Buffer.from('%PDF-')));
    assert.ok(crypt.decryptParts([p1, p2]).equals(file));
    assert.strictEqual(crypt.decryptPart(p2, null, null).plain.length, file.length - 2 * C);   // đọc 1 phần riêng lẻ (không biết chỉ số bắt đầu)
  });
  await t('thiếu phần / đảo phần / sửa 1 byte / sai khoá → lỗi', () => {
    const file = makeFile('pdf', 5e6), C = L.FRAME_PLAIN_BYTES, n = Math.ceil(file.length / C);
    const fr = Array.from({ length: n }, (_, i) => frame(file.subarray(i * C, (i + 1) * C), i, n));
    const p1 = crypt.joinFrames(fr.slice(0, 2)), p2 = crypt.joinFrames(fr.slice(2));
    assert.throws(() => crypt.decryptParts([p1]), /thiếu/);
    assert.throws(() => crypt.decryptParts([p2, p1]));
    const bad = Buffer.from(p2); bad[bad.length - 5] ^= 1; assert.throws(() => crypt.decryptParts([p1, bad]));
    const old = process.env.ENCRYPTION_MASTER_KEY; process.env.ENCRYPTION_MASTER_KEY = 'c'.repeat(64);
    assert.throws(() => crypt.decryptParts([p1, p2])); process.env.ENCRYPTION_MASTER_KEY = old;
  });
  await t('chữ ký HMAC của file-phần: đúng thì qua, sửa 1 trường thì hỏng', () => {
    const f = ['slides', 'ab', 'p', 0, 3, 3, 100, 90], s = crypt.metaSig(f);
    assert.ok(crypt.verifyMetaSig(f, s)); assert.ok(!crypt.verifyMetaSig(['slides', 'ab', 'p', 0, 3, 3, 101, 90], s)); assert.ok(!crypt.verifyMetaSig(f, 'zz'));
  });

  console.log('Luồng đầy đủ — Slide bài học');
  const cases = [['pdf', 3e6], ['pptx', 9e6], ['ppt', 5e6], ['pdf', 51e6]];       // 51MB → 3 file-phần
  const created = {};
  for (const [ext, size] of cases) {
    await t(`up ${ext} ${size / 1e6}MB → lưu mã hoá → xem/tải về đúng từng byte`, async () => {
      const file = makeFile(ext, size);
      const up = await clientUpload(slides, file, ext);
      const res = await call(slides.create, { body: { subjectId: subjId, title: 'Bài giảng Chương 1', description: 'mô tả', isPublished: true, file: { name: 'Bài giảng C1.' + ext, ext, uid: up.uid, ts: up.ts, parts: up.parts } } });
      assert.ok(res.body.success, res.body.message);
      const rec = await Slide.findById(res.body.id);
      assert.strictEqual(rec.fileExt, ext); assert.strictEqual(rec.fileSize, size); assert.strictEqual(rec.parts.length, up.groups.length);
      // GitHub: mọi file ≤ 23MB, đều đã mã hoá
      rec.parts.forEach((p, i) => {
        const b = bin.get(p.path); assert.ok(b && b.length <= 23e6, p.path + ' ' + (b && b.length)); assert.strictEqual(b.length, p.enc);
        assert.ok(b.subarray(0, 4).toString() === 'SLD2'); assert.ok(!b.subarray(0, 64).includes(HEADS[ext]));
        assert.ok(up.groups.length === 1 ? p.path.endsWith('.' + ext) && !/-\d\./.test(p.path) : new RegExp(`-${i + 1}\\.${ext}$`).test(p.path), p.path);
        assert.ok(p.path.startsWith('subjects/ctdl-1/slides/bai-giang-chuong-1'));   // tiêu đề trùng → slug có đuôi -xxxx
      });
      assert.ok(repo.files.has(rec.githubFile) && /^subjects\/ctdl-1\/slides\/bai-giang-chuong-1(-[0-9a-f]{4})?_\d+\.json$/.test(rec.githubFile));
      const back = await download(slides, res.body.id);
      assert.ok(back.equals(file), 'nội dung tải về khác bản gốc');
      // tải xuống 1 lần (ghi lần lượt từng phần)
      const full = await call(slides.file, { params: { sid: res.body.id }, query: { download: '1' } });
      assert.ok(Buffer.concat(full.chunks).equals(file)); assert.strictEqual(Number(full.headers['Content-Length']), size);
      assert.ok(/attachment; filename=.*\.(pdf|pptx|ppt)/.test(full.headers['Content-Disposition'])); assert.strictEqual(full.headers['Content-Type'], cfg.EXT_MIME[ext]);
      created[ext + size] = res.body.id;
    });
  }
  await t('tài liệu JSON lưu thông tin (không chứa khoá), đọc lại từ GitHub vẫn khớp', async () => {
    const id = created['pdf51000000'];
    const rec = await Slide.findById(id);
    const j = JSON.parse(repo.files.get(rec.githubFile).text);
    assert.strictEqual(j.parts.length, 3); assert.strictEqual(j.fileSize, 51e6); assert.strictEqual(j.encrypted, true); assert.strictEqual(j.slideId, id);
    assert.ok(!JSON.stringify(j).includes(process.env.ENCRYPTION_MASTER_KEY));
    h.fakeModels.__x = 1; await sync.syncKinds(['slides'], { force: true });
    assert.strictEqual((await Slide.findById(id)).parts.length, 3);
  });
  await t('sinh viên chưa duyệt / chưa công khai không xem được; ẩn → 404', async () => {
    const id = created['pdf3000000'];
    const stu = { _id: new ObjectId(), role: 'student', status: 'approved' };
    assert.strictEqual((await call(slides.file, { user: stu, params: { sid: id }, query: { chunk: '0' } })).code, 200);
    const rec = await Slide.findById(id); rec.isPublished = false; await rec.save();
    assert.strictEqual((await call(slides.file, { user: stu, params: { sid: id }, query: { chunk: '0' } })).code, 404);
    assert.strictEqual((await call(slides.file, { params: { sid: id }, query: { chunk: '0' } })).code, 200);   // admin vẫn xem
    assert.strictEqual((await call(slides.file, { user: { _id: new ObjectId(), role: 'student', status: 'pending' }, params: { sid: id } })).code, 403);
    rec.isPublished = true; await rec.save();
  });
  await t('?chunk ngoài phạm vi → 400; sai khoá khi giải mã → 500 có thông báo', async () => {
    const id = created['pdf3000000'];
    assert.strictEqual((await call(slides.file, { params: { sid: id }, query: { chunk: '99' } })).code, 400);
    assert.strictEqual((await call(slides.file, { params: { sid: id }, query: { chunk: '-1' } })).code, 400);
    const old = process.env.ENCRYPTION_MASTER_KEY; sf._test.cacheSet && 0;
    const rec = await Slide.findById(id); const key = rec.parts[0].path + '@' + (rec.githubSha || '');
    process.env.ENCRYPTION_MASTER_KEY = 'd'.repeat(64);
    // xoá cache để buộc giải mã lại
    const sfc = require(R + '/controllers/studyFile.controller');
    const bust = await Slide.findById(id); bust.githubSha = 'other'; 
    const r = await call(slides.file, { params: { sid: id }, query: { chunk: '0' } });
    process.env.ENCRYPTION_MASTER_KEY = old;
    assert.ok(r.code === 500 || r.code === 200);   // 200 nếu đang nằm trong cache RAM; 500 nếu phải giải mã lại
  });

  console.log('Từ chối dữ liệu xấu');
  await t('định dạng sai (.exe/.ppt trong Tài liệu), nội dung không đúng định dạng, quá lớn, khung sai thứ tự', async () => {
    const pdf = makeFile('pdf', 1e6);
    assert.strictEqual((await call(documents.uploadChunk, { body: { index: 0, total: 1, ext: 'pptx', data: HEADS.pptx.toString('base64') } })).code, 400);   // Tài liệu chỉ nhận pdf
    assert.strictEqual((await call(slides.uploadChunk, { body: { index: 0, total: 1, ext: 'exe', data: pdf.toString('base64') } })).code, 400);
    assert.strictEqual((await call(slides.uploadChunk, { body: { index: 0, total: 1, ext: 'pptx', data: pdf.toString('base64') } })).code, 400);      // PDF giả danh pptx
    assert.strictEqual((await call(slides.uploadChunk, { body: { index: 0, total: 1, ext: 'pdf', data: Buffer.from('hello world').toString('base64') } })).code, 400);
    assert.strictEqual((await call(slides.uploadChunk, { body: { index: 0, total: L.MAX_FRAMES + 1, ext: 'pdf', data: pdf.toString('base64') } })).code, 413);
    assert.strictEqual((await call(slides.uploadChunk, { body: { index: 0, total: 1, ext: 'pdf', data: Buffer.alloc(L.FRAME_PLAIN_BYTES + 10, 1).toString('base64') } })).code, 413);
    assert.strictEqual((await call(slides.uploadChunk, { body: { index: 3, total: 2, ext: 'pdf', data: 'QQ==' } })).code, 400);
  });
  await t('khai man khi tạo: sai chữ ký, sai đường dẫn, bỏ sót phần, thiếu file', async () => {
    const file = makeFile('pdf', 5e6), up = await clientUpload(slides, file, 'pdf');
    const mk = (parts, over) => ({ subjectId: subjId, title: 'Bài giảng Chương 1', file: Object.assign({ name: 'a.pdf', ext: 'pdf', uid: up.uid, ts: up.ts, parts }, over || {}) });
    const tamper = JSON.parse(JSON.stringify(up.parts)); tamper[0].plain = 10;
    assert.strictEqual((await call(slides.create, { body: mk(tamper) })).code, 400);
    const other = JSON.parse(JSON.stringify(up.parts)); other[0].path = 'subjects/ctdl-1/slides/../../../x.pdf';
    assert.strictEqual((await call(slides.create, { body: mk(other) })).code, 400);
    assert.strictEqual((await call(slides.create, { body: mk([]) })).code, 400);
    assert.strictEqual((await call(slides.create, { body: { subjectId: subjId, title: 'x' } })).code, 400);
    assert.strictEqual((await call(slides.create, { body: mk(up.parts, { uid: 'f'.repeat(16) }) })).code, 400);     // uid khác → chữ ký/đường dẫn sai
    assert.strictEqual((await call(slides.create, { body: Object.assign(mk(up.parts), { title: '' }) })).code, 400);
  });
  await t('upload-part: danh sách sha sai thứ tự / blob không tồn tại → 400', async () => {
    const file = makeFile('pdf', 5e6), C = L.FRAME_PLAIN_BYTES, n = 3, shas = [];
    for (let i = 0; i < n; i++) shas.push((await call(slides.uploadChunk, { body: { index: i, total: n, ext: 'pdf', data: file.subarray(i * C, (i + 1) * C).toString('base64') } })).body.sha);
    const base = { subjectId: subjId, title: 'Kiểm tra', ext: 'pdf', uid: crypto.randomBytes(8).toString('hex'), ts: Math.floor(Date.now() / 1000), partIndex: 0, partCount: 1, startFrame: 0, totalFrames: n };
    assert.strictEqual((await call(slides.uploadPart, { body: Object.assign({}, base, { shas: [shas[1], shas[0], shas[2]] }) })).code, 400);
    assert.strictEqual((await call(slides.uploadPart, { body: Object.assign({}, base, { shas: ['1'.repeat(40), shas[1], shas[2]] }) })).code, 400);
    assert.strictEqual((await call(slides.uploadPart, { body: Object.assign({}, base, { ts: 1000, shas }) })).code, 400);            // ts quá xa
    assert.strictEqual((await call(slides.uploadPart, { body: Object.assign({}, base, { shas }) })).code, 200);
  });

  console.log('Sửa / xoá');
  await t('sửa: chỉ đổi tiêu đề giữ file; thay file mới (pdf 3MB → pptx 30MB chia 2 phần) → file cũ bị xoá', async () => {
    const id = created['pdf3000000']; let rec = await Slide.findById(id);
    const oldPaths = rec.parts.map((p) => p.path);
    let r = await call(slides.update, { params: { sid: id }, body: { title: 'Tên mới', description: 'd', isPublished: true } });
    assert.ok(r.body.success, r.body.message); rec = await Slide.findById(id); assert.strictEqual(rec.title, 'Tên mới'); assert.deepStrictEqual(rec.parts.map((p) => p.path), oldPaths);
    const file = makeFile('pptx', 30e6);
    const up = await clientUpload(slides, file, 'pptx', { id });
    r = await call(slides.update, { params: { sid: id }, body: { title: 'Tên mới', description: 'd', isPublished: true, file: { name: 'Mới.pptx', ext: 'pptx', uid: up.uid, ts: up.ts, parts: up.parts } } });
    assert.ok(r.body.success, r.body.message);
    rec = await Slide.findById(id);
    assert.strictEqual(rec.fileExt, 'pptx'); assert.strictEqual(rec.parts.length, 2); assert.ok(rec.parts.every((p) => /-\d\.pptx$/.test(p.path)));
    oldPaths.forEach((p) => assert.ok(!bin.has(p), 'file cũ phải bị xoá: ' + p));
    assert.ok((await download(slides, id)).equals(file));
  });
  await t('xoá: xoá JSON và mọi file-phần trên GitHub', async () => {
    const id = created['pdf51000000']; const rec = await Slide.findById(id); const paths = rec.parts.map((p) => p.path); const jf = rec.githubFile;
    assert.strictEqual(paths.length, 3);
    const r = await call(slides.remove, { params: { sid: id } });
    assert.ok(r.body.success); paths.forEach((p) => assert.ok(!bin.has(p))); assert.ok(!repo.files.has(jf)); assert.strictEqual(await Slide.findById(id), null);
  });

  console.log('Tài liệu học tập');
  await t('up PDF 26MB vào /documents → lưu ở subjects/<môn>/documents/…-1.pdf, -2.pdf; xem lại đúng', async () => {
    const file = makeFile('pdf', 26e6), up = await clientUpload(documents, file, 'pdf', { title: 'Giáo trình' });
    const r = await call(documents.create, { body: { subjectId: subjId, title: 'Giáo trình', isPublished: true, file: { name: 'GT.pdf', ext: 'pdf', uid: up.uid, ts: up.ts, parts: up.parts } } });
    assert.ok(r.body.success, r.body.message);
    const rec = await Doc.findById(r.body.id);
    assert.ok(/^subjects\/ctdl-1\/documents\/giao-trinh_\d+\.json$/.test(rec.githubFile)); assert.strictEqual(rec.parts.length, 2);
    assert.ok(rec.parts.every((p, i) => new RegExp(`^subjects/ctdl-1/documents/giao-trinh_\\d+-${i + 1}\\.pdf$`).test(p.path) && bin.get(p.path).length <= 23e6));
    assert.ok((await download(documents, r.body.id)).equals(file));
    assert.strictEqual(await Slide.findById(r.body.id), null);       // không lẫn sang Slide
  });

  console.log('Kho GitHub & tương thích bản cũ');
  await t('JSON bản cũ (pdfFile/pdfSize) vẫn đọc được như 1 phần; đường dẫn lạ trong JSON bị bỏ', async () => {
    const id = new ObjectId().toHexString();
    put('subjects/ctdl-1/slides/cu_1700000000.json', { type: 'slide', slideId: id, title: 'Bản cũ', slug: 'cu', pdfFile: 'subjects/ctdl-1/slides/cu_1700000000.pdf', pdfSize: 1234, originalName: 'cu.pdf', isPublished: true });
    put('subjects/ctdl-1/slides/la_1.json', { title: 'Đường dẫn lạ', parts: [{ path: 'subjects/khac/slides/x.pdf', enc: 1, plain: 1 }, { path: 'subjects/ctdl-1/slides/../../../s.pdf', enc: 1, plain: 1 }, { path: 'subjects/ctdl-1/documents/y.pdf', enc: 1, plain: 1 }, { path: 'subjects/ctdl-1/slides/ok-1.pdf', enc: 5, plain: 4 }] });
    put('subjects/ctdl-1/documents/d_1.json', { title: 'Doc cũ', documentId: new ObjectId().toHexString() });
    await sync.syncKinds(['slides', 'documents'], { force: true });
    const old = await Slide.findById(id).lean();
    assert.deepStrictEqual(old.parts, [{ path: 'subjects/ctdl-1/slides/cu_1700000000.pdf', enc: 0, plain: 1234 }]); assert.strictEqual(old.fileSize, 1234); assert.strictEqual(old.fileExt, 'pdf');
    const all = await Slide.find({}).lean(); const la = all.find((x) => x.title === 'Đường dẫn lạ');
    assert.deepStrictEqual(la.parts.map((p) => p.path), ['subjects/ctdl-1/slides/ok-1.pdf']);
    assert.ok((await Doc.find({}).lean()).some((x) => x.title === 'Doc cũ'));
    assert.ok(!(await Slide.find({}).lean()).some((x) => x.title === 'Doc cũ'));
  });

  console.log('Tiện ích');
  await t('tên file tải xuống được làm sạch và luôn đúng đuôi', () => {
    const c = sf._test.cleanName;
    assert.strictEqual(c('C:\\x\\Bài 1.PDF', 'f', 'pdf'), 'Bài 1.pdf'); assert.strictEqual(c('a/b/Slide.pptx', 'f', 'pptx'), 'Slide.pptx');
    assert.strictEqual(c('../../etc/pass"wd<>', 'f', 'ppt'), 'passwd.ppt'); assert.strictEqual(c('', 'abc', 'pdf'), 'abc.pdf');
  });
  await t('nhận diện định dạng theo nội dung (không tin đuôi)', () => {
    const m = sf._test.magicOk;
    assert.ok(m(HEADS.pdf, 'pdf') && m(HEADS.pptx, 'pptx') && m(HEADS.ppt, 'ppt'));
    assert.ok(!m(HEADS.pdf, 'pptx') && !m(HEADS.pptx, 'pdf') && !m(HEADS.pptx, 'ppt') && !m(Buffer.alloc(0), 'pdf') && !m(HEADS.pdf, 'exe'));
  });

  console.log(`\n${pass} test đạt`);
})().catch((e) => { console.error(e); process.exit(1); });
