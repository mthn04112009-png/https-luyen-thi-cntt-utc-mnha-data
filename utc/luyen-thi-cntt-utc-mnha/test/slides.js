// Test: Slide học tập — mã hoá PDF theo khung, loại dữ liệu "slides" của githubStore, gộp phần PDF (assemblePdf)
process.env.ENCRYPTION_MASTER_KEY = 'a'.repeat(32) + 'b'.repeat(32);
const h = require('./harness');
const assert = require('assert');
const crypto = require('crypto');
const { ObjectId, put, subjects } = h;
const R = h.ROOT;
const hex = () => new ObjectId().toHexString();

let pass = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name, '\n   ', e.stack.split('\n').slice(0, 4).join('\n    ')); process.exitCode = 1; } };

// ---- GitHub giả: thêm blob ----
const svc = require(R + '/services/githubService');
const blobs = new Map();
svc.createBlob = async (buf) => { const sha = crypto.createHash('sha1').update(buf).digest('hex'); blobs.set(sha, buf); return sha; };
svc.getBlobBuffer = async (sha) => blobs.get(sha) || null;

// ---- stub phần Mongo/phụ trợ của controller ----
const inject = (rel, exp) => { const f = require('path').join(R, rel); require.cache[f] = { id: f, filename: f, loaded: true, exports: exp }; };
inject('services/userKeyService.js', { getContentScope: async () => ({ filter: {}, canAccess: () => true }) });
inject('controllers/pagination.controller.js', { paginateArray: (a) => ({ items: a, pagination: {} }) });
inject('utils/search.js', { getSearchTerm: () => '', buildSearchClause: () => null, withSearch: (f) => f });
h.mongooseStub.Types.ObjectId.isValid = (v) => /^[a-f0-9]{24}$/i.test(String(v));

const crypt = require(R + '/services/slideCryptoService');
const cfg = require(R + '/config/slideConfig');
const store = require(R + '/services/githubStore');
const Slide = require(R + '/models/Slide');
const sync = require(R + '/services/githubSyncService');
const ctrl = require(R + '/controllers/slide.controller');

const fakePdf = (n) => Buffer.concat([Buffer.from('%PDF-1.7\n'), crypto.randomBytes(n)]);

