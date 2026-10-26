// node test/github-pool.js — nhóm repo GitHub (services/githubPool.js): xoay vòng khi đầy, đọc gộp, webhook dung lượng. Không cần mạng.
const assert = require('assert');
const crypto = require('crypto');
const { createPool, MB } = require('../services/githubPool');

// ---- GitHub giả: mỗi repo là 1 Map(path → Buffer) ----
const repos = new Map();            // tên repo → Map
const made = [];                    // repo đã "tạo"
const calls = [];                   // { repo, op, path }
let blobSeq = 0;
function fakeClient(owner, repo) {
    if (!repos.has(repo)) repos.set(repo, new Map());
    const f = repos.get(repo);
    const note = (op, path) => calls.push({ repo, op, path });
    const sha = (p) => 'sha:' + repo + ':' + p + ':' + f.get(p).length;
    const c = {
        isConfigured: true, owner, repo, branch: 'main', _octokit: {},
        blobs: new Map(),
        async getRepoTree() { return { at: Date.now(), files: new Map([...f.keys()].map((p) => [p, sha(p)])), truncated: false }; },
        invalidateTree() {},
        async readJsonFile(p) { note('read', p); return f.has(p) ? JSON.parse(f.get(p)) : null; },
        async readJsonFileWithSha(p) { return f.has(p) ? { data: JSON.parse(f.get(p)), sha: sha(p) } : null; },
        async writeJsonFile(p, d) { note('write', p); f.set(p, Buffer.from(JSON.stringify(d))); return { path: p }; },
        async writeJsonFileIfSha(p, d, expect) {
            const cur = f.has(p) ? sha(p) : null;
            if ((cur || null) !== (expect || null)) { const e = new Error('conflict'); e.code = 'SHA_CONFLICT'; throw e; }
            note('write', p); f.set(p, Buffer.from(JSON.stringify(d))); return { path: p };
        },
        async updateJsonFile(p, fn) { note('update', p); if (!f.has(p)) throw new Error('không tồn tại'); f.set(p, Buffer.from(JSON.stringify(await fn(JSON.parse(f.get(p)))))); return { path: p }; },
        async writeBinaryFile(p, b) { note('write', p); f.set(p, b); return { path: p }; },
        async writeBinaryFileBig(p, b) { note('write', p); f.set(p, b); return { path: p }; },
        async readBinaryFile(p) { return f.get(p) || null; },
        async readBinaryFileLarge(p) { return f.get(p) || null; },
        async deleteFile(p) { note('delete', p); return { deleted: f.delete(p) }; },
        async getFileSha(p) { return f.has(p) ? sha(p) : null; },
        async createBlob(b) { const id = 'blob' + (++blobSeq); c.blobs.set(id, b); return id; },
        async getBlobBuffer(s) {
            if (c.blobs.has(s)) return c.blobs.get(s);
            for (const p of f.keys()) if (sha(p) === s) return f.get(p);
            return null;
        },
        async commitFiles(list) {
            for (const ch of list) {
                note('commit', ch.path);
                if (ch.remove) f.delete(ch.path);
                else if (ch.sha) { if (!c.blobs.has(ch.sha)) { const e = new Error('blob không có'); e.status = 422; throw e; } f.set(ch.path, c.blobs.get(ch.sha)); }
                else f.set(ch.path, ch.content);
            }
            return { commitSha: 'c' + Math.random() };
        }
    };
    return c;
}

const env = { GITHUB_OWNER: 'me', GITHUB_REPO: 'repository-mnha-database', GITHUB_BRANCH: 'main', GITHUB_REPO_LIMIT_MB: '200', GITHUB_WEBHOOK_SECRET: 's3cret' };
const baseClient = fakeClient('me', 'repository-mnha-database');
const extra = new Map();
const hooks = [];
const pool = createPool({
    env, base: () => baseClient,
    createClient: (o) => { if (!extra.has(o.repo)) extra.set(o.repo, fakeClient(o.owner, o.repo)); return extra.get(o.repo); },
    createRepoOnGitHub: async (name) => { made.push(name); repos.set(name, repos.get(name) || new Map()); return { branch: 'main', private: false }; },
    fetchSize: async () => 0,
    ensureWebhook: async (rec) => { hooks.push(rec.repo); return { ok: true }; }
});
const gh = pool.facade();
const json = (o) => Buffer.from(JSON.stringify(o));
const P = (name, fn) => fn().then(() => console.log('✓ ' + name), (e) => { console.error('✗ ' + name + '\n', e); process.exit(1); });

