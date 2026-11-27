// Test: up ảnh THẲNG (trình duyệt → Cloudinary duyệt → GitHub bằng token tạm) — services/directImageService.js + connect/cloudinaryStore.js
//   init ký tham số (secret không lộ) → verify hỏi lại Cloudinary + xoá bản Cloudinary + cấp token tạm → done so ảnh đã lưu với ảnh đã duyệt.
//   Từ chối: ảnh nhạy cảm, kết quả duyệt không rõ, phiếu của người khác / dùng lại, ảnh GitHub khác ảnh đã duyệt, đuôi không cho phép, chưa có GitHub App.
// Chạy: node test/direct-image.js  (không cần Mongo / GitHub / Cloudinary thật: fetch được giả lập)
process.env.CONNECT_ENC_KEY = 'connect-key-0123456789-abcdefghijklmnop';
process.env.SESSION_SECRET = 'test-session-secret-abcdefghijklmnop';
for (const k of ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_INSTALLATION_ID', 'IMAGE_DIRECT', 'GH_DIRECT', 'STUDYFILE_DIRECT',
    'IMAGE_DIRECT_TRUST_CLIENT_MODERATION', 'IMAGE_DIRECT_STRICT_HASH']) delete process.env[k];
const Module = require('module'), assert = require('assert'), crypto = require('crypto'), path = require('path');
const ROOT = path.join(__dirname, '..');
const stub = () => new Proxy(function () { }, { get: (t, k) => (k === '__esModule' ? false : stub()), apply: () => stub(), construct: () => stub() });

// ---- GitHub giả (cây file trong RAM) + sổ JSON cho cloudinaryStore
const tree = new Map(), deleted = [], jsonFiles = new Map();
const fakeGh = {
    isConfigured: true, owner: 'o', repo: 'r', branch: 'main',
    async fileExists(p) { return tree.has(p); },
    async readBinaryFileLarge(p) { return tree.has(p) ? tree.get(p) : null; },
    async deleteFile(p) { deleted.push(p); tree.delete(p); },
    async readJsonFile(p) { return jsonFiles.has(p) ? JSON.parse(jsonFiles.get(p)) : null; },
    async readJsonFileWithSha(p) { return jsonFiles.has(p) ? { data: JSON.parse(jsonFiles.get(p)), sha: 'v' + jsonFiles.get(p).length } : null; },
    async writeJsonFileIfSha(p, d) { jsonFiles.set(p, JSON.stringify(d)); }
};
// ---- tài khoản Cloudinary giả (dịch vụ gộp 3 nguồn đã được kiểm riêng ở cloudinaryStore bên dưới)
const ACC = { c1: { cloudName: 'c1', apiKey: '111111', apiSecret: 'SECRET_C1_KHONG_LO' }, c2: { cloudName: 'c2', apiKey: '222222', apiSecret: 'SECRET_C2_KHONG_LO' } };
const fakeAccounts = {
    async resolveAccounts(names) {
        const arr = (Array.isArray(names) ? names : String(names || '').split(',')).map((s) => s.trim()).filter(Boolean);
        if (!arr.length) { const e = new Error('Hãy chọn ít nhất một CLOUDINARY_CLOUD_NAME'); e.status = 400; throw e; }
        return arr.map((n) => { if (!ACC[n]) { const e = new Error('không tồn tại'); e.status = 400; throw e; } return ACC[n]; });
    },
    async listCloudNames() { return Object.keys(ACC); }
};
const real = Module._load;
Module._load = function (req) {
    if (/githubService$/.test(req)) return fakeGh;
    if (/cloudinaryAccountService$/.test(req)) return fakeAccounts;
    if (/^mongoose$/.test(req) || /models\//.test(req)) return stub();
    return real.apply(this, arguments);
};

// ---- Cloudinary + api.github.com giả
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.GITHUB_APP_ID = '12345';
process.env.GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: 'pkcs1', format: 'pem' });
const cloud = { store: new Map(), destroyed: [], minted: 0, mode: 'approved' };   // `${cloud}/${publicId}` → resource
global.fetch = async (url, o = {}) => {
    const u = new URL(String(url)), method = (o.method || 'GET').toUpperCase();
    const J = (status, obj) => ({ status, ok: status < 300, headers: { get: () => null }, json: async () => obj, text: async () => JSON.stringify(obj) });
    if (u.hostname === 'api.cloudinary.com') {
        const m = /^\/v1_1\/([^/]+)\/(.+)$/.exec(u.pathname), cn = m[1], rest = m[2];
        const want = 'Basic ' + Buffer.from(`${ACC[cn].apiKey}:${ACC[cn].apiSecret}`).toString('base64');
        if (rest.startsWith('resources/image/private/')) {
            assert.strictEqual((o.headers || {}).Authorization, want, 'Admin API dùng đúng key/secret');
            const r = cloud.store.get(`${cn}/${decodeURIComponent(rest.split('/').pop())}`);
            return r ? J(200, r) : J(404, { error: { message: 'Resource not found' } });
        }
        if (rest === 'image/destroy') { cloud.destroyed.push(`${cn}/${new URLSearchParams(String(o.body)).get('public_id')}`); return J(200, { result: 'ok' }); }
    }
    if (u.hostname === 'api.github.com') {
        if (u.pathname === '/repos/o/r/installation') return J(200, { id: 77 });
        if (u.pathname === '/app/installations/77/access_tokens') { cloud.minted++; return J(201, { token: 'ghs_TAM', expires_at: '2099-01-01T00:00:00Z' }); }
    }
    return J(404, { message: 'Not Found' });
};