(async () => {
  console.log('Cấu hình');
  await t('giới hạn PDF mặc định 20MB, phần gửi 2MB → tối đa 10 phần', () => {
    assert.strictEqual(cfg.LIMITS.MAX_PDF_BYTES, 20 * 1024 * 1024);
    assert.strictEqual(cfg.LIMITS.UPLOAD_CHUNK_BYTES, 2 * 1024 * 1024);
    assert.strictEqual(cfg.LIMITS.MAX_CHUNKS, 10);
    assert.ok(cfg.LIMITS.SERVE_CHUNK_BYTES * 4 / 3 < 4.5 * 1024 * 1024 || cfg.LIMITS.SERVE_CHUNK_BYTES < 4.5 * 1024 * 1024);
  });

  console.log('Mã hoá');
  await t('mã hoá nhiều khung rồi giải mã lại đúng 100%', () => {
    const pdf = fakePdf(5 * 1024 * 1024 + 123);
    const C = cfg.LIMITS.UPLOAD_CHUNK_BYTES, n = Math.ceil(pdf.length / C);
    const frames = Array.from({ length: n }, (_, i) => crypt.encryptFrame(pdf.subarray(i * C, (i + 1) * C), i, n));
    const file = crypt.joinFrames(frames);
    assert.ok(!file.includes(Buffer.from('%PDF-')), 'file trên GitHub không được lộ "%PDF-"');
    assert.ok(crypt.decryptFile(file).equals(pdf));
  });
  await t('PDF 1 khung (file nhỏ) vẫn chạy', () => {
    const pdf = fakePdf(100);
    assert.ok(crypt.decryptFile(crypt.joinFrames([crypt.encryptFrame(pdf, 0, 1)])).equals(pdf));
  });
  await t('sửa 1 byte → giải mã thất bại', () => {
    const f = crypt.joinFrames([crypt.encryptFrame(fakePdf(500), 0, 1)]);
    f[f.length - 3] ^= 1;
    assert.throws(() => crypt.decryptFile(f));
  });
  await t('đảo thứ tự / bỏ khung / ghép khung của file khác → bị phát hiện', () => {
    const a = fakePdf(300), b = fakePdf(300);
    const f0 = crypt.encryptFrame(a, 0, 2), f1 = crypt.encryptFrame(b, 1, 2);
    assert.throws(() => crypt.decryptFile(crypt.joinFrames([f1, f0])), /[Tt]hứ tự/);
    assert.throws(() => crypt.decryptFile(crypt.joinFrames([f0])), /thiếu khung/);
    const other = crypt.encryptFrame(b, 1, 3);                        // total khác → AAD khác
    assert.throws(() => crypt.decryptFile(crypt.joinFrames([f0, other])));
  });
  await t('sai master key → không giải mã được', () => {
    const f = crypt.joinFrames([crypt.encryptFrame(fakePdf(200), 0, 1)]);
    const old = process.env.ENCRYPTION_MASTER_KEY;
    process.env.ENCRYPTION_MASTER_KEY = 'c'.repeat(64);
    assert.throws(() => crypt.decryptFile(f));
    process.env.ENCRYPTION_MASTER_KEY = old;
  });
  await t('thiếu / sai master key → báo lỗi rõ ràng', () => {
    const old = process.env.ENCRYPTION_MASTER_KEY;
    process.env.ENCRYPTION_MASTER_KEY = 'xyz';
    assert.strictEqual(crypt.isConfigured(), false);
    assert.throws(() => crypt.encryptFrame(Buffer.from('x'), 0, 1), /ENCRYPTION_MASTER_KEY/);
    process.env.ENCRYPTION_MASTER_KEY = old;
  });

  console.log('Kho GitHub (KINDS.slides)');
  const subjId = hex(), uk = hex(), adm = hex(), S1 = hex();
  subjects.push({ _id: new ObjectId(subjId), slug: 'ctdl-1', userKey: new ObjectId(uk) });
  put('subjects/ctdl-1/slides/chuong-1_1760000000.json', {
    type: 'slide', slideId: S1, title: 'Chương 1', slug: 'chuong-1', description: 'mô tả',
    pdfFile: 'subjects/ctdl-1/slides/chuong-1_1760000000.pdf', pdfSize: 1234, originalName: 'C1.pdf',
    isPublished: true, createdBy: adm, createdAt: '2026-10-01T00:00:00Z'
  });
  put('subjects/ctdl-1/slides/doc-hai_1.json', { title: 'PDF trỏ ra ngoài', pdfFile: 'subjects/khac/slides/x.pdf', isPublished: false });
  put('subjects/ctdl-1/slides/doc-ba_1.json', { title: 'PDF trỏ lên cha', pdfFile: 'subjects/ctdl-1/slides/../../../secret.pdf' });
  put('subjects/khong-co/slides/x_1.json', { title: 'môn không tồn tại' });
  put('subjects/ctdl-1/slides/chuong-1_1760000000.pdf.json', { title: 'phải có id ổn định' });

  await t('nạp được slide, bỏ qua slide thuộc môn không tồn tại; .pdf không bị coi là slide', async () => {
    await sync.syncKinds(['slides']);
    assert.strictEqual(await Slide.countDocuments({}), 4);
  });
  await t('field mapping + userKey lấy từ môn học', async () => {
    const s = await Slide.findById(S1).lean();
    assert.strictEqual(s.title, 'Chương 1'); assert.strictEqual(s.pdfSize, 1234); assert.strictEqual(s.originalName, 'C1.pdf');
    assert.strictEqual(s.pdfFile, 'subjects/ctdl-1/slides/chuong-1_1760000000.pdf');
    assert.strictEqual(String(s.userKey), uk); assert.strictEqual(String(s.subjectId), subjId);
  });
  await t('pdfFile trỏ ra ngoài thư mục slides của môn → bị bỏ (null)', async () => {
    const all = await Slide.find({}).lean();
    const out = all.find((x) => x.title === 'PDF trỏ ra ngoài'); const up = all.find((x) => x.title === 'PDF trỏ lên cha');
    assert.strictEqual(out.pdfFile, null); assert.strictEqual(up.pdfFile, null);
  });
  await t('đổi công khai → ghi lại chỉ mục vào JSON, không làm mất pdfFile/originalName', async () => {
    const s = await Slide.findById(S1);
    s.isPublished = false; await s.save();
    const j = JSON.parse(h.repo.files.get('subjects/ctdl-1/slides/chuong-1_1760000000.json').text);
    assert.strictEqual(j.isPublished, false); assert.strictEqual(j.pdfFile, 'subjects/ctdl-1/slides/chuong-1_1760000000.pdf');
    assert.strictEqual(j.originalName, 'C1.pdf'); assert.strictEqual(j.pdfSize, 1234);
  });

  console.log('Gộp phần PDF (assemblePdf)');
  const { assemblePdf, cleanName } = ctrl._test;
  const upload = async (pdf, total) => {
    const C = cfg.LIMITS.UPLOAD_CHUNK_BYTES, shas = [];
    for (let i = 0; i < total; i++) shas.push(await svc.createBlob(crypt.encryptFrame(pdf.subarray(i * C, (i + 1) * C), i, total)));
    return shas;
  };
  await t('PDF 4.5MB (3 phần) gộp được; giải mã ra đúng bản gốc', async () => {
    const pdf = fakePdf(4.5 * 1024 * 1024), C = cfg.LIMITS.UPLOAD_CHUNK_BYTES, n = Math.ceil(pdf.length / C);
    const r = await assemblePdf({ pdf: { name: 'Bài giảng.pdf', shas: await upload(pdf, n) } }, true);
    assert.ok(!r.error, r.error); assert.strictEqual(r.size, pdf.length); assert.strictEqual(r.originalName, 'Bài giảng.pdf');
    assert.ok(crypt.decryptFile(r.encrypted).equals(pdf));
  });
  await t('PDF đúng 20MB (10 phần) được nhận', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(20 * 1024 * 1024 - 9)]);
    assert.strictEqual(pdf.length, 20 * 1024 * 1024);
    const r = await assemblePdf({ pdf: { name: 'x.pdf', shas: await upload(pdf, 10) } }, true);
    assert.ok(!r.error, r.error); assert.strictEqual(r.size, 20 * 1024 * 1024);
  });
  await t('quá 20MB / quá 10 phần → từ chối "quá nặng"', async () => {
    const pdf = fakePdf(20 * 1024 * 1024 + 10);   // 11 phần
    const shas = [];
    for (let i = 0; i < 11; i++) shas.push('0'.repeat(40));
    assert.ok((await assemblePdf({ pdf: { name: 'x.pdf', shas } }, true)).error.includes('quá nặng'));
  });
  await t('thiếu file khi tạo mới → lỗi; khi sửa → giữ file cũ', async () => {
    assert.ok((await assemblePdf({}, true)).error);
    assert.strictEqual((await assemblePdf({}, false)).none, true);
  });
  await t('sha lạ / blob không tồn tại / sai thứ tự → lỗi', async () => {
    assert.ok((await assemblePdf({ pdf: { shas: ['xyz'] } }, true)).error);
    assert.ok((await assemblePdf({ pdf: { shas: ['1'.repeat(40)] } }, true)).error.includes('không còn'));
    const pdf = fakePdf(3 * 1024 * 1024); const s = await upload(pdf, 2);
    assert.ok((await assemblePdf({ pdf: { shas: [s[1], s[0]] } }, true)).error);
  });
  await t('file không phải PDF bị chặn', async () => {
    const sha = await svc.createBlob(crypt.encryptFrame(Buffer.from('hello world, not a pdf'), 0, 1));
    assert.ok((await assemblePdf({ pdf: { name: 'a.pdf', shas: [sha] } }, true)).error.includes('không phải PDF'));
  });
  await t('tên file hiển thị được làm sạch, luôn có đuôi .pdf', () => {
    assert.strictEqual(cleanName('C:\\x\\y\\Bài 1.PDF'), 'Bài 1.pdf');
    assert.strictEqual(cleanName('../../etc/pass"wd<>'), 'passwd.pdf');
    assert.strictEqual(cleanName('', 'abc'), 'abc.pdf');
  });

  console.log(`\n${pass} test đạt`);
})();
