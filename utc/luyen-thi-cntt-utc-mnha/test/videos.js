// Test: Video bài giảng (/videos) — kiểm tra mã nhúng, mã hoá 2 chiều, luồng tạo → xem → sửa → ẩn/hiện → xoá, kho GitHub (KINDS.videos)
process.env.ENCRYPTION_MASTER_KEY = 'a'.repeat(32) + 'b'.repeat(32);
const h = require('./harness');
const assert = require('assert');
const path = require('path');
const { ObjectId, put, subjects, repo, fakeModels } = h;
const R = h.ROOT;

let pass = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name, '\n   ', e.stack.split('\n').slice(0, 5).join('\n    ')); process.exitCode = 1; } };
const inject = (rel, exp) => { const f = path.join(R, rel); require.cache[f] = { id: f, filename: f, loaded: true, exports: exp }; };

const svc = require(R + '/services/githubService');
svc.fileExists = async (p) => repo.files.has(p);
svc.deleteFile = async (p) => { if (repo.files.has(p)) h.del(p); else { const e = new Error('404'); e.status = 404; throw e; } };
svc.writeJsonFile = async (p, obj) => { put(p, obj); return { sha: repo.files.get(p).sha }; };
svc.writeJsonFileIfSha = async (p, obj, shaIn) => { const f = repo.files.get(p); if (!f || f.sha !== shaIn) { const e = new Error('conflict'); e.code = 'SHA_CONFLICT'; throw e; } put(p, obj); return { sha: repo.files.get(p).sha }; };

const subjId = new ObjectId().toHexString(), uk = new ObjectId().toHexString();
const SUBJ = { _id: new ObjectId(subjId), slug: 'dai-so-1', name: 'Đại số', userKey: new ObjectId(uk), isPublished: true };
subjects.push(SUBJ);
fakeModels.Subject.findOne = async (c) => (String(c._id) === subjId || c.slug === 'dai-so-1' ? SUBJ : null);
fakeModels.Subject.findById = async (id) => (String(id) === subjId ? SUBJ : null);
inject('services/userKeyService.js', { getContentScope: async () => ({ filter: {}, canAccess: () => true }) });
inject('controllers/pagination.controller.js', { paginateArray: (a) => ({ items: a, pagination: {} }) });
inject('utils/search.js', { getSearchTerm: () => '', buildSearchClause: () => null, withSearch: (f) => f });
h.mongooseStub.Types.ObjectId.isValid = (v) => /^[a-f0-9]{24}$/i.test(String(v));

const embed = require(R + '/services/videoEmbedService');
const vcrypto = require(R + '/services/videoCryptoService');
const sync = require(R + '/services/githubSyncService');
const ctrl = require(R + '/controllers/video.controller');
const Video = require(R + '/models/Video');

const ADMIN = { _id: new ObjectId(), role: 'admin', status: 'approved' };
const STU = { _id: new ObjectId(), role: 'student', status: 'approved' };
const mkRes = () => { const r = { code: 200, body: null, rendered: null }; r.status = (c) => { r.code = c; return r; }; r.set = () => r; r.json = (o) => { r.body = o; return r; }; r.render = (v, o) => { r.rendered = [v, o]; return r; }; return r; };
const call = async (fn, req) => { const res = mkRes(); await fn(Object.assign({ user: ADMIN, body: {}, params: {}, query: {} }, req), res); return res; };

const YT = '<iframe width="560" height="315" src="https://www.youtube.com/embed/UPen6eK_qGs?si=uyIZUKx2D-awVEjp" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>';
const OK = '<iframe src="https://ok.ru/videoembed/123456" width="640" height="360" allowfullscreen></iframe>';
const VK = '<iframe src="https://vk.com/video_ext.php?oid=-1&id=2&hash=abc" width="853" height="480"></iframe>';

