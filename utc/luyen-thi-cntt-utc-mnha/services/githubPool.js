// services/githubPool.js — NHIỀU repo GitHub dữ liệu, tự tạo thêm khi repo đầy.
//
//   GITHUB_REPO=repository-mnha-database           → repo chính (id "0", luôn có)
//   repo chính ≥ 200MB (GITHUB_REPO_LIMIT_MB)      → tự tạo "repository-mnha-database-1", rồi -2, -3 …
//
//   • Sổ đăng ký: github/repos/index.json (nằm ở repo CHÍNH) — chỉ ghi repo ĐÃ TẠO: id, tên repo, ngày tạo.
//       { "v": 1, "base": "repository-mnha-database",
//         "repos": [ { "id": "1", "repo": "repository-mnha-database-1", "createdAt": "…" } ] }
//     Dung lượng KHÔNG lưu trong JSON: lấy từ WEBHOOK push của GitHub (payload.repository.size, KB) và giữ trong RAM.
//     Instance mới chưa nhận webhook nào → hỏi API GitHub 1 lần cho repo đó rồi nhớ (webhook sau đó ghi đè số mới).
//   • JSON (*.json) luôn ở repo CHÍNH. File khác (docx, pdf, ảnh, âm thanh, video, html…): MỚI → repo đang dùng (repo mới nhất chưa đầy);
//     ĐÃ CÓ → ghi đè đúng repo đang chứa nó.
//   • ĐỌC: gộp cây thư mục của mọi repo → file nằm ở repo nào cũng đọc được như cũ.
//   • Tắt hẳn: GITHUB_REPO_POOL=off → hành vi y như trước (một repo).
//
// createPool(deps) nhận phụ thuộc để test không cần mạng (xem test/github-pool.js).
'use strict';
const crypto = require('crypto');

const MB = 1024 * 1024;
const TREE_TTL_MS = 15 * 1000;
const DOC_TTL_MS = 10 * 1000;
const ACTIVE_TTL_MS = 30 * 1000;
const API_SIZE_TTL_MS = 10 * 60 * 1000;      // số đo từ API (không phải webhook) cũ hơn mức này thì hỏi lại

