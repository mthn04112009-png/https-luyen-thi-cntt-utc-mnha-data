// services/githubPrune.js
// Cắt lịch sử commit của repo dữ liệu GitHub: chỉ giữ commit trong N ngày gần nhất (mặc định 5).
// ⚠ Chỉ hợp repo NHỎ (≤ PRUNE_MAX_REPLAY commit trong cửa sổ, mặc định 60). Repo lớn: github-actions/prune-history.yml.
// Dùng bởi: scripts/prune-history.js (chạy tay) và GET /api/github/prune-history (Vercel Cron hằng ngày, xem vercel.json).
//
// Cách làm (chỉ GitHub API, không clone): gộp mọi commit cũ hơn N ngày thành 1 commit gốc "Snapshot" (giữ nguyên nội dung),
// phát lại các commit trong N ngày lên trên (giữ cây, message, tác giả, ngày), KIỂM TRA cây đầu nhánh mới == cũ rồi mới force-update.
// Nội dung file không đổi; không có gì để cắt thì bỏ qua → chạy lại nhiều lần an toàn.
//
// Biến môi trường (đều tuỳ chọn): PRUNE_HISTORY=off (tắt cron) · PRUNE_HISTORY_DAYS=5 · PRUNE_HISTORY_BACKUP=on (tạo nhánh backup/pre-prune-…,
// mặc định TẮT khi chạy cron vì nhánh backup giữ lại object cũ) · CRON_SECRET (nếu đặt, cron phải gửi đúng Bearer).
// Token cần quyền Contents: Read and write; nhánh không bật chặn force-push. Dung lượng trên GitHub chỉ giảm sau khi GitHub gc.

/**
 * Cắt lịch sử một repo. `octo` có thể là Octokit thật hoặc bản giả (test).
 * @returns {Promise<{status:string, kept?:number, dropped?:string}>}
 */
async function pruneRepo(octo, { owner, repo, branch, days, apply, backup, log = console.log, now = Date.now() }) {
  const cutoff = new Date(now - days * 86400000);
  const tag = `${owner}/${repo}@${branch}`;

  const ref = await octo.git.getRef({ owner, repo, ref: `heads/${branch}` });
  const oldHead = ref.data.object.sha;

  // 1. Các commit trong N ngày (mới → cũ)
  // Mỗi commit giữ lại phải dựng lại bằng 1 request tuần tự (~0,3–0,5s) → quá nhiều thì Vercel (60s) không kịp.
  // Repo lớn do GitHub Actions xử lý (github-actions/prune-history.yml, dùng git thật). Dừng đọc trang ngay khi vượt ngưỡng cho nhanh.
  const maxReplay = Number(process.env.PRUNE_MAX_REPLAY || 60);
  const recent = [];
  for (let page = 1; ; page++) {
    const r = await octo.repos.listCommits({ owner, repo, sha: branch, since: cutoff.toISOString(), per_page: 100, page });
    recent.push(...r.data);
    if (recent.length > maxReplay) { log(`• ${tag}: hơn ${maxReplay} commit trong ${days} ngày — để GitHub Actions xử lý (bỏ qua ở đây).`); return { status: 'too-large' }; }
    if (r.data.length < 100) break;
  }
  if (!recent.length) {
    // Không có commit mới trong N ngày: giữ lại đúng đầu nhánh (để không mất dữ liệu).
    const head = await octo.git.getCommit({ owner, repo, commit_sha: oldHead });
    recent.push({ sha: oldHead, commit: head.data, parents: head.data.parents });
  }
  const oldestRecent = recent[recent.length - 1];
  const parent = (oldestRecent.parents || [])[0];
  if (!parent) { log(`• ${tag}: lịch sử đã nằm gọn trong ${days} ngày — không có gì để cắt.`); return { status: 'noop' }; }

  // Cha của commit cũ nhất trong cửa sổ: nếu đã là commit gốc thì lịch sử đã được cắt rồi.
  const P = await octo.git.getCommit({ owner, repo, commit_sha: parent.sha });
  if (!P.data.parents.length) { log(`• ${tag}: đã được cắt từ trước (mốc là commit gốc) — bỏ qua.`); return { status: 'noop' }; }

  const dropped = await countOlder(octo, { owner, repo, from: parent.sha });
  log(`• ${tag}: giữ ${recent.length} commit (từ ${cutoff.toISOString().slice(0, 10)}), sẽ gộp ${dropped} commit cũ thành 1 commit gốc.`);
  if (!apply) return { status: 'dry-run', kept: recent.length, dropped };

  if (backup) {
    const name = `backup/pre-prune-${new Date(now).toISOString().replace(/[:.]/g, '-')}`;
    await octo.git.createRef({ owner, repo, ref: `refs/heads/${name}`, sha: oldHead });
    log(`  ↳ đã sao lưu đầu nhánh cũ vào nhánh ${name}`);
  }

  // 2. Commit gốc = nội dung ở mốc P
  let prev = (await octo.git.createCommit({
    owner, repo, tree: P.data.tree.sha, parents: [],
    message: `Snapshot: gộp lịch sử trước ${cutoff.toISOString().slice(0, 10)} (giữ ${days} ngày gần nhất)`,
    author: P.data.author, committer: P.data.committer,
  })).data.sha;

  // 3. Phát lại các commit trong cửa sổ (cũ → mới) — cây giữ nguyên
  for (const c of [...recent].reverse()) {
    const cm = c.commit;
    prev = (await octo.git.createCommit({
      owner, repo, tree: cm.tree.sha, parents: [prev], message: cm.message,
      author: cm.author, committer: cm.committer,
    })).data.sha;
  }

  // 4. An toàn: nội dung đầu nhánh mới phải y hệt đầu nhánh cũ (và nhánh chưa bị ai đẩy thêm trong lúc chạy)
  const [newC, oldC, cur] = await Promise.all([
    octo.git.getCommit({ owner, repo, commit_sha: prev }),
    octo.git.getCommit({ owner, repo, commit_sha: oldHead }),
    octo.git.getRef({ owner, repo, ref: `heads/${branch}` }),
  ]);
  if (newC.data.tree.sha !== oldC.data.tree.sha) throw new Error(`${tag}: cây thư mục mới khác cũ — HUỶ, chưa sửa gì.`);
  if (cur.data.object.sha !== oldHead) { log(`  ↳ nhánh vừa có commit mới trong lúc chạy — bỏ lượt này, lần sau chạy lại.`); return { status: 'raced' }; }

  await octo.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: prev, force: true });
  log(`  ↳ xong: ${tag} → ${prev.slice(0, 7)} (${recent.length + 1} commit)`);
  return { status: 'pruned', kept: recent.length, dropped };
}

