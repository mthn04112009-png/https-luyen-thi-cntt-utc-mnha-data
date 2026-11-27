// Test phía trình duyệt: public/js/directImage.js — đúng thứ tự gọi, tự quay về luồng cũ khi lỗi hạ tầng, DỪNG khi ảnh nhạy cảm.
// Chạy: node test/direct-image.client.js  (fetch / FileReader được giả lập)
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const calls = [];
let script = {};   // url → hàm trả { status, body }
const sandbox = {
    window: {}, console: { warn() { } }, Blob, FormData, Promise, JSON, encodeURIComponent, Object, Error, String, Array,
    FileReader: class { readAsDataURL(b) { b.arrayBuffer().then((ab) => { this.result = 'data:x;base64,' + Buffer.from(ab).toString('base64'); this.onload(); }); } },
    fetch: async (url, o = {}) => {
        calls.push({ url: String(url), method: o.method || 'GET', headers: o.headers, body: o.body });
        const k = Object.keys(script).find((s) => String(url).includes(s));
        if (!k) throw new Error('mạng lỗi ' + url);
        const r = script[k](o); const status = r.status || 200, text = JSON.stringify(r.body || {});
        return { status, ok: status < 300, json: async () => JSON.parse(text), text: async () => text };
    }
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/directImage.js'), 'utf8'), sandbox);
const D = sandbox.window.MnhaDirectImage;
const img = new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8, 9])], { type: 'image/png' });
const base = '/admin/quiz/upload-image';
const happy = () => ({
    [base + '/direct-init']: () => ({ body: { success: true, ticket: 'T1', clouds: [{ cloudName: 'c1', url: 'https://api.cloudinary.com/v1_1/c1/image/upload', fields: { api_key: 'k', signature: 's', public_id: 'p', type: 'private', timestamp: 1, moderation: 'aws_rek', overwrite: 'false' } }] } }),
    'api.cloudinary.com': () => ({ body: { public_id: 'p', moderation: [{ kind: 'aws_rek', status: 'approved' }] } }),
    [base + '/direct-verify']: () => ({ body: { success: true, gh: { owner: 'o', repo: 'r', branch: 'main', token: 'ghs_x' }, path: 'cache/image/1.png', ticket: 'T2', moderatedBy: ['c1'] } }),
    'api.github.com': () => ({ status: 201, body: {} }),
    [base + '/direct-done']: () => ({ body: { success: true, url: 'https://raw/x.png', path: 'cache/image/1.png', moderatedBy: ['c1'] } })
});
let pass = 0; const t = async (n, fn) => { try { calls.length = 0; await fn(); pass++; console.log('  ✓', n); } catch (e) { console.error('  ✗', n, '\n   ', e.stack.split('\n').slice(0, 4).join('\n    ')); process.exitCode = 1; } };
const run = (extra = {}) => D.run({ base, file: img, names: ['c1'], legacy: async () => ({ success: true, legacy: true }), ...extra });

(async () => {
    console.log('Client up ảnh thẳng');
    await t('luồng thẳng: init → Cloudinary → verify → GitHub PUT → done; KHÔNG gọi luồng cũ', async () => {
        script = happy(); let legacy = 0;
        const d = await run({ legacy: async () => { legacy++; return {}; } });
        assert.strictEqual(d.url, 'https://raw/x.png'); assert.strictEqual(legacy, 0);
        assert.deepStrictEqual(calls.map((c) => c.url.replace('https://', '').split('?')[0]),
            ['/admin/quiz/upload-image/direct-init'.slice(1) && base + '/direct-init', 'api.cloudinary.com/v1_1/c1/image/upload', base + '/direct-verify', 'api.github.com/repos/o/r/contents/cache/image/1.png', base + '/direct-done']);
        const put = calls[3]; assert.strictEqual(put.method, 'PUT'); assert.strictEqual(put.headers.Authorization, 'Bearer ghs_x');
        assert.strictEqual(JSON.parse(put.body).branch, 'main'); assert.ok(JSON.parse(put.body).content.length > 0);
        assert.ok(calls[1].body instanceof FormData && calls[1].body.get('file'), 'ảnh gửi bằng FormData thẳng lên Cloudinary');
        assert.strictEqual(JSON.parse(calls[2].body).reported[0].cloudName, 'c1');
    });
    await t('chưa bật up thẳng (503 DIRECT_OFF) → tự dùng luồng cũ', async () => {
        script = happy(); script[base + '/direct-init'] = () => ({ status: 503, body: { success: false, code: 'DIRECT_OFF', message: 'chưa bật' } });
        assert.strictEqual((await run()).legacy, true);
    });
    await t('Cloudinary lỗi (sai chữ ký / CORS) → luồng cũ', async () => {
        script = happy(); script['api.cloudinary.com'] = () => ({ status: 401, body: { error: { message: 'Invalid Signature' } } });
        assert.strictEqual((await run()).legacy, true);
    });
    await t('verify 503 MOD_UNVERIFIED (Admin API không trả trạng thái duyệt) → luồng cũ', async () => {
        script = happy(); script[base + '/direct-verify'] = () => ({ status: 503, body: { success: false, code: 'MOD_UNVERIFIED', message: 'chưa xác nhận' } });
        assert.strictEqual((await run()).legacy, true);
    });
    await t('GitHub từ chối token (401) → luồng cũ', async () => {
        script = happy(); script['api.github.com'] = () => ({ status: 401, body: { message: 'Bad credentials' } });
        assert.strictEqual((await run()).legacy, true);
    });
    await t('ảnh nhạy cảm (422 SENSITIVE_IMAGE) → DỪNG, không GitHub, không luồng cũ', async () => {
        script = happy(); let legacy = 0;
        script[base + '/direct-verify'] = () => ({ status: 422, body: { success: false, code: 'SENSITIVE_IMAGE', message: 'Ảnh bị từ chối vì có nội dung nhạy cảm.' } });
        await assert.rejects(run({ legacy: async () => { legacy++; return {}; } }), /nhạy cảm/);
        assert.strictEqual(legacy, 0); assert.ok(!calls.some((c) => c.url.includes('api.github.com')));
    });
    await t('ảnh GitHub khác ảnh đã duyệt (422 IMAGE_MISMATCH) → DỪNG', async () => {
        script = happy(); script[base + '/direct-done'] = () => ({ status: 422, body: { success: false, code: 'IMAGE_MISMATCH', message: 'Ảnh lưu lên GitHub khác với ảnh đã kiểm duyệt' } });
        await assert.rejects(run(), /khác với ảnh đã kiểm duyệt/);
    });
    await t('429 / 413 từ máy chủ → báo lỗi, không đẩy sang luồng cũ (cũng vô ích)', async () => {
        script = happy(); script[base + '/direct-init'] = () => ({ status: 429, body: { success: false, message: 'Bạn tải ảnh quá nhiều lần' } });
        await assert.rejects(run(), /quá nhiều/);
    });
    await t('mất mạng hoàn toàn → luồng cũ; không có hàm legacy thì ném lỗi', async () => {
        script = {};
        assert.strictEqual((await run()).legacy, true);
        await assert.rejects(D.run({ base, file: img, names: ['c1'] }));
    });
    console.log(`\n${pass} test đạt${process.exitCode ? ' — CÓ LỖI' : ''}`);
})();
