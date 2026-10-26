// ============================================================
// POST /webhooks/github — nhận sự kiện `push` từ repo database trên GitHub
// ------------------------------------------------------------
// Cấu hình trên GitHub: Settings → Webhooks → Add webhook
//   Payload URL : https://<domain-của-bạn>/webhooks/github
//   Content type: application/json
//   Secret      : GITHUB_WEBHOOK_SECRET (không đặt thì tự sinh — webhook cũng được TỰ gắn khi web khởi động, xem githubPool.autoSetup)
//   Events      : Just the push event
//
// Payload liệt kê file thêm / sửa / xoá → githubStore chỉ đọc đúng các file đó,
// slug môn học / bài học lấy ngay từ đường dẫn. Tạo, sửa, xoá file JSON trực
// tiếp trên GitHub (web hoặc git) đều phản ánh lên website trong vài giây.
// ============================================================
const express = require('express');
const crypto = require('crypto');
const githubStore = require('../services/githubStore');

const router = express.Router();
const TIMEOUT_MS = 8000;   // GitHub chờ webhook tối đa 10s

function validSignature(secret, rawBody, header) {
    if (!rawBody || !header || !header.startsWith('sha256=')) return false;
    const expected = Buffer.from('sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex'));
    const given = Buffer.from(header);
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

router.post('/', async (req, res) => {
    // Secret: GITHUB_WEBHOOK_SECRET nếu có, không thì tự sinh từ khoá bí mật sẵn có (githubPool.webhookSecret)
    let secret = process.env.GITHUB_WEBHOOK_SECRET;
    try { const gs = require('../services/githubService'); if (!secret && gs.pool) secret = gs.pool.webhookSecret(); } catch (_) { /* ignore */ }
    if (!secret) {
        return res.status(503).json({ ok: false, error: 'Chưa có secret webhook (thiếu GITHUB_WEBHOOK_SECRET / SESSION_ENC_KEY).' });
    }
    if (!validSignature(secret, req.rawBody, req.get('x-hub-signature-256'))) {
        return res.status(401).json({ ok: false, error: 'Chữ ký không hợp lệ.' });
    }

    const event = req.get('x-github-event');

    // ★ Nhóm repo dữ liệu (githubPool): payload nào cũng mang dung lượng repo → ghi vào RAM.
    //   Repo phụ (-1, -2…) chỉ chứa file nhị phân (JSON luôn ở repo chính) → không cần đồng bộ lessons/submissions.
    let poolNote = null;
    if (event === 'ping' || event === 'push') {
        try {
            const gs = require('../services/githubService');
            if (gs.pool && gs.pooled) poolNote = await gs.pool.noteFromPayload(req.body, event);
        } catch (e) { console.warn('[webhook] ghi dung lượng repo lỗi:', e.message); }
    }
    if (event === 'ping') return res.json({ ok: true, pong: true });
    if (event !== 'push') return res.status(202).json({ ok: true, ignored: `event ${event}` });
    if (poolNote && poolNote.rec && !poolNote.main) return res.json({ ok: true, repo: poolNote.rec.repo, bytes: poolNote.bytes, note: 'repo phụ — chỉ cập nhật dung lượng' });

    // ★ Sửa trực tiếp AI-database/index.json trên GitHub (danh sách nhà cung cấp AI) → nạp lại ngay
    try {
        const commits = (req.body && req.body.commits) || [];
        const touched = commits.some((c) => [...(c.added || []), ...(c.modified || []), ...(c.removed || [])]
            .some((f) => String(f).startsWith('AI-database/')));
        if (touched) {
            await require('../services/aiProviderService').ensureFresh({ force: true }).catch(() => {});
        }
    } catch (_) { /* không ảnh hưởng webhook */ }

    try {
        const result = await Promise.race([
            githubStore.applyPush(req.body),
            new Promise((resolve) => setTimeout(() => resolve({ ok: true, timedOut: true }), TIMEOUT_MS))
        ]);
        if (result && (result.imported || result.updated || result.removed)) {
            console.log(`🔔 [webhook] push: +${result.imported || 0} mới, ~${result.updated || 0} cập nhật, -${result.removed || 0} xoá`);
        }
        return res.json(result || { ok: true });
    } catch (e) {
        // Lỗi không nghiêm trọng: lưới an toàn (kiểm tra đầu nhánh) sẽ bắt kịp ở request kế tiếp
        console.error('[webhook] applyPush lỗi:', e);
        return res.status(500).json({ ok: false, error: e.message });
    }
});

module.exports = router;