const direct = require(ROOT + '/services/directImageService');
const moderation = require(ROOT + '/services/imageModerationService');
const store = require(ROOT + '/services/connect/cloudinaryStore');
const PNG = (n = 40, fill = 1) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n, fill)]);
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const modOk = (status) => [{ kind: 'aws_rek', status, response: { moderation_labels: [] } }];

let pass = 0; const t = async (name, fn) => { try { cloud.destroyed.length = 0; cloud.minted = 0; cloud.mode = 'approved'; direct._resetForTest(); await fn(); pass++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name, '\n   ', e.stack.split('\n').slice(0, 5).join('\n    ')); process.exitCode = 1; } };
const rejects = async (p, status, code) => { try { await p; } catch (e) { assert.strictEqual(e.status, status, `status ${e.status} ≠ ${status} (${e.message})`); if (code) assert.strictEqual(e.code, code); return e; } assert.fail('đáng lẽ phải bị từ chối'); };
/** "Trình duyệt" up lên Cloudinary theo đúng chữ ký máy chủ cấp → Cloudinary lưu resource như thật. */
function browserUploadsToCloudinary(init, img, over = {}) {
    for (const c of init.clouds) {
        const f = c.fields, acc = ACC[c.cloudName];
        const sig = crypto.createHash('sha1').update(['moderation', 'overwrite', 'public_id', 'timestamp', 'type'].map((k) => `${k}=${f[k]}`).join('&') + acc.apiSecret).digest('hex');
        assert.strictEqual(f.signature, sig, 'chữ ký upload đúng chuẩn Cloudinary');
        cloud.store.set(`${c.cloudName}/${f.public_id}`, { public_id: f.public_id, format: 'png', bytes: img.length, etag: md5(img), moderation: modOk(cloud.mode), ...over });
    }
}
const mkInit = (kind, names = 'c1', mime = 'image/png', size = 48) => direct.init({ kind, userId: 'u1', names, mime, size });

