// ============================================================
// POST /webhooks/github — nhận sự kiện `push` từ repo database trên GitHub
// ------------------------------------------------------------
// Cấu hình trên GitHub: Settings → Webhooks → Add webhook
//   Payload URL : https://<domain-của-bạn>/webhooks/github
//   Content type: application/json
//   Secret      : (cùng giá trị GITHUB_WEBHOOK_SECRET trong .env)
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
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
        return res.status(503).json({ ok: false, error: 'GITHUB_WEBHOOK_SECRET chưa được cấu hình.' });
    }
    if (!validSignature(secret, req.rawBody, req.get('x-hub-signature-256'))) {
        return res.status(401).json({ ok: false, error: 'Chữ ký không hợp lệ.' });
    }

    const event = req.get('x-github-event');
    if (event === 'ping') return res.json({ ok: true, pong: true });
    if (event !== 'push') return res.status(202).json({ ok: true, ignored: `event ${event}` });

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
