const express = require("express");
const authController = require("../controllers/auth.controller");

const router = express.Router();

// Middleware xoá session.user cũ khi vào form đăng ký / đăng nhập
function clearAuthSession(req, res, next) {
    if (req.session) {
        delete req.session.user;
        delete req.session.otpEmail;
        delete req.session.otpType;
        delete req.session.pendingEmail;
    }
    next();
}

// ============================================================
// ĐĂNG NHẬP
// ============================================================
router.get("/login", authController.showLogin);
router.post("/login", authController.login);

// ============================================================
// ĐĂNG KÝ (có OTP)
// ============================================================
router.get("/register", clearAuthSession, authController.showRegister);
router.post("/register", authController.register);

router.get("/verify-otp", authController.showVerifyOtp);
router.post("/verify-otp", authController.verifyOtp);
router.post("/resend-otp", authController.resendOtp);

// ============================================================
// ★ QUÊN MẬT KHẨU (3 bước)
// ============================================================
router.get("/forgot", authController.showForgot);
router.post("/forgot", authController.forgotPassword);

router.get("/reset-verify", authController.showResetVerify);
router.post("/reset-verify", authController.verifyResetOtp);
router.post("/reset-verify/resend", authController.resendResetOtp);

router.get("/reset-password", authController.showResetPassword);
router.post("/reset-password", authController.resetPassword);

// ============================================================
// ★ ĐỔI MẬT KHẨU khi đang đăng nhập (không OTP / không xác minh lại)
// ============================================================
router.get("/change-password", authController.showChangePassword);
router.post("/change-password", authController.changePassword);

// ============================================================
// ĐĂNG XUẤT
// ============================================================
router.post("/logout", authController.logout);
router.get("/logout", authController.logout);

module.exports = router;