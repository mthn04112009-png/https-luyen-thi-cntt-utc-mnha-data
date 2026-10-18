// services/loginThrottleService.js
// ============================================================
// Chặn dò mật khẩu:
//   - Mỗi (email + IP + thiết bị) được sai tối đa MAX_ATTEMPTS (5) lần.
//   - Sai lần thứ 5 → ghi AUDIT LOG (thời gian, IP, thiết bị) và KHOÁ đúng
//     thiết bị đó LOCK_MS (1 phút) tính từ chính thời điểm sai lần 5/5.
//   - Hết 1 phút → đếm lại từ 0. Đăng nhập đúng → xoá bộ đếm.
//   - Áp dụng cả khi email không tồn tại (cùng thông báo, không lộ email nào có thật).
// "Thiết bị" = IP + User-Agent (trình duyệt/hệ điều hành); không dựa vào cookie
// nên xoá cookie / mở tab ẩn danh không né được.
// ============================================================
const crypto = require('crypto');
const LoginAttempt = require('../models/LoginAttempt');
const AuditLog = require('../models/AuditLog');

const MAX_ATTEMPTS = 5;
const LOCK_MS = 60 * 1000;
const WINDOW_MS = 10 * 60 * 1000; // sai rải rác quá 10 phút thì đếm lại

function getIp(req) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return String(req.ip || xff || (req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '') || 'unknown';
}

// Rút gọn User-Agent thành "Chrome 126 · Windows" cho dễ đọc trong audit log
function describeDevice(ua) {
    const s = String(ua || '');
    if (!s) return 'Không rõ thiết bị';
    let browser = 'Trình duyệt khác';
    let m;
    if ((m = s.match(/Edg(?:e|A|iOS)?\/(\d+)/))) browser = 'Edge ' + m[1];
    else if ((m = s.match(/OPR\/(\d+)/))) browser = 'Opera ' + m[1];
    else if ((m = s.match(/(?:Chrome|CriOS)\/(\d+)/))) browser = 'Chrome ' + m[1];
    else if ((m = s.match(/(?:Firefox|FxiOS)\/(\d+)/))) browser = 'Firefox ' + m[1];
    else if ((m = s.match(/Version\/(\d+).*Safari/))) browser = 'Safari ' + m[1];
    else if (/curl|postman|insomnia|python|axios|node/i.test(s)) browser = s.split(/[\/ ]/)[0];

    let os = 'HĐH không rõ';
    if (/Windows NT 10/.test(s)) os = 'Windows 10/11';
    else if (/Windows/.test(s)) os = 'Windows';
    else if (/Android/.test(s)) os = 'Android';
    else if (/iPhone|iPad|iPod/.test(s)) os = 'iOS';
    else if (/Mac OS X|Macintosh/.test(s)) os = 'macOS';
    else if (/CrOS/.test(s)) os = 'ChromeOS';
    else if (/Linux/.test(s)) os = 'Linux';
    return `${browser} · ${os}`;
}

function identify(req, email) {
    const ip = getIp(req);
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 400);
    const normEmail = String(email || '').trim().toLowerCase();
    const key = crypto.createHash('sha256').update([normEmail, ip, userAgent].join('|')).digest('hex');
    return { key, email: normEmail, ip, userAgent, device: describeDevice(userAgent) };
}

const secondsLeft = (until) => Math.max(1, Math.ceil((new Date(until).getTime() - Date.now()) / 1000));

/** Thiết bị này đang bị khoá không? → { locked, seconds } */
async function check(id) {
    const rec = await LoginAttempt.findOne({ key: id.key }).lean();
    if (rec && rec.lockedUntil && new Date(rec.lockedUntil).getTime() > Date.now()) {
        return { locked: true, seconds: secondsLeft(rec.lockedUntil) };
    }
    return { locked: false, seconds: 0 };
}

/**
 * Ghi nhận 1 lần sai. Trả về:
 *   { locked: bool, seconds, remaining }   (remaining = số lần còn lại trước khi bị khoá)
 * Lần sai thứ 5 → ghi audit log đúng 1 lần (cập nhật có điều kiện, an toàn khi có nhiều request song song).
 */
async function recordFailure(id, extra = {}) {
    const now = new Date();

    // Bản ghi cũ đã hết khoá hoặc quá cửa sổ đếm → bắt đầu lại
    const old = await LoginAttempt.findOne({ key: id.key }).lean();
    if (old) {
        const lockExpired = old.lockedUntil && new Date(old.lockedUntil).getTime() <= now.getTime();
        const stale = old.lastAttemptAt && now.getTime() - new Date(old.lastAttemptAt).getTime() > WINDOW_MS;
        if (lockExpired || stale) await LoginAttempt.deleteOne({ key: id.key });
    }

    const rec = await LoginAttempt.findOneAndUpdate(
        { key: id.key },
        {
            $inc: { count: 1 },
            $set: {
                email: id.email, ip: id.ip, userAgent: id.userAgent, device: id.device,
                lastAttemptAt: now,
                expiresAt: new Date(now.getTime() + WINDOW_MS + LOCK_MS)
            },
            $setOnInsert: { firstAttemptAt: now }
        },
        { upsert: true, new: true }
    ).lean();

    if (rec.count >= MAX_ATTEMPTS) {
        const lockedUntil = new Date(now.getTime() + LOCK_MS);
        // Chỉ request nào đặt được lockedAt (đang null) mới ghi audit log
        const res = await LoginAttempt.updateOne(
            { key: id.key, lockedAt: null },
            { $set: { lockedAt: now, lockedUntil, expiresAt: new Date(lockedUntil.getTime() + 60 * 1000) } }
        );
        if (res.modifiedCount) {
            await AuditLog.create({
                actor: extra.userId || null,
                actorEmail: id.email,
                action: 'login_failed_locked',
                entity: 'Auth',
                entityId: extra.userId || null,
                description:
                    `Đăng nhập sai ${MAX_ATTEMPTS}/${MAX_ATTEMPTS} lần với email "${id.email}" ` +
                    `lúc ${now.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })} ` +
                    `(IP ${id.ip}, ${id.device}). Thiết bị này bị khoá 1 phút.`,
                metadata: {
                    email: id.email,
                    ip: id.ip,
                    device: id.device,
                    userAgent: id.userAgent,
                    attempts: MAX_ATTEMPTS,
                    failedAt: now.toISOString(),
                    lockedUntil: lockedUntil.toISOString(),
                    accountExists: !!extra.userId
                },
                ipAddress: id.ip,
                userAgent: id.userAgent,
                createdAt: now
            });
            return { locked: true, seconds: Math.ceil(LOCK_MS / 1000), remaining: 0 };
        }
        const cur = await LoginAttempt.findOne({ key: id.key }).lean();
        return { locked: true, seconds: secondsLeft(cur && cur.lockedUntil ? cur.lockedUntil : lockedUntil), remaining: 0 };
    }

    return { locked: false, seconds: 0, remaining: MAX_ATTEMPTS - rec.count };
}

async function clear(id) {
    await LoginAttempt.deleteOne({ key: id.key });
}

module.exports = { MAX_ATTEMPTS, LOCK_MS, identify, check, recordFailure, clear, getIp, describeDevice };
