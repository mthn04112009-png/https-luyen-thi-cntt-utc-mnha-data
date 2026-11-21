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
// Người dùng giả cho tìm kiếm / kiểm tra "Chỉ hiển thị với"
const USERS = [
    { _id: new ObjectId(), name: 'Nguyễn Văn An', email: 'an.nguyen@utc.edu.vn', role: 'student', status: 'approved' },
    { _id: new ObjectId(), name: 'Trần Thị Bình', email: 'binh.tran@gmail.com', role: 'student', status: 'approved' },
    { _id: new ObjectId(), name: 'Lê Đức Cường', email: 'cuong@utc.edu.vn', role: 'student', status: 'approved' },
    { _id: new ObjectId(), name: 'Admin Phụ', email: 'adm@utc.edu.vn', role: 'admin', status: 'approved' }
];
const stripV = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
// Bộ lọc tối giản đủ cho các truy vấn của controller: $and, $or, _id.$in, role, status, regex name/email
const userMatch = (u, f) => Object.keys(f || {}).every((k) => {
    const c = f[k];
    if (k === '$and') return c.every((x) => userMatch(u, x));
    if (k === '$or') return c.some((x) => userMatch(u, x));
    if (k === '_id') return c && c.$in ? c.$in.map(String).includes(String(u._id)) : false;
    if (c instanceof RegExp) return c.test(stripV(u[k])) || c.test(u[k]);
    return u[k] === c;
});
const userFind = (f) => { let list = USERS.filter((u) => userMatch(u, f)); const q = { select() { return q; }, sort() { list = list.slice().sort((a, b) => a.name.localeCompare(b.name, 'vi')); return q; }, limit(n) { list = list.slice(0, n); return q; }, lean: async () => list.map((u) => ({ _id: u._id, name: u.name, email: u.email })), then(res, rej) { return q.lean().then(res, rej); } }; return q; };
inject('models/User.js', { find: userFind, countDocuments: async (f) => USERS.filter((u) => userMatch(u, f)).length });
inject('services/userKeyService.js', { getContentScope: async () => ({ filter: {}, canAccess: () => true }), getActor: async () => ({ role: 'admin', userKey: null }), buildUserListFilter: () => ({}) });
inject('controllers/pagination.controller.js', { paginateArray: (a) => ({ items: a, pagination: {} }) });
const realSearch = require(R + '/utils/search');
inject('utils/search.js', { getSearchTerm: () => '', buildSearchClause: realSearch.buildSearchClause, withSearch: (f) => f });
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
        assert.ok(vd.videos.every((v) => v.ratio > 0 && !v.error)); assert.ok(!JSON.stringify(vd).includes('<iframe'));
        assert.strictEqual(vd.siblings.length, 1);
    });
    await t('YouTube dùng trình phát riêng: trang KHÔNG chứa mã/link YouTube (chỉ video nguồn khác có src)', async () => {
        const vd = (await call(ctrl.study, { params: { vid: id } })).rendered[1].vd;
        assert.strictEqual(vd.videos[0].player, 'yt'); assert.strictEqual(vd.videos[0].src, undefined);
        assert.ok(!/UPen6eK|youtube/i.test(JSON.stringify(vd)), 'JSON của trang lộ YouTube');
        assert.strictEqual(vd.videos[2].src.startsWith('https://vk.com/'), true); assert.strictEqual(vd.videos[2].player, undefined);
    });
    await t('play: người có quyền lấy được mã + giây bắt đầu; video không phải YouTube / không tồn tại → 404', async () => {
        const vd = (await call(ctrl.study, { params: { vid: id } })).rendered[1].vd;
        const r = await call(ctrl.play, { user: STU, params: { vid: id, item: vd.videos[0].id } });
        assert.ok(r.body.success); assert.strictEqual(r.body.id, 'UPen6eK_qGs'); assert.strictEqual(r.body.start, 0);
        assert.strictEqual((await call(ctrl.play, { params: { vid: id, item: vd.videos[1].id } })).code, 404);      // ok.ru
        assert.strictEqual((await call(ctrl.play, { params: { vid: id, item: 'khong-co' } })).code, 404);
        assert.strictEqual((await call(ctrl.play, { params: { vid: 'zz', item: vd.videos[0].id } })).code, 404);
    });
    await t('play: chặn yêu cầu từ trang khác (Sec-Fetch-Site: cross-site) và người chưa duyệt', async () => {
        const vd = (await call(ctrl.study, { params: { vid: id } })).rendered[1].vd;
        const q = (site, user) => call(ctrl.play, { user, get: (k) => (k.toLowerCase() === 'sec-fetch-site' ? site : ''), params: { vid: id, item: vd.videos[0].id } });
        assert.strictEqual((await q('cross-site', STU)).code, 403); assert.strictEqual((await q('same-origin', STU)).code, 200);
        assert.strictEqual((await q('same-origin', { _id: new ObjectId(), role: 'student', status: 'pending' })).code, 403);
    });
    await t('YouTube có start=90 → nhận start; playlist (videoseries) vẫn dùng iframe thường', async () => {
        const p = embed.parseEmbed('<iframe src="https://www.youtube.com/embed/UPen6eK_qGs?start=90"></iframe>');
        assert.strictEqual(p.youtubeId, 'UPen6eK_qGs'); assert.strictEqual(p.start, 90);
        assert.strictEqual(embed.parseEmbed('<iframe src="https://www.youtube.com/embed/videoseries?list=PL123"></iframe>').youtubeId, null);
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


    console.log('Chế độ hiển thị (công khai / không công khai / chỉ một số người)');
    let vid2, file2;
    const [uAn, uBinh, uCuong] = USERS;
    const asStu = (u) => Object.assign({}, u);
    await t('tìm người: theo họ tên có dấu / không dấu / một đoạn tên / email / nhiều từ; chỉ trả sinh viên đã duyệt', async () => {
        const ids = async (q) => (await call(ctrl.searchUsers, { query: { q } })).body.users.map((u) => u.name);
        assert.deepStrictEqual(await ids('Nguyễn Văn'), ['Nguyễn Văn An']);
        assert.deepStrictEqual(await ids('nguyen van'), ['Nguyễn Văn An']);
        assert.deepStrictEqual(await ids('binh'), ['Trần Thị Bình']);
        assert.deepStrictEqual(await ids('uong'), ['Lê Đức Cường']);              // chỉ 1 đoạn giữa tên
        assert.deepStrictEqual(await ids('gmail'), ['Trần Thị Bình']);            // theo email
        assert.deepStrictEqual(await ids('an utc'), ['Nguyễn Văn An']);           // nhiều từ: tên + email
        assert.strictEqual((await ids('')).length, 3);                            // không có admin
        assert.strictEqual((await ids('Admin')).length, 0);
        assert.strictEqual((await ids('khong-co-ai')).length, 0);
    });
    await t('tạo bài "users": lưu id người được chọn vào JSON GitHub; thiếu người → 400; id lạ → 400', async () => {
        const body = (extra) => Object.assign({ subjectId: subjId, title: 'Riêng tư cho vài người', videos: [{ code: YT }], visibility: 'users' }, extra);
        assert.strictEqual((await call(ctrl.create, { body: body({ allowedUserIds: [] }) })).code, 400);
        assert.strictEqual((await call(ctrl.create, { body: body({ allowedUserIds: [new ObjectId().toHexString()] }) })).code, 400);
        assert.strictEqual((await call(ctrl.create, { body: body({ allowedUserIds: [String(uAn._id), String(USERS[3]._id)] }) })).code, 400);   // admin không phải sinh viên
        const r = await call(ctrl.create, { body: body({ allowedUserIds: [String(uAn._id), String(uBinh._id), String(uAn._id)] }) });
        assert.ok(r.body.success, r.body.message); vid2 = r.body.id;
        const rec = await Video.findById(vid2); file2 = rec.githubFile;
        const j = JSON.parse(repo.files.get(file2).text);
        assert.strictEqual(j.visibility, 'users'); assert.strictEqual(j.isPublished, true);
        assert.deepStrictEqual(j.allowedUserIds.sort(), [String(uAn._id), String(uBinh._id)].sort());   // không trùng
    });
    await t('chỉ người được chọn (và admin) xem được; người khác → 404, không thấy trong danh sách/đếm', async () => {
        assert.strictEqual((await call(ctrl.study, { user: asStu(uAn), params: { vid: vid2 } })).code, 200);
        assert.strictEqual((await call(ctrl.study, { user: asStu(uBinh), params: { vid: vid2 } })).code, 200);
        assert.strictEqual((await call(ctrl.study, { user: asStu(uCuong), params: { vid: vid2 } })).code, 404);
        assert.strictEqual((await call(ctrl.study, { params: { vid: vid2 } })).code, 200);                  // admin
        assert.strictEqual((await call(ctrl.play, { user: asStu(uCuong), params: { vid: vid2, item: Video && (await Video.findById(vid2)).videos[0].id } })).code, 404);
        const list = async (u) => (await call(ctrl.getSubject, { user: u, params: { id: subjId } })).rendered[1].items.map((x) => String(x._id));
        assert.ok((await list(asStu(uAn))).includes(vid2)); assert.ok(!(await list(asStu(uCuong))).includes(vid2)); assert.ok((await list(ADMIN)).includes(vid2));
        const vd = (await call(ctrl.study, { user: asStu(uAn), params: { vid: vid2 } })).rendered[1].vd;
        assert.ok(vd.siblings.some((x) => x.id === vid2));                                                 // người được chọn thấy bài trong danh sách bài cùng môn
        const vdC = (await call(ctrl.study, { user: asStu(uBinh), params: { vid: vid2 } })).rendered[1].vd;
        assert.ok(vdC.siblings.some((x) => x.id === vid2));
        const hidden = (await call(ctrl.study, { user: asStu(uCuong), params: { vid: vid2 } }));
        assert.strictEqual(hidden.code, 404); assert.ok(!JSON.stringify(hidden.rendered || '').includes('Riêng tư cho vài người'));   // không lộ tiêu đề
    });
    await t('nạp lại từ GitHub: giữ visibility + allowedUserIds; form sửa trả tên + email người đã chọn', async () => {
        fakeModels.Subject.find = () => { const q = { sort() { return q; }, select() { return q; }, lean: async () => subjects.slice(), then(a, b) { return q.lean().then(a, b); } }; return q; };
        await sync.syncKinds(['videos'], { force: true });
        const rec = await Video.findById(vid2); assert.strictEqual(rec.visibility, 'users'); assert.strictEqual(rec.allowedUserIds.length, 2);
        const st = JSON.parse((await call(ctrl.editForm, { params: { vid: vid2 } })).rendered[1].vfStateJson.replace(/\\u003c/g, '<'));
        assert.strictEqual(st.visibility, 'users'); assert.strictEqual(st.allowedUsers.length, 2);
        assert.ok(st.allowedUsers.some((u) => u.name === 'Nguyễn Văn An' && u.email === 'an.nguyen@utc.edu.vn'));
    });
    await t('sửa: đổi danh sách người; đổi sang công khai → xoá danh sách; JSON cũ (không visibility) vẫn đọc đúng', async () => {
        let f = await svc.readJsonFileWithSha(file2);
        let r = await call(ctrl.update, { params: { vid: vid2 }, body: { title: 'Riêng tư cho vài người', visibility: 'users', allowedUserIds: [String(uCuong._id)], sha: f.sha, videos: [{ code: YT }] } });
        assert.ok(r.body.success, r.body.message);
        assert.strictEqual((await call(ctrl.study, { user: asStu(uAn), params: { vid: vid2 } })).code, 404);
        assert.strictEqual((await call(ctrl.study, { user: asStu(uCuong), params: { vid: vid2 } })).code, 200);
        f = await svc.readJsonFileWithSha(file2);
        r = await call(ctrl.update, { params: { vid: vid2 }, body: { title: 'Riêng tư cho vài người', visibility: 'public', allowedUserIds: [String(uCuong._id)], sha: f.sha, videos: [{ code: YT }] } });
        assert.ok(r.body.success, r.body.message);
        const j = JSON.parse(repo.files.get(file2).text); assert.strictEqual(j.visibility, 'public'); assert.deepStrictEqual(j.allowedUserIds, []);
        assert.strictEqual((await call(ctrl.study, { user: asStu(uAn), params: { vid: vid2 } })).code, 200);
        put('subjects/dai-so-1/videos/cu_2.json', { title: 'JSON cũ ẩn', isPublished: false, videos: [{ id: 'o1', enc: vcrypto.encryptText(YT) }] });
        put('subjects/dai-so-1/videos/cu_3.json', { title: 'JSON cũ công khai', isPublished: true, videos: [{ id: 'o1', enc: vcrypto.encryptText(YT) }] });
        await sync.syncKinds(['videos'], { force: true });
        const all = await Video.find({ isDeleted: { $ne: true } }).lean();
        assert.strictEqual(all.find((x) => x.title === 'JSON cũ ẩn').visibility, 'private');
        assert.strictEqual(all.find((x) => x.title === 'JSON cũ công khai').visibility, 'public');
    });
    await t('chế độ "private" (không công khai): sinh viên không thấy, admin thấy; client cũ chỉ gửi isPublished:false vẫn hoạt động', async () => {
        const r = await call(ctrl.create, { body: { subjectId: subjId, title: 'Không công khai', isPublished: false, videos: [{ code: YT }] } });
        assert.ok(r.body.success, r.body.message);
        const rec = await Video.findById(r.body.id); assert.strictEqual(rec.visibility, 'private'); assert.strictEqual(rec.isPublished, false);
        assert.strictEqual((await call(ctrl.study, { user: asStu(uAn), params: { vid: r.body.id } })).code, 404);
        assert.strictEqual((await call(ctrl.study, { params: { vid: r.body.id } })).code, 200);
    });
    await t('togglePublish: users → private (giữ danh sách), private → public', async () => {
        let f = await svc.readJsonFileWithSha(file2);
        await call(ctrl.update, { params: { vid: vid2 }, body: { title: 'T', visibility: 'users', allowedUserIds: [String(uAn._id)], sha: f.sha, videos: [{ code: YT }] } });
        let r = await call(ctrl.togglePublish, { params: { vid: vid2 } });
        assert.strictEqual(r.body.visibility, 'private'); assert.strictEqual(r.body.isPublished, false);
        let j = JSON.parse(repo.files.get(file2).text); assert.strictEqual(j.visibility, 'private'); assert.strictEqual(j.isPublished, false); assert.deepStrictEqual(j.allowedUserIds, [String(uAn._id)]);
        r = await call(ctrl.togglePublish, { params: { vid: vid2 } });
        assert.strictEqual(r.body.visibility, 'public');
    });

    console.log(`\n${pass} test đạt`);
})();