function createPool(deps) {
    const env = deps.env || process.env;
    const base = () => (typeof deps.base === 'function' ? deps.base() : deps.base);   // client repo chính (KHÔNG phải facade)
    const now = () => Date.now();

    const enabled = () => String(env.GITHUB_REPO_POOL || 'on').toLowerCase() !== 'off';
    const INDEX_PATH = () => env.GITHUB_REPOS_INDEX_PATH || 'github/repos/index.json';
    const LIMIT = () => {
        const b = Number(env.GITHUB_REPO_LIMIT_BYTES);
        if (b > 0) return b;
        const m = Number(env.GITHUB_REPO_LIMIT_MB);
        return (m > 0 ? m : 200) * MB;
    };
    const baseName = () => String(env.GITHUB_REPO || base().repo || 'repository');
    const owner = () => String(env.GITHUB_OWNER || base().owner || '');
    const branch = () => String(env.GITHUB_BRANCH || base().branch || 'main');
    // Secret webhook: GITHUB_WEBHOOK_SECRET nếu có; không thì TỰ SINH cố định từ khoá bí mật sẵn có (HMAC) — mọi instance ra cùng một giá trị,
    // không cần đặt tay, không cần lưu ở đâu.
    const webhookSecret = () => {
        if (env.GITHUB_WEBHOOK_SECRET) return String(env.GITHUB_WEBHOOK_SECRET);
        const master = env.SESSION_ENC_KEY || env.CONNECT_ENC_KEY || env.ENCRYPTION_MASTER_KEY || env.MEDIA_ENC_KEY || env.GITHUB_TOKEN || '';
        if (!master) return '';
        return crypto.createHmac('sha256', String(master)).update('mnha-github-webhook|' + baseName()).digest('hex');
    };
    const webhookUrl = (origin) => {
        if (env.GITHUB_WEBHOOK_URL) return String(env.GITHUB_WEBHOOK_URL);
        const main = String(env.MAIN_URL || '').replace(/\/+$/, '')
            || (env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + env.VERCEL_PROJECT_PRODUCTION_URL : '');
        const o = main || (origin ? String(origin).replace(/\/+$/, '') : '');
        return o ? o + (deps.webhookPath || '/api/github/webhook') : '';
    };

    // ------------------------------------------------------------------ trạng thái
    let _doc = null, _docAt = 0, _docPromise = null;
    let _tree = null, _treeAt = 0, _treePromise = null;
    let _active = null, _activeAt = 0, _creating = null;
    const _clients = new Map();                 // tên repo → client
    const sizes = new Map();                    // tên repo → { bytes, at, src: 'webhook'|'api'|'estimate' }
    const recent = new Map();                   // đường dẫn vừa ghi → repo (repoForSync ngay sau khi ghi, khi cây thư mục chưa nạp lại)
    const noteWrite = (p, rec) => { recent.delete(p); recent.set(p, rec); if (recent.size > 500) recent.delete(recent.keys().next().value); };

    const mainRec = () => ({ id: '0', owner: owner(), repo: baseName(), branch: branch(), main: true });
    const blank = () => ({ v: 1, base: baseName(), repos: [], updatedAt: null });

    function normalize(raw) {
        const d = raw && typeof raw === 'object' ? raw : {};
        d.v = 1;
        d.base = baseName();
        d.repos = (Array.isArray(d.repos) ? d.repos : []).filter((r) => r && r.repo && r.id != null)
            .map((r) => ({ id: String(r.id), repo: String(r.repo), createdAt: r.createdAt || null, ...(r.branch ? { branch: String(r.branch) } : {}) }))
            .sort((a, b) => Number(a.id) - Number(b.id));
        return d;
    }
    const recOf = (r) => ({ id: r.id, owner: owner(), repo: r.repo, branch: r.branch || branch(), createdAt: r.createdAt || null, main: false });

    function clientFor(rec) {
        if (!rec || rec.main) return base();
        if (!_clients.has(rec.repo)) {
            _clients.set(rec.repo, deps.createClient({ token: env.GITHUB_TOKEN, owner: rec.owner, repo: rec.repo, branch: rec.branch }));
        }
        return _clients.get(rec.repo);
    }

    async function loadDoc({ force = false } = {}) {
        if (!force && _doc && now() - _docAt < DOC_TTL_MS) return _doc;
        if (_docPromise) return _docPromise;
        _docPromise = (async () => {
            const raw = await base().readJsonFile(INDEX_PATH()).catch(() => null);
            _doc = normalize(raw);
            _docAt = now();
            return _doc;
        })();
        try { return await _docPromise; } finally { _docPromise = null; }
    }

    /** Repo chính + các repo đã tạo (cũ → mới). */
    async function allRecs() {
        const doc = await loadDoc();
        return [mainRec(), ...doc.repos.map(recOf)];
    }

    // ------------------------------------------------------------------ dung lượng (webhook → RAM)
    function noteSize(repoName, bytes, src = 'webhook') {
        const b = Number(bytes);
        if (!repoName || !(b >= 0)) return;
        sizes.set(String(repoName), { bytes: b, at: now(), src });
    }
    function addBytes(rec, n) {
        const v = Number(n) || 0;
        if (!rec || v <= 0) return;
        const cur = sizes.get(rec.repo);
        if (cur) sizes.set(rec.repo, { bytes: cur.bytes + v, at: cur.at, src: cur.src === 'webhook' ? 'webhook' : 'estimate', est: (cur.est || 0) + v });
    }
    async function fetchSizeApi(rec) {
        if (deps.fetchSize) return deps.fetchSize(rec, clientFor(rec));
        const r = await clientFor(rec)._octokit.repos.get({ owner: rec.owner, repo: rec.repo });
        return (Number(r.data && r.data.size) || 0) * 1024;
    }
    /** Dung lượng repo (byte): ưu tiên số từ webhook trong RAM; chưa có → hỏi API 1 lần. */
    async function sizeOf(rec, { force = false } = {}) {
        const hit = sizes.get(rec.repo);
        if (!force && hit && (hit.src === 'webhook' || hit.src === 'estimate' || now() - hit.at < API_SIZE_TTL_MS)) return hit.bytes;
        try {
            const bytes = await fetchSizeApi(rec);
            noteSize(rec.repo, bytes, 'api');
            return bytes;
        } catch (e) {
            if (hit) return hit.bytes;
            console.warn('[githubPool] không đo được dung lượng', rec.repo + ':', e.message);
            return 0;
        }
    }
    const isFull = async (rec) => (await sizeOf(rec)) >= LIMIT();

    // ------------------------------------------------------------------ tạo repo mới
    async function createRepoOnGitHub(name, mainInfo) {
        if (deps.createRepoOnGitHub) return deps.createRepoOnGitHub(name);
        const octo = base()._octokit, o = owner();
        let priv = String(env.GITHUB_REPO_PRIVATE || '').toLowerCase();
        if (priv === 'on' || priv === 'off') priv = priv === 'on';
        else {                                              // mặc định: giống repo chính (public → raw tải thẳng được)
            try { priv = !!(await octo.repos.get({ owner: o, repo: baseName() })).data.private; } catch (_) { priv = true; }
        }
        const desc = 'MNHA database (tự tạo) — ' + baseName();
        let info;
        try {
            const me = await octo.users.getAuthenticated();
            if (String(me.data.login).toLowerCase() === o.toLowerCase()) {
                info = (await octo.repos.createForAuthenticatedUser({ name, private: priv, auto_init: true, description: desc })).data;
            } else {
                info = (await octo.repos.createInOrg({ org: o, name, private: priv, auto_init: true, description: desc })).data;
            }
        } catch (e) {
            if ((e.status || (e.response && e.response.status)) !== 422) throw new Error('Không tạo được repo "' + o + '/' + name + '": ' + e.message);
            info = (await octo.repos.get({ owner: o, repo: name })).data;       // đã tồn tại → dùng tiếp
        }
        return { branch: info.default_branch || branch(), private: !!info.private };
    }

    /** Đăng ký webhook push cho repo (bỏ qua nếu thiếu GITHUB_WEBHOOK_SECRET / địa chỉ web, hoặc đã có). */
    async function ensureWebhook(rec, origin) {
        if (deps.ensureWebhook) return deps.ensureWebhook(rec);
        const url = webhookUrl(origin), secret = webhookSecret();
        if (!url || !secret) return { skipped: true, reason: !secret ? 'Chưa có khoá bí mật để sinh secret webhook' : 'Chưa biết địa chỉ web (đặt MAIN_URL)' };
        const octo = clientFor(rec)._octokit;
        const list = await octo.repos.listWebhooks({ owner: rec.owner, repo: rec.repo, per_page: 100 }).then((r) => r.data).catch(() => []);
        if (list.some((h) => h && h.config && h.config.url === url)) return { ok: true, existed: true };
        await octo.repos.createWebhook({ owner: rec.owner, repo: rec.repo, events: ['push'], active: true, config: { url, content_type: 'json', secret, insecure_ssl: '0' } });
        return { ok: true, created: true };
    }

    /** Tạo repo kế tiếp (afterId = repo đầy mà người gọi vừa thấy). Nhiều instance cùng tạo → cùng một tên, ghi sổ bằng SHA. */
    async function createNext(afterId) {
        if (_creating) return _creating;
        _creating = (async () => {
            let last = null;
            for (let attempt = 0; attempt < 6; attempt++) {
                const cur = await base().readJsonFileWithSha(INDEX_PATH()).catch(() => null);
                const d = normalize(cur ? cur.data : {});
                const newer = d.repos.find((r) => Number(r.id) > Number(afterId || 0));
                if (newer) { _doc = d; _docAt = now(); return recOf(newer); }       // instance khác đã tạo rồi
                const nextId = String((d.repos.length ? Number(d.repos[d.repos.length - 1].id) : 0) + 1);
                const name = `${baseName()}-${nextId}`;
                const made = await createRepoOnGitHub(name);
                const entry = { id: nextId, repo: name, createdAt: new Date().toISOString() };
                if (made && made.branch && made.branch !== branch()) entry.branch = made.branch;
                d.repos.push(entry);
                d.updatedAt = entry.createdAt;
                try {
                    await base().writeJsonFileIfSha(INDEX_PATH(), d, cur ? cur.sha : null, 'github: tạo repo ' + name);
                } catch (e) {
                    last = e;
                    if (e.code !== 'SHA_CONFLICT') throw e;
                    await new Promise((ok) => setTimeout(ok, 200 * (attempt + 1)));
                    continue;
                }
                _doc = d; _docAt = now(); _tree = null;
                const rec = recOf(entry);
                noteSize(rec.repo, 0, 'api');
                ensureWebhook(rec).catch((e) => console.warn('[githubPool] webhook cho', name, 'lỗi:', e.message));
                console.log('🗄️  [githubPool] repo ' + (afterId || 0) + ' đầy → đã tạo ' + name);
                return rec;
            }
            throw last || new Error('Không ghi được github/repos/index.json (xung đột SHA).');
        })();
        try { return await _creating; } finally { _creating = null; }
    }

    /** Repo đang dùng để GHI: repo mới nhất chưa đầy; đầy → tạo repo kế tiếp. */
    async function active() {
        if (_active && now() - _activeAt < ACTIVE_TTL_MS && (await sizeOf(_active)) < LIMIT()) return _active;
        const recs = await allRecs();
        const newest = recs[recs.length - 1];
        const rec = (await isFull(newest)) ? await createNext(newest.id) : newest;
        _active = rec; _activeAt = now();
        return rec;
    }

    // ------------------------------------------------------------------ cây thư mục gộp
    async function mergedTree({ force = false } = {}) {
        if (!force && _tree && now() - _treeAt < TREE_TTL_MS) return _tree;
        if (_treePromise) return _treePromise;
        _treePromise = (async () => {
            const recs = await allRecs();
            const trees = await Promise.all(recs.map((r) => clientFor(r).getRepoTree({ force })));
            const files = new Map(), ownerOf = new Map(), shaOf = new Map();
            let truncated = false;
            trees.forEach((t, i) => {
                const rec = recs[i];
                if (t.truncated) truncated = true;
                for (const [p, sha] of t.files) {
                    if (!files.has(p)) { files.set(p, sha); ownerOf.set(p, rec); }      // trùng đường dẫn: repo cũ hơn thắng
                    if (!shaOf.has(sha)) shaOf.set(sha, rec);
                }
            });
            _tree = { at: now(), files, owner: ownerOf, shaRepo: shaOf, truncated, repos: recs.length };
            _treeAt = now();
            return _tree;
        })();
        try { return await _treePromise; } finally { _treePromise = null; }
    }
    function invalidateTree() {
        _tree = null; _treeAt = 0;
        try { base().invalidateTree(); } catch (_) { /* ignore */ }
        for (const c of _clients.values()) { try { c.invalidateTree(); } catch (_) { /* ignore */ } }
    }

    // Dữ liệu hệ thống luôn ở repo chính (sổ đăng ký, lưu lượng, session, phiếu xem khoá, manifest media).
    const SYSTEM_RE = /^(v-s|cookies|github)\//;
    const isManifest = (p) => /(^|\/)mnha-media\.json$/i.test(p);
    function isPinned(path) {
        const p = String(path || '').replace(/^\/+/, '');
        if (/\.json$/i.test(p)) return true;                         // MỌI file .json luôn ở repo chính; docx, pdf, ảnh, video… mới sang repo -1, -2…
        if (SYSTEM_RE.test(p) || isManifest(p) || /\/keys\//.test(p) || /\.mnha-keys$/i.test(p)) return true;
        for (const k of ['SESSION_INDEX_PATH', 'CONNECT_INDEX_PATH', 'CONNECT_USAGE_PATH', 'CLOUDFLARE_INDEX_PATH', 'MEDIA_REPO_INDEX_PATH', 'GITHUB_REPOS_INDEX_PATH']) {
            if (env[k] && p === String(env[k]).replace(/^\/+/, '')) return true;
        }
        return false;
    }

    /** Repo đang chứa file (null = không thấy). Không thấy → làm mới cây 1 lần nếu cây đã cũ > 2s. */
    async function locate(path) {
        if (isPinned(path)) return { rec: mainRec(), tree: null };
        let t = await mergedTree();
        let rec = t.owner.get(path);
        if (!rec && now() - t.at > 2000) { t = await mergedTree({ force: true }); rec = t.owner.get(path); }
        return { rec: rec || null, tree: t };
    }

    /** Đọc: đúng repo chứa file; cây bị cắt (repo quá lớn) mà không thấy → hỏi lần lượt từng repo. */
    async function readVia(path, method, args) {
        const { rec, tree } = await locate(path);
        if (rec) return clientFor(rec)[method](path, ...args);
        if (tree && tree.truncated) {
            for (const r of await allRecs()) {
                const out = await clientFor(r)[method](path, ...args);
                if (out !== null && out !== undefined) return out;
            }
            return null;
        }
        return method === 'getFileSha' ? null : clientFor(mainRec())[method](path, ...args);
    }

    async function writeRec(path) {
        if (isPinned(path)) return mainRec();
        const { rec } = await locate(path);
        const r = rec || (await active());
        noteWrite(path, r);
        return r;
    }

    // ------------------------------------------------------------------ nhiều thay đổi trong 1 commit
    async function blobBuffer(sha, prefer) {
        const recs = await allRecs();
        const order = prefer ? [prefer, ...recs.filter((r) => r.repo !== prefer.repo)] : recs;
        for (const r of order) {
            try { const b = await clientFor(r).getBlobBuffer(sha); if (b) return b; } catch (_) { /* thử repo kế */ }
        }
        return null;
    }

    async function commitFiles(changes, message) {
        if (!Array.isArray(changes) || !changes.length) return { commitSha: null, skipped: true };
        const groups = new Map();                       // tên repo → { rec, changes[] }
        const add = (rec, c) => {
            let g = groups.get(rec.repo);
            if (!g) { g = { rec, changes: [] }; groups.set(rec.repo, g); }
            g.changes.push(c);
        };
        let act = null;
        for (const c of changes) {
            if (!c || !c.path) throw new Error('commitFiles: thiếu path');
            if (c.remove) { add((await locate(c.path)).rec || mainRec(), c); continue; }
            const rec = isPinned(c.path) ? mainRec() : ((await locate(c.path)).rec || (act || (act = await active())));
            add(rec, c);
        }
        let first = null;
        for (const g of groups.values()) {
            const client = clientFor(g.rec);
            const run = (list) => client.commitFiles(list, message);
            let r;
            try {
                r = await run(g.changes);
            } catch (e) {
                // blob (createBlob) nằm ở repo khác (repo đang dùng đã đổi giữa hai request) → lấy nội dung rồi ghi lại
                const st = e.status || (e.response && e.response.status);
                if (st !== 422 || !g.changes.some((c) => c.sha)) throw e;
                const fixed = [];
                for (const c of g.changes) {
                    if (!c.sha) { fixed.push(c); continue; }
                    const buf = await blobBuffer(c.sha, act);
                    if (!buf) throw e;
                    fixed.push({ path: c.path, content: buf });
                }
                r = await run(fixed);
            }
            for (const c of g.changes) if (c.content) addBytes(g.rec, c.content.length);
            if (r && r.commitSha && !first) first = r.commitSha;
        }
        invalidateTree();
        return { commitSha: first };
    }

    // ------------------------------------------------------------------ facade: cùng giao diện githubService (client mặc định)
    function facade() {
        const f = {
            get isConfigured() { return base().isConfigured; },
            get owner() { return base().owner; },
            get repo() { return base().repo; },
            get branch() { return base().branch; },
            get _octokit() { return base()._octokit; },

            getRepoTree: (o) => mergedTree(o),
            invalidateTree,
            invalidate: () => { /* không cache nội dung */ },

            getFileSha: (p) => readVia(p, 'getFileSha', []),
            fileExists: async (p) => !!(await f.getFileSha(p)),
            readJsonFile: (p) => readVia(p, 'readJsonFile', []),
            readJsonFileWithSha: (p) => readVia(p, 'readJsonFileWithSha', []),
            readBinaryFile: (p) => readVia(p, 'readBinaryFile', []),
            readBinaryFileLarge: (p) => readVia(p, 'readBinaryFileLarge', []),
            getBlobBuffer: async (sha) => {
                const t = _tree || (await mergedTree().catch(() => null));
                const hit = t && t.shaRepo.get(sha);
                if (hit) { const b = await clientFor(hit).getBlobBuffer(sha); if (b) return b; }
                return blobBuffer(sha, _active);
            },
            createBlob: async (buf) => clientFor(await active()).createBlob(buf),

            writeJsonFile: async (p, data, m) => {
                const rec = await writeRec(p);
                const r = await clientFor(rec).writeJsonFile(p, data, m);
                addBytes(rec, Buffer.byteLength(JSON.stringify(data, null, 2))); invalidateTree();
                return r;
            },
            writeJsonFileIfSha: async (p, data, sha, m) => {
                const rec = sha ? ((await locate(p)).rec || mainRec()) : await writeRec(p);
                const r = await clientFor(rec).writeJsonFileIfSha(p, data, sha, m);
                addBytes(rec, Buffer.byteLength(JSON.stringify(data, null, 2))); invalidateTree();
                return r;
            },
            updateJsonFile: async (p, fn, m) => {
                const rec = (await locate(p)).rec || mainRec();
                const r = await clientFor(rec).updateJsonFile(p, fn, m);
                invalidateTree();
                return r;
            },
            writeBinaryFile: async (p, buf, m) => {
                const rec = await writeRec(p);
                const r = await clientFor(rec).writeBinaryFile(p, buf, m);
                addBytes(rec, buf.length); invalidateTree();
                return r;
            },
            writeBinaryFileBig: async (p, buf, m) => {
                const rec = await writeRec(p);
                const r = await clientFor(rec).writeBinaryFileBig(p, buf, m);
                addBytes(rec, buf.length); invalidateTree();
                return r;
            },
            deleteFile: async (p, m) => {
                const rec = (await locate(p)).rec || mainRec();
                const r = await clientFor(rec).deleteFile(p, m);
                invalidateTree();
                return r;
            },
            commitFiles,
            uniqueJsonPath: (dir, opt) => base().uniqueJsonPath(dir, opt),      // JSON luôn ở repo chính

            // Địa chỉ repo của 1 file (keyService.rawUrl, link xem trên GitHub…)
            repoFor: async (p) => {
                const { rec } = await locate(p);
                const r = rec || recent.get(String(p)) || mainRec();
                return { owner: r.owner, repo: r.repo, branch: r.branch };
            },
            repoForSync: (p) => {
                const rec = (!isPinned(p) && ((_tree && _tree.owner.get(String(p))) || recent.get(String(p)))) || mainRec();
                return { owner: rec.owner, repo: rec.repo, branch: rec.branch };
            },
            isPoolRepo: (o, r) => {
                const s = (x) => String(x || '').toLowerCase();
                if (s(o) !== s(owner())) return false;
                const names = [baseName(), ...((_doc && _doc.repos) || []).map((x) => x.repo)];
                return names.some((n) => s(n) === s(r));
            }
        };
        return f;
    }

    // ------------------------------------------------------------------ webhook
    function verifySignature(rawBody, header) {
        const secret = webhookSecret();
        if (!secret) return false;
        const want = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
        const a = Buffer.from(String(header || '')), b = Buffer.from(want);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    }

    /** Payload đã xác thực (push/ping) → ghi dung lượng repo vào RAM. { rec|null, main, bytes, ignored? } */
    async function noteFromPayload(p, event = 'push') {
        const r = p && p.repository;
        if (!r || !r.name) return { rec: null, ignored: 'không có repository' };
        const ownerLogin = r.owner && (r.owner.login || r.owner.name);
        if (ownerLogin && String(ownerLogin).toLowerCase() !== owner().toLowerCase()) return { rec: null, ignored: 'repo của tài khoản khác' };
        const rec = (await allRecs()).find((x) => x.repo.toLowerCase() === String(r.name).toLowerCase());
        if (!rec) return { rec: null, ignored: 'không thuộc nhóm repo dữ liệu' };
        const bytes = typeof r.size === 'number' ? r.size * 1024 : null;
        if (bytes != null) noteSize(rec.repo, bytes, 'webhook');
        if (rec.main) { _doc = null; _docAt = 0; }                      // có thể vừa đổi sổ đăng ký
        if (event === 'push') { _tree = null; _treeAt = 0; }
        return { rec, main: !!rec.main, bytes };
    }

    /** Xử lý 1 webhook GitHub (push/ping): cập nhật dung lượng repo vào RAM. Ném lỗi có .status khi không hợp lệ. */
    async function handleWebhook(rawBody, headers) {
        const bad = (m, status) => Object.assign(new Error(m), { status });
        if (!webhookSecret()) throw bad('Chưa có secret webhook (thiếu SESSION_ENC_KEY / GITHUB_TOKEN để sinh).', 503);
        const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''));
        if (!verifySignature(buf, headers['x-hub-signature-256'])) throw bad('Chữ ký webhook không hợp lệ.', 401);
        const event = String(headers['x-github-event'] || '');
        if (event !== 'push' && event !== 'ping') return { ok: true, ignored: event || 'không rõ sự kiện' };
        let p;
        try { p = JSON.parse(buf.toString('utf8')); } catch (_) { throw bad('Payload không phải JSON.', 400); }
        const out = await noteFromPayload(p, event);
        if (!out.rec) return { ok: true, ignored: out.ignored };
        return { ok: true, event, repo: out.rec.repo, id: out.rec.id, bytes: out.bytes };
    }

    // ------------------------------------------------------------------ trang "Web kết nối"
    async function summary({ force = false } = {}) {
        const doc = await loadDoc({ force }).catch(() => blank());
        const recs = [mainRec(), ...doc.repos.map(recOf)];
        const limit = LIMIT();
        const act = recs[recs.length - 1];
        const rows = await Promise.all(recs.map(async (r) => {
            const bytes = await sizeOf(r);
            const hit = sizes.get(r.repo) || {};
            return {
                id: r.id, owner: r.owner, repo: r.repo, branch: r.branch, main: !!r.main, createdAt: r.createdAt || null,
                bytes, limit, pct: Math.min(100, Math.round((bytes / limit) * 100)), full: bytes >= limit,
                active: r.repo === act.repo, source: hit.src || 'api', sizeAt: hit.at ? new Date(hit.at).toISOString() : null,
                url: `https://github.com/${r.owner}/${r.repo}`
            };
        }));
        return {
            enabled: enabled(), limit, base: baseName(), indexPath: INDEX_PATH(),
            webhookUrl: webhookUrl(), webhookSecretSet: !!webhookSecret(), webhookSecretAuto: !env.GITHUB_WEBHOOK_SECRET,
            repos: rows, totalBytes: rows.reduce((n, x) => n + x.bytes, 0), updatedAt: doc.updatedAt || null
        };
    }

    /** Đăng ký webhook cho mọi repo (nút ở trang Web kết nối). */
    async function registerWebhooks(origin) {
        const out = [];
        for (const r of await allRecs()) {
            try { out.push({ repo: r.repo, ...(await ensureWebhook(r, origin)) }); }
            catch (e) { out.push({ repo: r.repo, error: e.message }); }
        }
        return out;
    }

    /** TỰ gắn webhook push cho mọi repo (chạy 1 lần/tiến trình, không chặn request; lỗi chỉ log). origin = địa chỉ web đang chạy nếu chưa đặt MAIN_URL. */
    let _autoDone = false;
    function autoSetup({ origin } = {}) {
        if (_autoDone || !enabled() || String(env.GITHUB_WEBHOOK_AUTO || 'on').toLowerCase() === 'off') return Promise.resolve({ skipped: true });
        if (String(env.DATA_NODE || '').toLowerCase() === 'on') return Promise.resolve({ skipped: 'web dữ liệu' });
        if (!env.GITHUB_WEBHOOK_URL && !env.MAIN_URL && !env.VERCEL_PROJECT_PRODUCTION_URL) {
            let host = '';
            try { host = new URL(origin).hostname; } catch (_) { host = ''; }
            if (!host || /^(localhost|127\.|10\.|192\.168\.|0\.0\.0\.0)/.test(host) || !host.includes('.')) return Promise.resolve({ skipped: 'chưa có địa chỉ công khai' });
        }
        _autoDone = true;
        return registerWebhooks(origin).then((out) => {
            const bad = out.filter((r) => r.error || r.skipped);
            console.log('🔔 [githubPool] webhook push: ' + (out.length - bad.length) + '/' + out.length + ' repo sẵn sàng' + (bad.length ? ' (' + bad.map((r) => r.repo + ': ' + (r.error || r.reason)).join('; ') + ')' : ''));
            return out;
        }).catch((e) => { _autoDone = false; console.warn('[githubPool] tự gắn webhook lỗi:', e.message); return []; });
    }

    return {
        autoSetup, webhookSecret,
        enabled, LIMIT, INDEX_PATH, facade, active, createNext, mergedTree, invalidateTree, isPinned, loadDoc, allRecs,
        noteSize, sizeOf, addBytes, handleWebhook, noteFromPayload, verifySignature, summary, registerWebhooks, webhookUrl
    };
}

module.exports = { createPool, MB };
