const bcrypt = require('bcrypt');
const crypto = require('crypto');

const User = require('../models/User');
const OTP = require('../models/OTP');
const { sendOTP } = require('../services/mailService');
const loginThrottle = require('../services/loginThrottleService');

// ============================================================
// HẰNG SỐ
// ============================================================
// Thời gian sống của OTP lấy từ models/OTP.js (10 phút, Mongo tự xoá bằng TTL index)
const { OTP_TTL_MS } = OTP;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;

const IS_DEV = process.env.NODE_ENV !== 'production';
const isDataNode = () => String(process.env.DATA_NODE || '').toLowerCase() === 'on';

// ============================================================
// HELPERS
// ============================================================
function genOTP() {
    return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function normalizeEmail(e) {
    return String(e || '').trim().toLowerCase();
}

function normalizeCode(input) {
    return String(input || '').replace(/\D/g, '').slice(0, 6);
}

function buildSessionUser(user) {
    const idStr = String(user._id);
    return {
        _id: idStr,
        id: idStr,
        name: user.name,
        email: user.email,
        role: user.role,
        status: user.status,
        userKey: user.userKey ? String(user.userKey) : null
    };
}

/**
 * ★ FIX BUG SESSION: express-session lưu vào store BẤT ĐỒNG BỘ.
 * Nếu redirect ngay sau khi set session, request tiếp theo có thể
 * đến trước khi session ghi xong → mất dữ liệu session.
 *
 * → Bắt buộc await saveSession(req) trước mỗi res.redirect() / render()
 *    khi vừa thay đổi session.
 */
function saveSession(req) {
    return new Promise((resolve) => {
        if (!req.session) return resolve();
        req.session.save((err) => {
            if (err) console.error('[saveSession] Lỗi lưu session:', err);
            resolve();
        });
    });
}

// ============================================================
// ĐĂNG NHẬP
// ============================================================
const showLogin = (req, res) => {
    if (req.session && req.session.user) {
        return res.redirect('/');
    }

    return res.render('auth/login', {
        title: 'Đăng nhập',
        registered: req.query.registered === '1',
        otpVerified: req.query.otp === '1',
        resetSuccess: req.query.reset === '1',
        email: req.query.email || '',
        error: null
    });
};

const LOGIN_FAIL_MSG = 'Email hoặc mật khẩu không chính xác.';
const lockMessage = (sec) =>
    `Bạn đã nhập sai 5/5 lần. Thiết bị này bị tạm khoá, vui lòng thử lại sau ${sec} giây.`;

const login = async (req, res) => {
    try {
        const { email, password, remember } = req.body;

        if (!email || !password) {
            return res.status(400).render('auth/login', {
                title: 'Đăng nhập',
                error: 'Vui lòng nhập email và mật khẩu.',
                email
            });
        }

        // ★ Thiết bị (IP + trình duyệt) đang bị khoá do sai 5/5 → không kiểm tra mật khẩu nữa
        const device = loginThrottle.identify(req, email);
        const gate = await loginThrottle.check(device);
        if (gate.locked) {
            res.set('Retry-After', String(gate.seconds));
            return res.status(429).render('auth/login', {
                title: 'Đăng nhập',
                error: lockMessage(gate.seconds),
                lockedSeconds: gate.seconds,
                email
            });
        }

        const user = await User.findOne({
            email: normalizeEmail(email)
        }).select('+password');

        const validPassword = user ? await bcrypt.compare(password, user.password) : false;

        if (!user || !validPassword) {
            const fail = await loginThrottle.recordFailure(device, { userId: user ? user._id : null });
            if (fail.locked) {
                res.set('Retry-After', String(fail.seconds));
                return res.status(429).render('auth/login', {
                    title: 'Đăng nhập',
                    error: lockMessage(fail.seconds),
                    lockedSeconds: fail.seconds,
                    email
                });
            }
            return res.status(401).render('auth/login', {
                title: 'Đăng nhập',
                error: `${LOGIN_FAIL_MSG} Bạn còn ${fail.remaining} lần thử.`,
                email
            });
        }

        // Đúng mật khẩu → xoá bộ đếm sai của thiết bị này
        await loginThrottle.clear(device);

        if (user.status === 'rejected' || user.status === 'disabled') {
            return res.status(403).render('auth/login', {
                title: 'Đăng nhập',
                error:
                    user.status === 'rejected'
                        ? 'Tài khoản của bạn đã bị từ chối.'
                        : 'Tài khoản của bạn đã bị vô hiệu hoá.',
                email
            });
        }

        // ★ Web dữ liệu: CHỈ admin mặc định (role=admin, userKey=null). Admin tổ chức / student / client bị từ chối.
        if (isDataNode() && !(user.role === 'admin' && !user.userKey)) {
            return res.status(403).render('auth/login', {
                title: 'Đăng nhập',
                error: 'Web dữ liệu chỉ cho phép quản trị viên mặc định đăng nhập (role=admin, userKey=null).',
                email
            });
        }

        req.session.user = buildSessionUser(user);

        // ★ Web dữ liệu: lần đăng nhập đầu của admin mặc định → tự tạo khoá kết nối + ghi v-s/index.json.
        if (isDataNode() && user.role === 'admin' && !user.userKey) {
            try {
                await require('../connect/vercel').onAdminLogin(req, user);
            } catch (e) {
                console.warn('[login] không đăng ký web dữ liệu:', e.message);
            }
        }

        if (remember) {
            req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
        }

        user.lastLoginAt = new Date();
        await user.save({ validateBeforeSave: false });

        // ★ FIX: lưu session trước khi redirect
        await saveSession(req);

        if (user.role === 'admin') {
            return res.redirect('/admin/dashboard');
        }
        if (user.role === 'client' || user.status === 'pending') {
            return res.redirect('/pages');
        }
        return res.redirect('/subjects');
    } catch (error) {
        console.error('Login error:', error);
        return res.status(500).render('auth/login', {
            title: 'Đăng nhập',
            error: 'Đã xảy ra lỗi khi đăng nhập.',
            email: req.body.email
        });
    }
};

// ============================================================
// ĐĂNG KÝ — GIAI ĐOẠN 1
// ============================================================
const showRegister = (req, res) => {
    if (req.session && req.session.user) {
        return res.redirect('/');
    }

    return res.render('auth/register', {
        title: 'Đăng ký'
    });
};

const register = async (req, res) => {
    try {
        const { name, email, password, confirmPassword } = req.body;

        if (!name || !email || !password || !confirmPassword) {
            return res.status(400).render('auth/register', {
                title: 'Đăng ký',
                error: 'Vui lòng nhập đầy đủ thông tin.',
                name,
                email
            });
        }

        if (password !== confirmPassword) {
            return res.status(400).render('auth/register', {
                title: 'Đăng ký',
                error: 'Mật khẩu xác nhận không khớp.',
                name,
                email
            });
        }

        if (password.length < 8) {
            return res.status(400).render('auth/register', {
                title: 'Đăng ký',
                error: 'Mật khẩu phải có ít nhất 8 ký tự.',
                name,
                email
            });
        }

        const normalizedEmail = normalizeEmail(email);

        const existingUser = await User.findOne({ email: normalizedEmail });
        if (existingUser) {
            return res.status(409).render('auth/register', {
                title: 'Đăng ký',
                error: 'Email này đã được sử dụng.',
                name,
                email
            });
        }

        // ★ USER KEY: đăng ký KHÔNG nhập mã tổ chức. User luôn vào tổ chức default
        //   (userKey = null); admin gán tổ chức khi duyệt (xem resolveApproval).

        const existingOTP = await OTP.findOne({
            email: normalizedEmail,
            type: 'register'
        });

        if (
            existingOTP &&
            Date.now() - existingOTP.updatedAt.getTime() <
                OTP_RESEND_COOLDOWN_MS
        ) {
            return res.status(429).render('auth/verify-otp', {
                title: 'Xác minh OTP',
                email: normalizedEmail,
                error: 'Vui lòng chờ một phút trước khi yêu cầu mã mới.',
                success: null,
                debugOtp: IS_DEV ? existingOTP.code : null
            });
        }

        await OTP.deleteMany({ email: normalizedEmail, type: 'register' });

        const code = genOTP();
        const passwordHash = await bcrypt.hash(password, 12);

        await OTP.create({
            email: normalizedEmail,
            code,
            type: 'register',
            expiresAt: new Date(Date.now() + OTP_TTL_MS),
            payload: {
                name: name.trim(),
                email: normalizedEmail,
                passwordHash
            }
        });

        await sendOTP(normalizedEmail, code, 'register');

        req.session.pendingEmail = normalizedEmail;

        // ★ FIX: lưu session trước khi redirect
        await saveSession(req);

        console.log(`[register] Đã tạo OTP cho ${normalizedEmail}: ${code}`);

        return res.redirect('/auth/verify-otp');
    } catch (error) {
        console.error('Register error:', error);
        return res.status(500).render('auth/register', {
            title: 'Đăng ký',
            error: 'Đã xảy ra lỗi khi đăng ký. Vui lòng thử lại.',
            name: req.body.name,
            email: req.body.email
        });
    }
};

// ============================================================
// ĐĂNG KÝ — GIAI ĐOẠN 2: trang nhập OTP
// ============================================================
const showVerifyOtp = async (req, res) => {
    try {
        const email = req.session?.pendingEmail || req.query.email || '';

        if (!email) {
            return res.redirect('/auth/register');
        }

        let debugOtp = null;
        if (IS_DEV) {
            const otpDoc = await OTP.findOne({ email, type: 'register' });
            if (otpDoc && otpDoc.expiresAt > new Date()) {
                debugOtp = otpDoc.code;
            }
        }

        return res.render('auth/verify-otp', {
            title: 'Xác minh OTP',
            email,
            error: null,
            success: null,
            debugOtp
        });
    } catch (err) {
        console.error('[showVerifyOtp]', err);
        return res.redirect('/auth/register');
    }
};

// ============================================================
// ĐĂNG KÝ — GIAI ĐOẠN 3: kiểm tra OTP, tạo User
// ============================================================
const verifyOtp = async (req, res) => {
    try {
        const email = normalizeEmail(
            req.session?.pendingEmail || req.body.email
        );

        const rawInput = req.body.code || '';
        const code = normalizeCode(rawInput);

        if (!email || !code) {
            let debugOtp = null;
            if (IS_DEV) {
                const doc = await OTP.findOne({ email, type: 'register' });
                if (doc) debugOtp = doc.code;
            }
            return res.status(400).render('auth/verify-otp', {
                title: 'Xác minh OTP',
                email,
                error: 'Vui lòng nhập đủ 6 chữ số OTP.',
                success: null,
                debugOtp
            });
        }

        const otpDoc = await OTP.findOne({ email, type: 'register' });

        const renderErr = async (msg, status = 400, useOtpDoc = otpDoc) => {
            let debugOtp = null;
            if (IS_DEV && useOtpDoc) {
                debugOtp = useOtpDoc.code;
            }
            return res.status(status).render('auth/verify-otp', {
                title: 'Xác minh OTP',
                email,
                error: msg,
                success: null,
                debugOtp
            });
        };

        if (!otpDoc) {
            return renderErr(
                'Mã đã hết hạn hoặc không tồn tại. Vui lòng đăng ký lại.',
                400,
                null
            );
        }

        if (otpDoc.expiresAt < new Date()) {
            const snapshotCode = otpDoc.code;
            await OTP.deleteOne({ _id: otpDoc._id });
            return renderErr(
                'Mã đã hết hạn. Vui lòng đăng ký lại.',
                400,
                { code: snapshotCode }
            );
        }

        if (otpDoc.attempts >= OTP_MAX_ATTEMPTS) {
            const snapshotCode = otpDoc.code;
            await OTP.deleteOne({ _id: otpDoc._id });
            return renderErr(
                'Bạn đã nhập sai quá nhiều lần. Vui lòng đăng ký lại.',
                429,
                { code: snapshotCode }
            );
        }

        const dbCode = normalizeCode(otpDoc.code);

        if (dbCode !== code) {
            otpDoc.attempts += 1;
            await otpDoc.save();

            return renderErr(
                `Mã không đúng. Còn ${
                    OTP_MAX_ATTEMPTS - otpDoc.attempts
                } lần thử.`
            );
        }

        const { name, passwordHash } = otpDoc.payload || {};

        if (!name || !passwordHash) {
            await OTP.deleteOne({ _id: otpDoc._id });
            return renderErr(
                'Dữ liệu đăng ký bị hỏng. Vui lòng đăng ký lại.',
                500,
                null
            );
        }

        const dup = await User.findOne({ email });
        if (dup) {
            await OTP.deleteOne({ _id: otpDoc._id });
            if (req.session) delete req.session.pendingEmail;

            // ★ FIX: lưu session trước khi redirect
            await saveSession(req);

            return res.redirect(
                `/auth/login?registered=1&email=${encodeURIComponent(email)}`
            );
        }

        await User.create({
            name,
            email,
            password: passwordHash,
            role: 'client',
            status: 'pending',
            userKey: null, // admin gán tổ chức khi duyệt
            connectedUserKeys: []
        });

        await OTP.deleteOne({ _id: otpDoc._id });

        if (req.session) {
            delete req.session.pendingEmail;
        }

        // ★ FIX: lưu session trước khi redirect
        await saveSession(req);

        console.log(
            `[verifyOtp] ✅ Tạo user: ${email} (role=client, status=pending, userKey=default)`
        );

        // ★ otp=1 → trang login hiện "Nhập mã OTP thành công, vui lòng đăng nhập lại"
        return res.redirect(
            `/auth/login?registered=1&otp=1&email=${encodeURIComponent(email)}`
        );
    } catch (error) {
        console.error('Verify OTP error:', error);
        return res.status(500).render('auth/verify-otp', {
            title: 'Xác minh OTP',
            email: req.session?.pendingEmail || '',
            error: 'Đã xảy ra lỗi. Vui lòng thử lại.',
            success: null,
            debugOtp: null
        });
    }
};

// ============================================================
// GỬI LẠI OTP (register)
// ============================================================
const resendOtp = async (req, res) => {
    try {
        const email = normalizeEmail(
            req.session?.pendingEmail || req.body.email
        );

        if (!email) {
            return res.redirect('/auth/register');
        }

        const existing = await OTP.findOne({ email, type: 'register' });

        if (!existing || !existing.payload) {
            return res.redirect('/auth/register');
        }

        if (
            Date.now() - existing.updatedAt.getTime() <
            OTP_RESEND_COOLDOWN_MS
        ) {
            return res.status(429).render('auth/verify-otp', {
                title: 'Xác minh OTP',
                email,
                error: 'Vui lòng chờ một phút trước khi gửi lại.',
                success: null,
                debugOtp: IS_DEV ? existing.code : null
            });
        }

        const code = genOTP();
        existing.code = code;
        existing.attempts = 0;
        existing.expiresAt = new Date(Date.now() + OTP_TTL_MS);
        await existing.save();

        await sendOTP(email, code, 'register');

        console.log(`[resendOtp] Đã gửi lại OTP cho ${email}: ${code}`);

        return res.render('auth/verify-otp', {
            title: 'Xác minh OTP',
            email,
            error: null,
            success: 'Đã gửi lại mã mới. Vui lòng kiểm tra email (hoặc console).',
            debugOtp: IS_DEV ? code : null
        });
    } catch (error) {
        console.error('Resend OTP error:', error);
        return res.status(500).render('auth/verify-otp', {
            title: 'Xác minh OTP',
            email: req.session?.pendingEmail || '',
            error: 'Không gửi lại được. Vui lòng thử lại sau.',
            success: null,
            debugOtp: null
        });
    }
};

// ============================================================
// ★ QUÊN MẬT KHẨU — BƯỚC 1: nhập email
// ------------------------------------------------------------
// FIX: Bỏ auto-redirect. Khi user vào /auth/forgot → LUÔN
// clear session reset cũ + render form email.
//
// Lý do: trước đây auto-redirect khiến:
//   - Vào /auth/forgot lần đầu (đã có session.resetEmail từ lần
//     trước chưa hoàn tất) → bị đá sang /auth/reset-verify
//   - Bấm link "Nhập lại email" trong reset-verify.pug → bị đá
//     ngược lại /auth/reset-verify → VÒNG LẶP KHÔNG THOÁT.
//
// → Luôn render form email, coi như bắt đầu flow mới.
// ============================================================
const showForgot = async (req, res) => {
    // Clear session reset cũ → user luôn bắt đầu từ form email
    if (req.session) {
        delete req.session.resetEmail;
        delete req.session.resetVerified;
        delete req.session.resetOtpId;

        // ★ Lưu session trước khi render để đảm bảo clear có hiệu lực
        await saveSession(req);
    }

    return res.render('auth/forgot', {
        title: 'Quên mật khẩu',
        error: null,
        success: null,
        email: ''
    });
};

const forgotPassword = async (req, res) => {
    try {
        const { email } = req.body || {};

        if (!email || !email.trim()) {
            return res.status(400).render('auth/forgot', {
                title: 'Quên mật khẩu',
                error: 'Vui lòng nhập email.',
                success: null,
                email: ''
            });
        }

        const normalizedEmail = normalizeEmail(email);
        const user = await User.findOne({ email: normalizedEmail });

        const genericMsg =
            'Nếu email tồn tại trong hệ thống, mã xác minh đã được gửi đến email của bạn.';

        if (!user) {
            return res.render('auth/forgot', {
                title: 'Quên mật khẩu',
                error: null,
                success: genericMsg,
                email: normalizedEmail
            });
        }

        const existingOTP = await OTP.findOne({
            email: normalizedEmail,
            type: 'reset'
        });

        if (
            existingOTP &&
            Date.now() - existingOTP.updatedAt.getTime() <
                OTP_RESEND_COOLDOWN_MS
        ) {
            return res.status(429).render('auth/forgot', {
                title: 'Quên mật khẩu',
                error: 'Vui lòng chờ một phút trước khi yêu cầu mã mới.',
                success: null,
                email: normalizedEmail
            });
        }

        await OTP.deleteMany({ email: normalizedEmail, type: 'reset' });

        const code = genOTP();

        await OTP.create({
            email: normalizedEmail,
            code,
            type: 'reset',
            expiresAt: new Date(Date.now() + OTP_TTL_MS),
            payload: null
        });

        await sendOTP(normalizedEmail, code, 'reset');

        if (req.session) {
            req.session.resetEmail = normalizedEmail;
            req.session.resetVerified = false;
            delete req.session.resetOtpId;
        }

        // ★ FIX: lưu session TRƯỚC khi redirect
        await saveSession(req);

        console.log(`[forgotPassword] Đã tạo OTP reset cho ${normalizedEmail}: ${code}`);

        return res.redirect('/auth/reset-verify');
    } catch (error) {
        console.error('Forgot password error:', error);
        return res.status(500).render('auth/forgot', {
            title: 'Quên mật khẩu',
            error: 'Đã xảy ra lỗi. Vui lòng thử lại sau.',
            success: null,
            email: req.body?.email || ''
        });
    }
};

// ============================================================
// ★ QUÊN MẬT KHẨU — BƯỚC 2: nhập OTP
// ============================================================
const showResetVerify = async (req, res) => {
    try {
        const email = req.session?.resetEmail || '';

        if (!email) {
            return res.redirect('/auth/forgot');
        }

        let debugOtp = null;
        if (IS_DEV) {
            const otpDoc = await OTP.findOne({ email, type: 'reset' });
            if (otpDoc && otpDoc.expiresAt > new Date()) {
                debugOtp = otpDoc.code;
            }
        }

        return res.render('auth/reset-verify', {
            title: 'Xác minh OTP',
            email,
            error: null,
            success: null,
            debugOtp
        });
    } catch (err) {
        console.error('[showResetVerify]', err);
        return res.redirect('/auth/forgot');
    }
};

const verifyResetOtp = async (req, res) => {
    try {
        const email = normalizeEmail(
            req.session?.resetEmail || req.body.email
        );
        const code = normalizeCode(req.body?.code || '');

        if (!email || !code) {
            return res.status(400).render('auth/reset-verify', {
                title: 'Xác minh OTP',
                email,
                error: 'Vui lòng nhập đủ 6 chữ số OTP.',
                success: null,
                debugOtp: null
            });
        }

        const otpDoc = await OTP.findOne({ email, type: 'reset' });

        if (!otpDoc) {
            return res.status(400).render('auth/reset-verify', {
                title: 'Xác minh OTP',
                email,
                error: 'Mã đã hết hạn hoặc không tồn tại. Vui lòng yêu cầu mã mới.',
                success: null,
                debugOtp: null
            });
        }

        if (otpDoc.expiresAt < new Date()) {
            await OTP.deleteOne({ _id: otpDoc._id });
            return res.status(400).render('auth/reset-verify', {
                title: 'Xác minh OTP',
                email,
                error: 'Mã đã hết hạn. Vui lòng yêu cầu mã mới.',
                success: null,
                debugOtp: null
            });
        }

        if (otpDoc.attempts >= OTP_MAX_ATTEMPTS) {
            await OTP.deleteOne({ _id: otpDoc._id });
            if (req.session) {
                delete req.session.resetEmail;
                delete req.session.resetVerified;
                delete req.session.resetOtpId;
            }

            await saveSession(req);

            return res.status(429).render('auth/reset-verify', {
                title: 'Xác minh OTP',
                email,
                error: 'Bạn đã nhập sai quá nhiều lần. Vui lòng yêu cầu mã mới.',
                success: null,
                debugOtp: null
            });
        }

        const dbCode = normalizeCode(otpDoc.code);

        if (dbCode !== code) {
            otpDoc.attempts += 1;
            await otpDoc.save();

            return res.status(400).render('auth/reset-verify', {
                title: 'Xác minh OTP',
                email,
                error: `Mã không đúng. Còn ${
                    OTP_MAX_ATTEMPTS - otpDoc.attempts
                } lần thử.`,
                success: null,
                debugOtp: IS_DEV ? otpDoc.code : null
            });
        }

        // ✅ OTP đúng → set session
        if (req.session) {
            req.session.resetVerified = true;
            req.session.resetOtpId = String(otpDoc._id);
        }

        // ★★★ FIX QUAN TRỌNG: lưu session TRƯỚC khi redirect ★★★
        await saveSession(req);

        return res.redirect('/auth/reset-password');
    } catch (error) {
        console.error('Verify reset OTP error:', error);
        return res.status(500).render('auth/reset-verify', {
            title: 'Xác minh OTP',
            email: req.session?.resetEmail || '',
            error: 'Đã xảy ra lỗi. Vui lòng thử lại.',
            success: null,
            debugOtp: null
        });
    }
};

// ============================================================
// ★ QUÊN MẬT KHẨU — BƯỚC 2b: gửi lại OTP reset
// ============================================================
const resendResetOtp = async (req, res) => {
    try {
        const email = normalizeEmail(req.session?.resetEmail || '');

        if (!email) {
            return res.redirect('/auth/forgot');
        }

        const existing = await OTP.findOne({ email, type: 'reset' });

        if (
            existing &&
            Date.now() - existing.updatedAt.getTime() <
                OTP_RESEND_COOLDOWN_MS
        ) {
            return res.status(429).render('auth/reset-verify', {
                title: 'Xác minh OTP',
                email,
                error: 'Vui lòng chờ một phút trước khi gửi lại.',
                success: null,
                debugOtp: IS_DEV ? existing.code : null
            });
        }

        await OTP.deleteMany({ email, type: 'reset' });

        const code = genOTP();

        await OTP.create({
            email,
            code,
            type: 'reset',
            expiresAt: new Date(Date.now() + OTP_TTL_MS),
            payload: null
        });

        await sendOTP(email, code, 'reset');

        console.log(`[resendResetOtp] Đã gửi lại OTP reset cho ${email}: ${code}`);

        return res.render('auth/reset-verify', {
            title: 'Xác minh OTP',
            email,
            error: null,
            success: 'Đã gửi lại mã mới. Vui lòng kiểm tra email.',
            debugOtp: IS_DEV ? code : null
        });
    } catch (error) {
        console.error('Resend reset OTP error:', error);
        return res.status(500).render('auth/reset-verify', {
            title: 'Xác minh OTP',
            email: req.session?.resetEmail || '',
            error: 'Không gửi lại được. Vui lòng thử lại sau.',
            success: null,
            debugOtp: null
        });
    }
};

// ============================================================
// ★ QUÊN MẬT KHẨU — BƯỚC 3: đổi mật khẩu mới
// ============================================================
const showResetPassword = (req, res) => {
    const email = req.session?.resetEmail;
    const verified = req.session?.resetVerified === true;

    if (!email || !verified) {
        return res.redirect('/auth/forgot');
    }

    return res.render('auth/reset-password', {
        title: 'Đặt lại mật khẩu',
        email,
        error: null
    });
};

const resetPassword = async (req, res) => {
    try {
        const email = req.session?.resetEmail;
        const verified = req.session?.resetVerified === true;
        const otpId = req.session?.resetOtpId;

        if (!email || !verified) {
            return res.redirect('/auth/forgot');
        }

        const { password, confirmPassword } = req.body || {};

        if (!password || !confirmPassword) {
            return res.status(400).render('auth/reset-password', {
                title: 'Đặt lại mật khẩu',
                email,
                error: 'Vui lòng nhập đầy đủ thông tin.'
            });
        }

        if (password !== confirmPassword) {
            return res.status(400).render('auth/reset-password', {
                title: 'Đặt lại mật khẩu',
                email,
                error: 'Mật khẩu xác nhận không khớp.'
            });
        }

        if (password.length < 8) {
            return res.status(400).render('auth/reset-password', {
                title: 'Đặt lại mật khẩu',
                email,
                error: 'Mật khẩu phải có ít nhất 8 ký tự.'
            });
        }

        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).render('auth/reset-password', {
                title: 'Đặt lại mật khẩu',
                email,
                error: 'Không tìm thấy tài khoản.'
            });
        }

        const passwordHash = await bcrypt.hash(password, 12);
        user.password = passwordHash;
        user.resetPasswordToken = null;
        user.resetPasswordExpires = null;
        await user.save({ validateBeforeSave: false });

        if (otpId) {
            await OTP.deleteOne({ _id: otpId }).catch(() => {});
        }
        await OTP.deleteMany({ email, type: 'reset' });

        if (req.session) {
            delete req.session.resetEmail;
            delete req.session.resetVerified;
            delete req.session.resetOtpId;
        }

        // ★ FIX: lưu session trước khi redirect
        await saveSession(req);

        console.log(`[resetPassword] ✅ Đổi mật khẩu thành công cho ${email}`);

        return res.redirect('/auth/login?reset=1');
    } catch (error) {
        console.error('Reset password error:', error);
        return res.status(500).render('auth/reset-password', {
            title: 'Đặt lại mật khẩu',
            email: req.session?.resetEmail || '',
            error: 'Đã xảy ra lỗi. Vui lòng thử lại sau.'
        });
    }
};

// ============================================================
// ĐĂNG XUẤT
// ============================================================
const logout = (req, res) => {
    if (!req.session) {
        return res.redirect('/auth/login');
    }

    req.session.destroy((error) => {
        if (error) {
            console.error('Logout error:', error);
        }
        res.clearCookie('connect.sid');
        res.clearCookie('token');
        return res.redirect('/auth/login');
    });
};

module.exports = {
    showLogin,
    login,
    showRegister,
    register,
    showVerifyOtp,
    verifyOtp,
    resendOtp,

    // ★ QUÊN MẬT KHẨU
    showForgot,
    forgotPassword,
    showResetVerify,
    verifyResetOtp,
    resendResetOtp,
    showResetPassword,
    resetPassword,

    logout
};