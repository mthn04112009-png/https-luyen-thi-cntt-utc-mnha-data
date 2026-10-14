const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
    if (transporter) return transporter;

    const user = process.env.MAIL_USER;
    const pass = process.env.MAIL_PASS;

    if (!user || !pass) {
        console.warn(
            '[mailService] MAIL_USER / MAIL_PASS chưa cấu hình — sẽ chỉ log OTP ra console.'
        );
        return null;
    }

    transporter = nodemailer.createTransport({
        host: process.env.MAIL_HOST || 'smtp.gmail.com',
        port: Number(process.env.MAIL_PORT) || 465,
        secure: process.env.MAIL_SECURE !== 'false',
        auth: { user, pass },
        connectionTimeout: 15000,
        greetingTimeout: 10000,
        socketTimeout: 20000
    });

    return transporter;
}

/**
 * Gửi mã OTP.
 * Nếu mail chưa cấu hình → log ra console (dev mode).
 */
async function sendOTP(email, code, type = 'register') {
    const subject =
        type === 'register'
            ? 'Mã xác minh đăng ký — Luyện thi của MNHA'
            : 'Mã đặt lại mật khẩu — Luyện thi của MNHA';

    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: auto; padding: 24px;">
            <h2 style="color: #2563eb;">Luyện thi của MNHA</h2>
            <p>Xin chào,</p>
            <p>Mã xác minh của bạn là:</p>
            <div style="font-size: 32px; font-weight: bold; letter-spacing: 6px;
                        color: #1d4ed8; padding: 16px; background: #eff6ff;
                        border-radius: 8px; text-align: center; margin: 16px 0;">
                ${code}
            </div>
            <p>Mã có hiệu lực trong <b>10 phút</b>. Không chia sẻ mã này với bất kỳ ai.</p>
            <p style="color: #6b7280; font-size: 12px;">
                Nếu bạn không thực hiện yêu cầu này, hãy bỏ qua email.
            </p>
        </div>
    `;

    const tr = getTransporter();

    if (!tr) {
        // DEV FALLBACK — không gửi được mail thì log OTP ra console
        console.log('');
        console.log('============================================================');
        console.log(`[DEV] OTP cho ${email} (type=${type}): ${code}`);
        console.log('============================================================');
        console.log('');
        return { dev: true };
    }

    try {
        await tr.sendMail({
            from:
                process.env.MAIL_FROM ||
                `"Luyện thi của MNHA" <${process.env.MAIL_USER}>`,
            to: email,
            subject,
            html
        });
        return { sent: true };
    } catch (err) {
        console.error('[mailService] Gửi mail thất bại:', err.message);
        // Vẫn log OTP ra console để dev không bị chặn
        console.log(`[FALLBACK] OTP cho ${email}: ${code}`);
        return { error: err.message, dev: true };
    }
}

module.exports = { sendOTP };