(async () => {
    console.log('Up ảnh thẳng');
    await t('init ký tham số cho từng tài khoản, KHÔNG lộ api_secret', async () => {
        const r = await mkInit('quiz', 'c1,c2');
        assert.strictEqual(r.clouds.length, 2);
        assert.strictEqual(r.clouds[0].fields.type, 'private');
        assert.strictEqual(r.clouds[0].fields.moderation, moderation.MODERATION);
        assert.strictEqual(r.clouds[0].fields.api_key, '111111');
        assert.ok(!JSON.stringify(r).includes('SECRET_C'), 'secret không xuống trình duyệt');
        assert.ok(!r.clouds[0].fields.public_id.includes('/'));
    });
    await t('luồng đầy đủ: duyệt OK → token tạm → ảnh khớp → link raw; bản Cloudinary bị xoá hết', async () => {
        const img = PNG(); const init = await mkInit('quiz', 'c1,c2', 'image/png', img.length);
        browserUploadsToCloudinary(init, img);
        const v = await direct.verify({ kind: 'quiz', userId: 'u1', ticket: init.ticket });
        assert.strictEqual(v.gh.token, 'ghs_TAM'); assert.strictEqual(v.gh.repo, 'r');
        assert.match(v.path, /^cache\/image\/\d+\.png$/); assert.deepStrictEqual(v.moderatedBy, ['c1', 'c2']);
        assert.strictEqual(cloud.destroyed.length, 2, 'xoá ảnh ở cả 2 tài khoản');
        tree.set(v.path, img);                                        // "trình duyệt" PUT lên GitHub
        const d = await direct.done({ kind: 'quiz', userId: 'u1', ticket: v.ticket });
        assert.strictEqual(d.url, `https://raw.githubusercontent.com/o/r/main/${v.path}`); assert.strictEqual(d.mime, 'image/png');
    });
    await t('ảnh nhạy cảm → 422 SENSITIVE_IMAGE, vẫn xoá Cloudinary, KHÔNG cấp token GitHub', async () => {
        cloud.mode = 'rejected';
        const img = PNG(); const init = await mkInit('quiz', 'c1', 'image/png', img.length); browserUploadsToCloudinary(init, img);
        await rejects(direct.verify({ kind: 'quiz', userId: 'u1', ticket: init.ticket }), 422, 'SENSITIVE_IMAGE');
        assert.strictEqual(cloud.destroyed.length, 1); assert.strictEqual(cloud.minted, 0);
    });
    await t('chỉ 1 trong 2 tài khoản từ chối cũng bị chặn', async () => {
        const img = PNG(); const init = await mkInit('quiz', 'c1,c2', 'image/png', img.length); browserUploadsToCloudinary(init, img);
        cloud.store.get(`c2/${init.clouds[1].fields.public_id}`).moderation = modOk('rejected');
        await rejects(direct.verify({ kind: 'quiz', userId: 'u1', ticket: init.ticket }), 422, 'SENSITIVE_IMAGE');
        assert.strictEqual(cloud.minted, 0);
    });
    await t('kết quả duyệt không rõ (add-on chưa bật / Admin API không trả) → 503 MOD_UNVERIFIED (client quay về luồng cũ)', async () => {
        const img = PNG(); const init = await mkInit('quiz', 'c1', 'image/png', img.length);
        browserUploadsToCloudinary(init, img, { moderation: undefined });
        await rejects(direct.verify({ kind: 'quiz', userId: 'u1', ticket: init.ticket }), 503, 'MOD_UNVERIFIED');
        assert.strictEqual(cloud.minted, 0);
    });
    await t('IMAGE_DIRECT_TRUST_CLIENT_MODERATION=1: tin kết quả trình duyệt báo (vẫn kiểm ảnh tồn tại) — và vẫn chặn "rejected" do trình duyệt báo', async () => {
        process.env.IMAGE_DIRECT_TRUST_CLIENT_MODERATION = '1';
        try {
            let img = PNG(); let init = await mkInit('quiz', 'c1', 'image/png', img.length);
            browserUploadsToCloudinary(init, img, { moderation: undefined });
            const v = await direct.verify({ kind: 'quiz', userId: 'u1', ticket: init.ticket, reported: [{ cloudName: 'c1', moderation: modOk('approved') }] });
            assert.ok(v.gh.token);
            direct._resetForTest(); img = PNG(); init = await mkInit('quiz', 'c1', 'image/png', img.length);
            browserUploadsToCloudinary(init, img, { moderation: undefined });
            await rejects(direct.verify({ kind: 'quiz', userId: 'u1', ticket: init.ticket, reported: [{ cloudName: 'c1', moderation: modOk('rejected') }] }), 422, 'SENSITIVE_IMAGE');
            direct._resetForTest(); init = await mkInit('quiz', 'c1', 'image/png', img.length);          // chưa up lên Cloudinary → không tin được
            await rejects(direct.verify({ kind: 'quiz', userId: 'u1', ticket: init.ticket, reported: [{ cloudName: 'c1', moderation: modOk('approved') }] }), 400, 'NOT_UPLOADED');
        } finally { delete process.env.IMAGE_DIRECT_TRUST_CLIENT_MODERATION; }
    });
    await t('trình duyệt nói dối: ghi LÊN GITHUB ảnh khác ảnh đã duyệt → done xoá file + 422 IMAGE_MISMATCH', async () => {
        const clean = PNG(40, 1), evil = PNG(40, 2);                  // cùng kích thước, khác nội dung
        const init = await mkInit('quiz', 'c1', 'image/png', clean.length); browserUploadsToCloudinary(init, clean);
        const v = await direct.verify({ kind: 'quiz', userId: 'u1', ticket: init.ticket });
        tree.set(v.path, evil);
        await rejects(direct.done({ kind: 'quiz', userId: 'u1', ticket: v.ticket }), 422, 'IMAGE_MISMATCH');
        assert.ok(deleted.includes(v.path) && !tree.has(v.path));
    });
    await t('chưa up lên GitHub mà đã gọi done → 400 NOT_ON_GITHUB', async () => {
        const img = PNG(); const init = await mkInit('quiz', 'c1', 'image/png', img.length); browserUploadsToCloudinary(init, img);
        const v = await direct.verify({ kind: 'quiz', userId: 'u1', ticket: init.ticket });
        await rejects(direct.done({ kind: 'quiz', userId: 'u1', ticket: v.ticket }), 400, 'NOT_ON_GITHUB');
    });
    await t('ảnh chưa up lên Cloudinary → 400 NOT_UPLOADED; phiếu của người khác / dùng lại / sai loại → 400 BAD_TICKET', async () => {
        let init = await mkInit('quiz'); await rejects(direct.verify({ kind: 'quiz', userId: 'u1', ticket: init.ticket }), 400, 'NOT_UPLOADED');
        const img = PNG(); init = await mkInit('quiz', 'c1', 'image/png', img.length); browserUploadsToCloudinary(init, img);
        await rejects(direct.verify({ kind: 'quiz', userId: 'u2', ticket: init.ticket }), 400, 'BAD_TICKET');
        await rejects(direct.verify({ kind: 'drawing', userId: 'u1', ticket: init.ticket }), 400, 'BAD_TICKET');
        await rejects(direct.verify({ kind: 'quiz', userId: 'u1', ticket: init.ticket + 'x' }), 400, 'BAD_TICKET');
        await direct.verify({ kind: 'quiz', userId: 'u1', ticket: init.ticket });
        await rejects(direct.verify({ kind: 'quiz', userId: 'u1', ticket: init.ticket }), 400, 'BAD_TICKET');
    });
    await t('ảnh viết tay: đường dẫn tạm drawing-uploads/<user>/<uploadId>.<ext> (khớp token luồng cũ); không nhận GIF', async () => {
        const img = PNG(); const init = await mkInit('drawing', 'c1', 'image/png', img.length); browserUploadsToCloudinary(init, img);
        const v = await direct.verify({ kind: 'drawing', userId: 'u1', ticket: init.ticket });
        assert.match(v.path, /^drawing-uploads\/u1\/[a-f0-9]{24}\.png$/);
        tree.set(v.path, img);
        const d = await direct.done({ kind: 'drawing', userId: 'u1', ticket: v.ticket });
        const tok = moderation.signUploadToken({ userId: 'u1', uploadId: d.uploadId, ext: d.ext });
        assert.deepStrictEqual(moderation.verifyUploadToken(tok, 'u1'), { uploadId: d.uploadId, ext: 'png' });
        await rejects(mkInit('drawing', 'c1', 'image/gif'), 400);
        await rejects(mkInit('quiz', 'c1', 'application/pdf'), 400);
        await rejects(mkInit('quiz', 'c1', 'image/png', 99 * 1024 * 1024), 413);
    });
    await t('Cloudinary báo định dạng thật khác (vd. svg) → 400 BAD_FORMAT, không cấp token', async () => {
        const img = PNG(); const init = await mkInit('quiz', 'c1', 'image/png', img.length); browserUploadsToCloudinary(init, img, { format: 'svg' });
        await rejects(direct.verify({ kind: 'quiz', userId: 'u1', ticket: init.ticket }), 400, 'BAD_FORMAT');
        assert.strictEqual(cloud.minted, 0);
    });
    await t('giới hạn tần suất theo người (quiz 30 / drawing 12 mỗi 10 phút)', async () => {
        for (let i = 0; i < 12; i++) await mkInit('drawing');
        await rejects(mkInit('drawing'), 429);
        await mkInit('quiz');                                          // loại khác có hạn mức riêng
    });
    await t('tắt bằng IMAGE_DIRECT=off hoặc chưa có GitHub App → 503 DIRECT_OFF (client dùng luồng cũ)', async () => {
        process.env.IMAGE_DIRECT = 'off';
        await rejects(mkInit('quiz'), 503, 'DIRECT_OFF'); delete process.env.IMAGE_DIRECT;
        const keep = process.env.GITHUB_APP_PRIVATE_KEY; delete process.env.GITHUB_APP_PRIVATE_KEY;
        try { assert.strictEqual(await direct.isAvailable(), false); await rejects(mkInit('quiz'), 503, 'DIRECT_OFF'); } finally { process.env.GITHUB_APP_PRIVATE_KEY = keep; }
        assert.strictEqual(await direct.isAvailable(), true);
    });
    await t('cloudinaryStore (nhập ở /connect): lưu MÃ HOÁ ở repo chính, đọc lại đúng, key/secret để trống = giữ bản cũ, xoá được', async () => {
        await store.saveAccount({ cloudName: 'demo-cloud', apiKey: '987654321', apiSecret: 'sEcReT-xyz' });
        const raw = jsonFiles.get('v-s/cloudinary.json');
        assert.ok(raw && !raw.includes('987654321') && !raw.includes('sEcReT-xyz'), 'không lưu dạng rõ');
        store.invalidate();
        assert.deepStrictEqual(await store.names(), ['demo-cloud']);
        assert.deepStrictEqual(await store.get('demo-cloud'), { cloudName: 'demo-cloud', apiKey: '987654321', apiSecret: 'sEcReT-xyz' });
        await store.saveAccount({ cloudName: 'demo-cloud', apiKey: '', apiSecret: 'moi-secret' });
        store.invalidate();
        const g = await store.get('demo-cloud'); assert.strictEqual(g.apiKey, '987654321'); assert.strictEqual(g.apiSecret, 'moi-secret');
        assert.strictEqual((await store.summary()).accounts[0].keyHint, '4321');
        await assert.rejects(store.saveAccount({ cloudName: 'x y', apiKey: 'a', apiSecret: 'b' }), /Cloud name/);
        await assert.rejects(store.saveAccount({ cloudName: 'moi', apiKey: '', apiSecret: '' }), /API key/);
        await store.removeAccount('demo-cloud'); store.invalidate();
        assert.deepStrictEqual(await store.names(), []);
    });

    console.log(`\n${pass} test đạt${process.exitCode ? ' — CÓ LỖI' : ''}`);
})();