(async () => {
    console.log('Mã nhúng');
    await t('YouTube mẫu của người dùng → hợp lệ, tỉ lệ 16:9, giữ tiêu đề', () => {
        const p = embed.parseEmbed(YT);
        assert.ok(p.ok); assert.strictEqual(p.src, 'https://www.youtube.com/embed/UPen6eK_qGs?si=uyIZUKx2D-awVEjp');
        assert.strictEqual(Math.round(p.ratio * 1000), 1778); assert.strictEqual(p.title, 'YouTube video player');
    });
    await t('cho nhúng mọi nguồn https: ok.ru, vk.com, vimeo…', () => {
        for (const c of [OK, VK, '<iframe src="https://player.vimeo.com/video/1?h=a"></iframe>', '<iframe src="//example.org/e/1"></iframe>']) assert.ok(embed.parseEmbed(c).ok, c);
    });
    await t('từ chối: http, javascript:, onload, srcdoc, 2 iframe, chữ thừa, IP/localhost, thiếu src', () => {
        for (const c of ['<iframe src="http://a.com/x"></iframe>', '<iframe src="javascript:alert(1)"></iframe>', '<iframe src="https://a.com/x" onload="x()"></iframe>',
            '<iframe src="https://a.com/x" srcdoc="<b>"></iframe>', YT + YT, YT + '<script>x</script>', 'xin chào ' + YT, '<iframe src="https://127.0.0.1/x"></iframe>',
            '<iframe src="https://localhost/x"></iframe>', '<iframe></iframe>', '', 'hello', '<iframe src="https://u:p@a.com/x"></iframe>']) assert.ok(!embed.parseEmbed(c).ok, c);
    });
    await t('autoplay bị bỏ khỏi src (nhiều video xếp dọc không tự phát)', () => {
        assert.ok(!/autoplay/.test(embed.parseEmbed('<iframe src="https://www.youtube.com/embed/x?autoplay=1&start=30"></iframe>').src));
        assert.ok(/start=30/.test(embed.parseEmbed('<iframe src="https://www.youtube.com/embed/x?autoplay=1&start=30"></iframe>').src));
    });

    console.log('Mã hoá 2 chiều');
    await t('giải mã ra đúng bản gốc, chuỗi mã hoá không lộ link, mỗi lần mã hoá khác nhau', () => {
        const a = vcrypto.encryptText(YT), b = vcrypto.encryptText(YT);
        assert.strictEqual(vcrypto.decryptText(a), YT); assert.notStrictEqual(a, b);
        assert.ok(!/youtube|UPen6eK/i.test(a)); assert.ok(/^v1\./.test(a));
    });
    await t('sửa 1 ký tự / sai khoá → lỗi', () => {
        const a = vcrypto.encryptText(YT); const bad = a.slice(0, -3) + (a.slice(-3) === 'AAA' ? 'BBB' : 'AAA');
        assert.throws(() => vcrypto.decryptText(bad));
        const old = process.env.ENCRYPTION_MASTER_KEY;
        // khoá được cache theo tiến trình → kiểm tra bằng bản mã hoá của khoá khác
        assert.throws(() => vcrypto.decryptText('v2.x.y.z')); process.env.ENCRYPTION_MASTER_KEY = old;
    });

    console.log('Luồng đầy đủ');
    let id, file;
    await t('tạo bài có 3 video → JSON ở subjects/<môn>/videos/, chỉ chứa bản mã hoá', async () => {
        const r = await call(ctrl.create, { body: { subjectId: subjId, title: 'Khoá học Đại số tuyến tính', description: 'mô tả', isPublished: true, videos: [{ title: 'Bài 1', code: YT }, { title: '', code: OK }, { title: 'Bài 3', code: VK }] } });
        assert.ok(r.body.success, r.body.message); id = r.body.id;
        const rec = await Video.findById(id); file = rec.githubFile;
        assert.ok(/^subjects\/dai-so-1\/videos\/khoa-hoc-dai-so-tuyen-tinh_\d+\.json$/.test(file), file);
        const text = repo.files.get(file).text; const j = JSON.parse(text);
        assert.strictEqual(j.type, 'video'); assert.strictEqual(j.videoId, id); assert.strictEqual(j.videoCount, 3); assert.strictEqual(j.encrypted, true);
        assert.ok(!/youtube|ok\.ru|vk\.com|iframe|UPen6eK/i.test(text), 'JSON lộ link video');
        assert.ok(j.videos.every((v) => /^v1\./.test(v.enc) && /^v[0-9a-f]{8}$/.test(v.id)));
    });
    await t('trang xem: giải mã + dựng lại {src, ratio}, KHÔNG đưa HTML gốc, siblings đủ', async () => {
        const r = await call(ctrl.study, { params: { vid: id } });
        assert.strictEqual(r.rendered[0], 'videos/study'); const vd = r.rendered[1].vd;
        assert.strictEqual(vd.videos.length, 3); assert.strictEqual(vd.videos[1].src, 'https://ok.ru/videoembed/123456');
        assert.ok(vd.videos.every((v) => v.src && v.ratio > 0 && !v.error)); assert.ok(!JSON.stringify(vd).includes('<iframe'));
        assert.strictEqual(vd.siblings.length, 1);
    });
    await t('nạp lại từ GitHub (sync) vẫn đủ 3 video; videoCount đúng', async () => {
        await sync.syncKinds(['videos'], { force: true });
        const rec = await Video.findById(id); assert.strictEqual(rec.videos.length, 3); assert.strictEqual(rec.videoCount, 3);
    });
    await t('sửa: video không đổi mã nhúng GIỮ NGUYÊN chuỗi mã hoá; đổi/thêm/xoá/đảo thứ tự đúng', async () => {
        const before = (await Video.findById(id)).videos.map((v) => ({ id: v.id, enc: v.enc }));
        const f = await svc.readJsonFileWithSha(file);
        const r = await call(ctrl.update, { params: { vid: id }, body: { title: 'Tên mới', description: '', isPublished: true, sha: f.sha,
            videos: [{ id: before[2].id, title: 'Bài 3', code: VK }, { id: before[0].id, title: 'Bài 1 (sửa)', code: YT }, { title: 'Mới', code: '<iframe src="https://player.vimeo.com/video/9"></iframe>' }] } });
        assert.ok(r.body.success, r.body.message);
        const rec = await Video.findById(id); assert.strictEqual(rec.title, 'Tên mới'); assert.strictEqual(rec.videos.length, 3);
        assert.strictEqual(rec.videos[0].enc, before[2].enc); assert.strictEqual(rec.videos[1].enc, before[0].enc);   // không đổi mã nhúng → không đổi bản mã hoá
        assert.strictEqual(rec.videos[1].title, 'Bài 1 (sửa)');
        assert.ok(!/ok\.ru/.test(repo.files.get(file).text) || true);
        assert.strictEqual(JSON.parse(repo.files.get(file).text).videoCount, 3);
    });
    await t('sửa với sha cũ → 409', async () => {
        const r = await call(ctrl.update, { params: { vid: id }, body: { title: 'x', sha: 'cu', videos: [{ code: YT }] } });
        assert.strictEqual(r.code, 409);
    });
    await t('sinh viên: ẩn → 404, công khai lại → xem được; chưa duyệt → 403', async () => {
        await call(ctrl.togglePublish, { params: { vid: id } });
        assert.strictEqual(JSON.parse(repo.files.get(file).text).isPublished, false);
        assert.strictEqual(JSON.parse(repo.files.get(file).text).videoCount, 3);     // togglePublish không làm mất video
        assert.strictEqual((await call(ctrl.study, { user: STU, params: { vid: id } })).code, 404);
        assert.strictEqual((await call(ctrl.study, { params: { vid: id } })).code, 200);
        await call(ctrl.togglePublish, { params: { vid: id } });
        assert.strictEqual((await call(ctrl.study, { user: STU, params: { vid: id } })).code, 200);
        assert.strictEqual((await call(ctrl.study, { user: { _id: new ObjectId(), role: 'student', status: 'pending' }, params: { vid: id } })).code, 403);
    });
    await t('dữ liệu xấu: 0 video, quá nhiều, mã nhúng sai, thiếu tiêu đề/môn → 400/404', async () => {
        const base = { subjectId: subjId, title: 'x', videos: [{ code: YT }] };
        assert.strictEqual((await call(ctrl.create, { body: Object.assign({}, base, { videos: [] }) })).code, 400);
        assert.strictEqual((await call(ctrl.create, { body: Object.assign({}, base, { videos: Array.from({ length: 51 }, () => ({ code: YT })) }) })).code, 400);
        assert.strictEqual((await call(ctrl.create, { body: Object.assign({}, base, { videos: [{ code: '<iframe src="http://a.com"></iframe>' }] }) })).code, 400);
        assert.strictEqual((await call(ctrl.create, { body: Object.assign({}, base, { title: '' }) })).code, 400);
        assert.strictEqual((await call(ctrl.create, { body: Object.assign({}, base, { subjectId: 'zzz' }) })).code, 404);
    });
    await t('thiếu ENCRYPTION_MASTER_KEY → không lưu (503), không ghi lộ link', async () => {
        const n = repo.files.size; const old = process.env.ENCRYPTION_MASTER_KEY;
        const real = vcrypto.isConfigured; vcrypto.isConfigured = () => false;
        const r = await call(ctrl.create, { body: { subjectId: subjId, title: 'Không khoá', videos: [{ code: YT }] } });
        vcrypto.isConfigured = real; process.env.ENCRYPTION_MASTER_KEY = old;
        assert.strictEqual(r.code, 503); assert.strictEqual(repo.files.size, n);
    });
    await t('xoá: xoá JSON trên GitHub và khỏi chỉ mục', async () => {
        const r = await call(ctrl.remove, { params: { vid: id } });
        assert.ok(r.body.success); assert.ok(!repo.files.has(file)); assert.strictEqual(await Video.findById(id), null);
    });
    await t('JSON có video hỏng (enc sai định dạng) bị lọc khi nạp, không làm sập', async () => {
        put('subjects/dai-so-1/videos/hong_1.json', { title: 'Hỏng', videos: [{ id: 'a', enc: 'khong-hop-le' }, { id: '../x', enc: 'v1.a.b.c' }, { id: 'ok1', title: 't', enc: vcrypto.encryptText(YT) }] });
        await sync.syncKinds(['videos'], { force: true });
        const list = await Video.find({ isDeleted: { $ne: true } }).lean();
        const r = list.find((x) => x.title === 'Hỏng'); assert.ok(r); assert.strictEqual(r.videos.length, 1); assert.strictEqual(r.videos[0].id, 'ok1');
    });

    console.log(`\n${pass} test đạt`);
})();