/** Đếm commit từ `from` lùi về cũ (chỉ để báo cáo). */
async function countOlder(octo, { owner, repo, from }) {
  const all = await octo.paginate(octo.repos.listCommits, { owner, repo, sha: from, per_page: 100 });
  return all.length;
}

async function listRepos(octo, { owner, repo, branch, onlyMain }, env = process.env) {
  const out = [{ owner, repo, branch }];
  if (onlyMain) return out;
  try {
    const r = await octo.repos.getContent({ owner, repo, path: env.GITHUB_REPOS_INDEX_PATH || 'github/repos/index.json', ref: branch });
    const doc = JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8'));
    for (const x of (doc.repos || [])) if (x && x.repo) out.push({ owner, repo: String(x.repo), branch: x.branch || branch });
  } catch (e) {
    if (e.status !== 404) throw e;          // không có sổ repo phụ → chỉ repo chính
  }
  return out;
}


/** Cắt tất cả repo: repo chính + các repo -1, -2… (sổ github/repos/index.json). */
async function pruneAll({ apply = false, days = 5, backup = false, onlyMain = false, deadlineMs = 0, log = console.log, env = process.env, octo } = {}) {
  const token = env.GITHUB_TOKEN, owner = env.GITHUB_OWNER, repo = env.GITHUB_REPO, branch = env.GITHUB_BRANCH || 'main';
  if (!token || !owner || !repo) throw new Error('Cần GITHUB_TOKEN + GITHUB_OWNER + GITHUB_REPO');
  if (!(days >= 1)) throw new Error('days phải >= 1');
  octo = octo || new (require('@octokit/rest').Octokit)({ auth: token, userAgent: 'prune-history' });
  const repos = await listRepos(octo, { owner, repo, branch, onlyMain }, env);
  repos.push(repos.shift());   // repo chính (thường lớn nhất) làm CUỐI để repo nhỏ không bị bỏ lỡ vì hết giờ
  const results = [];
  for (const r of repos) {
    if (deadlineMs && Date.now() > deadlineMs) { results.push({ repo: r.repo, status: 'skipped-time' }); continue; }
    try { results.push({ repo: r.repo, ...(await pruneRepo(octo, { ...r, days, apply, backup, log })) }); }
    catch (e) { log(`❌ ${r.owner}/${r.repo}: ${e.message}`); results.push({ repo: r.repo, status: 'error', error: e.message }); }
  }
  return results;
}

/** Express handler cho Vercel Cron: GET /api/github/prune-history  (?dry=1 để chỉ xem trước). */
async function pruneHandler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== 'Bearer ' + secret) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (String(process.env.PRUNE_HISTORY || 'on').toLowerCase() === 'off') return res.json({ ok: true, disabled: true });
  try {
    const lines = [];
    const results = await pruneAll({
      apply: !(req.query && req.query.dry),
      days: Number(process.env.PRUNE_HISTORY_DAYS || 5),
      backup: String(process.env.PRUNE_HISTORY_BACKUP || 'off').toLowerCase() === 'on',
      deadlineMs: Date.now() + 45000,           // maxDuration 60s → dừng nhận repo mới sau 45s, lần sau làm tiếp
      log: (m) => lines.push(m),
    });
    res.json({ ok: !results.some((r) => r.status === 'error'), results, log: lines });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

module.exports = { pruneRepo, pruneAll, pruneHandler };