(async () => {
    await P('repo chính chưa đầy → ghi file mới vào repo chính, chưa tạo repo phụ', async () => {
        pool.noteSize('repository-mnha-database', 10 * MB, 'webhook');
        await gh.writeJsonFile('u1/codes/a.json', { a: 1 }, 'm');
        await gh.writeBinaryFile('u1/codes/doc0.docx', Buffer.from('d0'), 'm');
        assert(repos.get('repository-mnha-database').has('u1/codes/a.json'));
        assert.deepStrictEqual(made, []);
        assert.strictEqual(await baseClient.readJsonFile('github/repos/index.json'), null);
    });

    await P('repo chính đạt 200MB → tự tạo repository-mnha-database-1, ghi sổ github/repos/index.json (id/tên/ngày, KHÔNG có dung lượng)', async () => {
        pool.noteSize('repository-mnha-database', 200 * MB, 'webhook');
        await gh.writeJsonFile('u1/codes/b.json', { b: 2 }, 'm');
        assert.deepStrictEqual(made, [], 'JSON không kích hoạt/không vào repo phụ');
        assert(repos.get('repository-mnha-database').has('u1/codes/b.json'));
        await gh.writeBinaryFile('u1/codes/b.docx', Buffer.from('docx-b'), 'm');
        assert.deepStrictEqual(made, ['repository-mnha-database-1']);
        assert(repos.get('repository-mnha-database-1').has('u1/codes/b.docx'));
        assert(!repos.get('repository-mnha-database-1').has('u1/codes/b.json'));
        const idx = await baseClient.readJsonFile('github/repos/index.json');
        assert.strictEqual(idx.repos.length, 1);
        assert.strictEqual(idx.repos[0].id, '1');
        assert.strictEqual(idx.repos[0].repo, 'repository-mnha-database-1');
        assert(!Number.isNaN(Date.parse(idx.repos[0].createdAt)));
        assert(!JSON.stringify(idx).match(/bytes|size/i), 'sổ không được chứa dung lượng');
        assert(repos.get('repository-mnha-database').has('github/repos/index.json'), 'sổ nằm ở repo chính');
        assert.deepStrictEqual(hooks, ['repository-mnha-database-1'], 'repo mới tự gắn webhook');
    });

    await P('đọc gộp: file ở repo chính và repo -1 đều đọc được; cây thư mục gộp', async () => {
        assert.deepStrictEqual(await gh.readJsonFile('u1/codes/a.json'), { a: 1 });
        assert.deepStrictEqual(await gh.readJsonFile('u1/codes/b.json'), { b: 2 });
        assert.strictEqual((await gh.readBinaryFile('u1/codes/b.docx')).toString(), 'docx-b');
        const t = await gh.getRepoTree({ force: true });
        assert(t.files.has('u1/codes/a.json') && t.files.has('u1/codes/b.docx'));
        assert.strictEqual(await gh.readJsonFile('khong/co.json'), null);
        assert.deepStrictEqual(gh.repoForSync('u1/codes/b.docx'), { owner: 'me', repo: 'repository-mnha-database-1', branch: 'main' });
        assert.strictEqual(gh.repoForSync('u1/codes/a.json').repo, 'repository-mnha-database');
    });

    await P('sửa file đã có → ghi đúng repo đang chứa nó (không nhân đôi sang repo mới)', async () => {
        await gh.updateJsonFile('u1/codes/a.json', (d) => ({ ...d, a: 99 }), 'm');
        assert.deepStrictEqual(JSON.parse(repos.get('repository-mnha-database').get('u1/codes/a.json')), { a: 99 });
        assert(!repos.get('repository-mnha-database-1').has('u1/codes/a.json'));
        await gh.writeJsonFile('u1/codes/a.json', { a: 100 }, 'm');
        assert(!repos.get('repository-mnha-database-1').has('u1/codes/a.json'));
        await gh.writeBinaryFile('u1/codes/b.docx', Buffer.from('docx-b2'), 'm');
        assert.strictEqual(repos.get('repository-mnha-database-1').get('u1/codes/b.docx').toString(), 'docx-b2');
        assert(!repos.get('repository-mnha-database').has('u1/codes/b.docx'));
        await gh.deleteFile('u1/codes/b.docx', 'm');
        assert(!repos.get('repository-mnha-database-1').has('u1/codes/b.docx'));
    });

    await P('dữ liệu hệ thống (v-s/, cookies/, mnha-media.json, keys) luôn ở repo chính; mọi .json cũng ở repo chính', async () => {
        for (const p of ['v-s/index.json', 'cookies/index.json', 'u1/codes/html/x/mnha-media.json', 'u2/keys/index.json']) {
            await gh.writeJsonFile(p, { p }, 'm');
            assert(repos.get('repository-mnha-database').has(p), p);
        }
    });

    await P('commitFiles: file mới → repo đang dùng; manifest → repo chính; xoá → repo chứa file; blob createBlob dùng được', async () => {
        const blob = await gh.createBlob(Buffer.from('doan-1'));
        await gh.commitFiles([
            { path: 'u3/codes/html/v/_media/id/seg1.ts', sha: blob },
            { path: 'u3/codes/html/v/info.json', content: json({ j: 1 }) },
            { path: 'u3/codes/html/v/mnha-media.json', content: json({ ok: 1 }) },
            { path: 'u3/codes/html/new.html', content: Buffer.from('<p>x</p>') }
        ], 'media');
        assert.strictEqual(repos.get('repository-mnha-database-1').get('u3/codes/html/v/_media/id/seg1.ts').toString(), 'doan-1');
        assert(repos.get('repository-mnha-database').has('u3/codes/html/v/mnha-media.json'));
        assert(repos.get('repository-mnha-database').has('u3/codes/html/v/info.json'), 'json → repo chính');
        assert(repos.get('repository-mnha-database-1').has('u3/codes/html/new.html'));
        await gh.commitFiles([{ path: 'u1/codes/a.json', remove: true }], 'del');
        assert(!repos.get('repository-mnha-database').has('u1/codes/a.json'));
    });

    await P('repo -1 cũng đầy → tạo -2 (id "2"); sổ giữ cả hai; không tạo trùng', async () => {
        pool.noteSize('repository-mnha-database-1', 205 * MB, 'webhook');
        await new Promise((ok) => setTimeout(ok, 5));
        // active() có cache 30s nhưng kiểm lại dung lượng mỗi lần → thấy đầy
        const [a, b] = await Promise.all([gh.writeBinaryFile('u4/x.pdf', Buffer.from('x'), 'm'), gh.writeBinaryFile('u4/y.pdf', Buffer.from('y'), 'm')]);
        assert.deepStrictEqual(made, ['repository-mnha-database-1', 'repository-mnha-database-2']);
        const idx = await baseClient.readJsonFile('github/repos/index.json');
        assert.deepStrictEqual(idx.repos.map((r) => r.id), ['1', '2']);
        assert(repos.get('repository-mnha-database-2').has('u4/x.pdf') && repos.get('repository-mnha-database-2').has('u4/y.pdf'));
        assert.strictEqual((await gh.readBinaryFile('u3/codes/html/new.html')).toString(), '<p>x</p>', 'file ở repo -1 vẫn đọc được');
    });

    await P('instance mới (RAM trống) đọc sổ rồi dùng tiếp repo mới nhất, không tạo thêm', async () => {
        const pool2 = createPool({
            env, base: () => baseClient, createClient: (o) => { if (!extra.has(o.repo)) extra.set(o.repo, fakeClient(o.owner, o.repo)); return extra.get(o.repo); },
            createRepoOnGitHub: async () => { throw new Error('không được tạo repo'); }, fetchSize: async (rec) => (rec.repo === 'repository-mnha-database-2' ? 5 * MB : 300 * MB),
            ensureWebhook: async () => ({})
        });
        const g2 = pool2.facade();
        await g2.writeBinaryFile('u5/z.pdf', Buffer.from('z'), 'm');
        assert(repos.get('repository-mnha-database-2').has('u5/z.pdf'));
        assert.strictEqual((await g2.readBinaryFile('u4/x.pdf')).toString(), 'x');
    });

    await P('webhook: chữ ký đúng → cập nhật dung lượng (KB → byte) trong RAM; sai chữ ký → 401; repo lạ bị bỏ qua', async () => {
        const mk = (name, size, event = 'push') => {
            const body = Buffer.from(JSON.stringify({ repository: { name, size, owner: { login: 'me' } } }));
            const sig = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(body).digest('hex');
            return { body, headers: { 'x-hub-signature-256': sig, 'x-github-event': event } };
        };
        let w = mk('repository-mnha-database-2', 51200);
        const r = await pool.handleWebhook(w.body, w.headers);
        assert.strictEqual(r.bytes, 50 * MB);
        assert.strictEqual(await pool.sizeOf({ repo: 'repository-mnha-database-2' }), 50 * MB);
        w = mk('repository-mnha-database', 1024, 'ping');
        assert.strictEqual((await pool.handleWebhook(w.body, w.headers)).bytes, MB);
        await assert.rejects(pool.handleWebhook(w.body, { ...w.headers, 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) }), (e) => e.status === 401);
        w = mk('repo-khac', 5);
        assert.ok((await pool.handleWebhook(w.body, w.headers)).ignored);
        w = mk('repository-mnha-database-2', 1, 'issues');
        assert.ok((await pool.handleWebhook(w.body, w.headers)).ignored);
    });

    await P('summary cho trang "Web kết nối": từng repo có dung lượng, % và repo đang ghi', async () => {
        const s = await pool.summary({ force: true });
        assert.deepStrictEqual(s.repos.map((r) => r.id), ['0', '1', '2']);
        const by = Object.fromEntries(s.repos.map((r) => [r.id, r]));
        assert.strictEqual(by['0'].bytes, MB);
        assert(by['1'].full && by['1'].pct === 100);
        assert(by['2'].active && !by['2'].full);
        assert.strictEqual(s.limit, 200 * MB);
        assert.strictEqual(by['2'].source, 'webhook');
    });

    await P('secret webhook tự sinh khi không đặt GITHUB_WEBHOOK_SECRET (cố định giữa các instance) + tự gắn webhook cho mọi repo', async () => {
        const e2 = { GITHUB_OWNER: 'me', GITHUB_REPO: 'repository-mnha-database', SESSION_ENC_KEY: 'k'.repeat(40), MAIN_URL: 'https://web.example.com' };
        const hooked = [];
        const mk = () => createPool({ env: e2, base: () => baseClient, createClient: (o) => { if (!extra.has(o.repo)) extra.set(o.repo, fakeClient(o.owner, o.repo)); return extra.get(o.repo); }, ensureWebhook: async (rec) => { hooked.push(rec.repo); return { ok: true }; } });
        const a = mk(), b = mk();
        assert(a.webhookSecret().length >= 32 && a.webhookSecret() === b.webhookSecret());
        const body = Buffer.from(JSON.stringify({ repository: { name: 'repository-mnha-database', size: 2048, owner: { login: 'me' } } }));
        const sig = 'sha256=' + crypto.createHmac('sha256', a.webhookSecret()).update(body).digest('hex');
        assert.strictEqual((await b.handleWebhook(body, { 'x-hub-signature-256': sig, 'x-github-event': 'push' })).bytes, 2 * MB);
        await a.autoSetup({});
        assert.deepStrictEqual(hooked, ['repository-mnha-database', 'repository-mnha-database-1', 'repository-mnha-database-2']);
        await a.autoSetup({});
        assert.strictEqual(hooked.length, 3, 'chỉ chạy 1 lần');
        const local = createPool({ env: { GITHUB_OWNER: 'me', GITHUB_REPO: 'r', SESSION_ENC_KEY: 'k'.repeat(40) }, base: () => baseClient, createClient: () => null, ensureWebhook: async () => { throw new Error('không được gọi'); } });
        assert.ok((await local.autoSetup({ origin: 'http://localhost:3000' })).skipped, 'localhost → không gắn webhook');
    });

    await P('GITHUB_REPO_POOL=off → enabled() = false', async () => {
        const p = createPool({ env: { ...env, GITHUB_REPO_POOL: 'off' }, base: () => baseClient, createClient: () => null });
        assert.strictEqual(p.enabled(), false);
    });

    console.log('github-pool: tất cả test đạt');
})();
