require("dotenv").config();

// TIMEZONE: Việt Nam (GMT+7)
process.env.TZ = "Asia/Ho_Chi_Minh";

const express = require("express");
const path = require("path");
const mongoose = require("mongoose");
const session = require("express-session");
const connectMongo = require("connect-mongo");
const MongoStore = connectMongo.default || connectMongo;
const cors = require("cors");
const morgan = require("morgan");
const cookieParser = require("cookie-parser");
const attachLayout = require("./middleware/attachLayout");
const { isGithubUnavailable, renderGithubDown } = require("./utils/githubErrors");

const app = express();

app.set("trust proxy", 1);

// ============================================================
// ENVIRONMENT
// ============================================================

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

// ============================================================
// ERROR LOGGING
// ============================================================

function logError(type, error, extra = {}) {
    const now = new Date().toISOString();

    console.error("");
    console.error("============================================================");
    console.error(`[${now}] ${type}`);
    console.error("============================================================");

    if (extra && Object.keys(extra).length > 0) {
        console.error("Context:", extra);
    }

    if (error) {
        console.error("Name:", error.name || "UnknownError");
        console.error("Message:", error.message || error);

        if (error.code !== undefined) console.error("Code:", error.code);
        if (error.codeName !== undefined) console.error("CodeName:", error.codeName);
        if (error.status !== undefined) console.error("Status:", error.status);

        if (error.stack) {
            console.error("Stack:");
            console.error(error.stack);
        }
    }

    console.error("============================================================");
    console.error("");
}

// ============================================================
// PROCESS-LEVEL ERROR HANDLING
// ============================================================

process.on("uncaughtException", (error) => {
    logError("UNCAUGHT EXCEPTION", error);
    // Trên Vercel không tự thoát: để platform tự quản lý vòng đời function
    if (!process.env.VERCEL) process.exit(1);
});

process.on("unhandledRejection", (reason) => {
    logError(
        "UNHANDLED PROMISE REJECTION",
        reason instanceof Error ? reason : new Error(String(reason))
    );
});

// ============================================================
// MONGODB EVENTS
// ============================================================

mongoose.connection.on("error", (error) => {
    logError("MONGODB CONNECTION ERROR", error);
});

mongoose.connection.on("disconnected", () => {
    console.error(`[${new Date().toISOString()}] MONGODB DISCONNECTED`);
});

mongoose.connection.on("reconnected", () => {
    console.log(`[${new Date().toISOString()}] MONGODB RECONNECTED`);
});

// ============================================================
// ★ FIX: KẾT NỐI MONGODB — DÙNG CHUNG CHO CẢ LOCAL VÀ SERVERLESS
// ------------------------------------------------------------
// Trước đây mongoose.connect() chỉ được gọi bên trong startServer(),
// mà startServer() chỉ chạy khi `require.main === module` (tức chỉ khi
// chạy `node server.js` trực tiếp). Trên Vercel, api/index.js chỉ
// `require("../server")` để lấy `app` — require.main LUÔN khác module
// này → startServer() không bao giờ chạy → mongoose không bao giờ kết
// nối → mọi query bị "buffering" rồi timeout sau 10s
// (MongooseError: Operation `...` buffering timed out after 10000ms).
//
// connectDB() ở đây được gọi ngay khi module được load (dòng cuối file),
// bất kể chạy local hay serverless, và cache lại promise kết nối để
// tránh gọi mongoose.connect() nhiều lần trên các lần "warm start".
// ============================================================

let dbConnectionPromise = null;

function connectDB() {
    if (!MONGODB_URI) {
        return Promise.reject(
            new Error("MONGODB_URI chưa được cấu hình trong biến môi trường")
        );
    }

    if (mongoose.connection.readyState === 1) {
        return Promise.resolve();
    }

    if (!dbConnectionPromise) {
        dbConnectionPromise = mongoose
            .connect(MONGODB_URI, {
                serverSelectionTimeoutMS: 10000, // báo lỗi rõ ràng thay vì treo 30s
                socketTimeoutMS: 45000,
                maxPoolSize: 5,                  // serverless: pool nhỏ, tránh cạn kết nối Atlas
            })
            .then(() => {
                console.log(`[${new Date().toISOString()}] MongoDB connected`);
                // ★ Đảm bảo TTL index của OTP (autoIndex tắt ở production)
                require("./models/OTP")
                    .ensureTTLIndex()
                    .catch((e) => console.error("[OTP] ensureTTLIndex lỗi:", e.message));
            })
            .catch((error) => {
                logError("MONGODB CONNECTION FAILED", error);
                dbConnectionPromise = null; // cho phép request sau thử kết nối lại
                throw error;
            });
    }

    return dbConnectionPromise;
}

// ★ Khởi động kết nối NGAY khi module được require (không chặn require()),
//   để container serverless bắt đầu kết nối từ sớm thay vì đợi request đầu.
connectDB().catch(() => {
    // Lỗi đã được log trong connectDB(); không throw ở đây để tránh
    // crash toàn bộ module khi load (sẽ được retry qua middleware bên dưới).
});

// ============================================================
// VIEW ENGINE
// ============================================================

app.set("view engine", "pug");
app.set("views", path.join(__dirname, "views"));

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors());
app.use(morgan("dev"));
app.use(cookieParser());

// ★ 2mb quá nhỏ: form quiz gửi rawTexts {mcq,tf,fill} tối đa 200k ký tự/phần
//    + parts (bản parse) + contentHtml (20k) + tiếng Việt 3 byte/ký tự UTF-8
//    → dễ vượt 2MB → 413 → client thấy "không lưu được".
//    Vercel cap request body ở 4.5MB ở tầng edge; đặt 10mb để server không
//    tự chặn trước (local vẫn dùng được), Vercel sẽ trả 413 riêng nếu >4.5MB.
// ★ Giữ body gốc (rawBody) cho webhook GitHub — cần để kiểm tra chữ ký HMAC.
app.use(express.json({
    limit: "10mb",
    verify: (req, _res, buf) => {
        if (req.originalUrl && req.originalUrl.startsWith("/webhooks/github")) req.rawBody = buf;
    },
}));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ★ FIX: đợi MongoDB sẵn sàng trước khi vào route — quan trọng cho lần
//   "cold start" đầu tiên trên serverless, khi request có thể đến trước
//   khi connectDB() ở trên kịp kết nối xong.
app.use(async (req, res, next) => {
    try {
        await connectDB();
        next();
    } catch (error) {
        next(error);
    }
});

// ★ Danh sách nhà cung cấp AI (GitHub: AI-database/index.json) → nạp vào RAM; lỗi thì dùng bản mặc định, không chặn request.
app.use(require("./services/aiProviderService").middleware);

// ★ WEBHOOK GitHub (push) → cập nhật lessons/prompts/submissions đọc từ GitHub.
//   Đặt TRƯỚC session/auth: GitHub không có cookie, chỉ xác thực bằng chữ ký HMAC.
app.use("/webhooks/github", require("./routes/githubWebhook"));

// ============================================================
// SESSION
// ============================================================

// ★ FIX: trước đây MongoStore.create({ mongoUrl }) chạy ngay lúc load module
//   → mở thêm 1 kết nối MongoDB riêng (và crash nếu MONGODB_URI chưa có).
//   Giờ session chỉ được tạo SAU khi mongoose đã kết nối, và dùng lại
//   chính client của mongoose → chỉ 1 kết nối, và tự thử lại nếu lần đầu lỗi.
let sessionMiddleware = null;

function buildSessionMiddleware() {
    const storeOptions = {
        collectionName: "sessions",
        autoRemove: "native",
    };

    if (typeof mongoose.connection.getClient === "function") {
        storeOptions.client = mongoose.connection.getClient();
    } else {
        storeOptions.mongoUrl = MONGODB_URI;
    }

    return session({
        secret: process.env.SESSION_SECRET || "change-this-session-secret",
        resave: false,
        saveUninitialized: false,

        // ★ proxy: true — tin X-Forwarded-Proto để set cookie secure đúng trên Vercel
        proxy: true,

        store: MongoStore.create(storeOptions),

        cookie: {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax",
            maxAge: 1000 * 60 * 60 * 24,
        },
    });
}

app.use((req, res, next) => {
    try {
        if (!sessionMiddleware) {
            sessionMiddleware = buildSessionMiddleware();
        }
        return sessionMiddleware(req, res, next);
    } catch (error) {
        sessionMiddleware = null; // thử tạo lại ở request sau
        return next(error);
    }
});

// ============================================================
// ★ FLASH MESSAGE (không cần thêm package)
// ------------------------------------------------------------
// Trước đây req.flash KHÔNG tồn tại (không có connect-flash) nên mọi
// `req.flash?.("success", ...)` trong controller đều bị bỏ qua âm thầm.
// Dùng: req.flash("success", "msg") để ghi; req.flash("success") để đọc
// (đọc xong tự xoá). Lưu trong session nên sống qua redirect.
// PHẢI đứng SAU middleware session.
// ============================================================
app.use((req, res, next) => {
    if (!req.session) return next();

    req.flash = function (type, msg) {
        if (type && msg !== undefined) {
            req.session.flash = req.session.flash || {};
            (req.session.flash[type] = req.session.flash[type] || []).push(msg);
            return req.session.flash[type].length;
        }
        const bucket = req.session.flash && req.session.flash[type];
        if (!bucket) return [];
        delete req.session.flash[type];
        return bucket;
    };

    next();
});

// ============================================================
// REFRESH SESSION USER TỪ DB MỖI REQUEST
// ============================================================

app.use(async (req, res, next) => {
    if (
        req.path.startsWith("/css") ||
        req.path.startsWith("/js") ||
        req.path.startsWith("/images") ||
        req.path === "/favicon.ico"
    ) {
        return next();
    }

    const sessionUser = req.session?.user;
    const userId = sessionUser?.id || sessionUser?._id;

    if (userId) {
        try {
            const User = require("./models/User");
            const fresh = await User.findById(userId)
                .select("-password")
                .lean();

            if (fresh) {
                // ★ Giữ bản user mới nhất cho attachLayout (đỡ query lần 2)
                req.freshUser = fresh;

                req.session.user = {
                    id: fresh._id.toString(),
                    _id: fresh._id.toString(),
                    email: fresh.email,
                    name: fresh.name,
                    role: fresh.role,
                    status: fresh.status,
                };
            } else {
                req.session.destroy(() => {});
            }
        } catch (err) {
            console.warn("[refresh session]", err.message);
        }
    }

    next();
});

// ============================================================
// GLOBAL LOCALS + req.user
// ============================================================

app.use((req, res, next) => {
    try {
        const sessionUser = req.session?.user || null;

        req.user = sessionUser;
        res.locals.user = sessionUser;
        res.locals.currentPath = req.path;
        res.locals.unreadCount = 0;

        next();
    } catch (error) {
        logError("GLOBAL LOCALS ERROR", error, {
            method: req.method,
            url: req.originalUrl,
        });
        next(error);
    }
});

// ★ Layout theo user_key: res.locals.brand + isDefaultAdmin/isOrgAdmin/canEditLayout.
//   PHẢI đứng sau middleware nạp user ở trên (cần req.freshUser).
app.use(attachLayout);

// ★ GitHub lỗi (sập/bảo trì) → mọi trang báo thống nhất "GitHub đang gặp vấn đề, vui lòng quay lại sau"
app.use(require("./middleware/githubDownGuard"));

// ============================================================
// HOME
// ============================================================

app.get("/", (req, res, next) => {
    try {
        const user = req.session?.user;

        if (!user) {
            return res.redirect("/auth/login");
        }

        if (user.role === "admin") {
            return res.redirect("/admin/dashboard");
        }

        if (user.role === "client" || user.status === "pending") {
            return res.redirect("/pages");
        }

        if (user.role === "student") {
            return res.redirect("/subjects");
        }

        return res.redirect("/auth/login");
    } catch (error) {
        next(error);
    }
});

// ============================================================
// PENDING PAGE
// ============================================================

app.get("/pages", (req, res, next) => {
    try {
        const user = req.session?.user;

        if (!user) {
            return res.redirect("/auth/login");
        }

        if (user.role === "admin") {
            return res.redirect("/admin/dashboard");
        }

        if (user.role === "student" && user.status !== "pending") {
            return res.redirect("/subjects");
        }

        if (user.role === "client" || user.status === "pending") {
            return res.render("pages", {
                title: "Chờ duyệt tài khoản",
            });
        }

        return res.redirect("/auth/login");
    } catch (error) {
        next(error);
    }
});

// POST /pages (vd: form không có action, hoặc redirect 307/308) → 303 để trình duyệt chuyển sang GET
app.post("/pages", (req, res) => res.redirect(303, "/pages"));

// ============================================================
// ROUTES
// ============================================================

let authRoutes;
let subjectRoutes;
let lessonRoutes;
let submissionRoutes;
let practiceRoutes;
let disputeRoutes;
let notificationRoutes;
let promptRoutes;
let aiRoutes;
let adminRoutes;
let layoutSettingsRoutes;
let userConnectRoutes;
let quizRoutes = null;

try {
    authRoutes = require("./routes/auth");
    subjectRoutes = require("./routes/subject");
    lessonRoutes = require("./routes/lesson");
    submissionRoutes = require("./routes/submission");
    practiceRoutes = require("./routes/practice");
    disputeRoutes = require("./routes/dispute");
    notificationRoutes = require("./routes/notification");
    promptRoutes = require("./routes/prompt");
    aiRoutes = require("./routes/ai");
    adminRoutes = require("./routes/admin");
    layoutSettingsRoutes = require("./routes/layoutSettings");
    userConnectRoutes = require("./routes/userConnect");
} catch (error) {
    logError("ROUTE MODULE LOAD ERROR", error);
    process.exit(1);
}

// ★ TRẮC NGHIỆM — routes/quiz.js (tự khai báo đường dẫn tuyệt đối:
//   /admin/quiz/*, /admin/quiz-submissions/:id/review, /api/quiz/*, /quiz/submissions/:id).
//   Tách khỏi khối try ở trên có chủ đích: thiếu CHÍNH file routes/quiz.js (chưa
//   triển khai) chỉ cảnh báo và bỏ qua, KHÔNG làm sập server của tính năng tự luận.
//   Mọi lỗi khác (cú pháp, thiếu dependency bên trong quiz.js…) vẫn dừng server
//   như các route khác để không chạy với tính năng hỏng âm thầm.
try {
    quizRoutes = require("./routes/quiz");
} catch (error) {
    const missingQuizFile =
        error.code === "MODULE_NOT_FOUND" &&
        /routes[\\/]quiz['"]?/.test(String(error.message).split("\n")[0]);
    if (missingQuizFile) {
        console.warn("⚠️ [server] Chưa có routes/quiz.js — tính năng trắc nghiệm chưa bật.");
    } else {
        logError("QUIZ ROUTE MODULE LOAD ERROR", error);
        process.exit(1);
    }
}

// ============================================================
// REGISTER ROUTES  ★ ĐÃ SỬA: mount CẢ "/ai" VÀ "/api/ai"
// ============================================================
// Lý do: frontend lesson.pug gọi fetch("/api/ai/keys")
// nhưng server cũ chỉ mount "/ai" → 404.
// Giữ "/ai" để tương thích với code cũ, thêm "/api/ai" cho frontend mới.
// ============================================================

app.use("/auth", authRoutes);
app.use("/subjects", subjectRoutes);
app.use("/student/subjects", subjectRoutes);

// ★ ỨNG DỤNG: /apps (danh sách ứng dụng được cấp quyền) + /flashcards (Flashcards) + /slides (Slide học tập)
app.use("/apps", require("./routes/apps"));
app.use("/flashcards", require("./routes/flashcard"));
app.use("/slides", require("./routes/slide"));   // ★ Slide học tập: PDF mã hoá lưu GitHub
app.use("/lessons", lessonRoutes);
app.use("/submissions", submissionRoutes);
app.use("/practice", practiceRoutes);
app.use("/disputes", disputeRoutes);
app.use("/notifications", notificationRoutes);
app.use("/prompts", promptRoutes);

// ★ AI ROUTES — mount cả 2 path
app.use("/ai", aiRoutes);
app.use("/api/ai", aiRoutes);

// ★ Layout theo user_key. PHẢI mount TRƯỚC adminRoutes, nếu không
//   "/admin/users/:id..." trong adminRoutes sẽ nuốt chữ "connect".
app.use("/layout", layoutSettingsRoutes.logoRouter);        // GET /layout/logo/:userKeyId
app.use("/admin/layout", layoutSettingsRoutes);             // GET/POST /admin/layout, POST /admin/layout/reset
app.use("/admin/users/connect", userConnectRoutes);         // tài khoản kết nối (admin user_key)

// ★ Trắc nghiệm: mount TRƯỚC adminRoutes để /admin/quiz/* và /admin/quiz-submissions/*
//   không bị route chung của adminRoutes nuốt. Router tự giới hạn đúng các đường dẫn của nó.
if (quizRoutes) {
    app.use("/", quizRoutes);
}

app.use("/admin", adminRoutes);

// POST nhầm vào trang đích của từng vai trò (vd: form không có action, redirect 307/308).
// Đặt SAU các router nên không đè lên route POST thật; chỉ bắt khi không route nào khớp.
// 303 → trình duyệt đổi sang GET.
app.post("/subjects", (req, res) => res.redirect(303, "/subjects"));            // student
app.post("/admin/dashboard", (req, res) => res.redirect(303, "/admin/dashboard")); // admin

// ============================================================
// HELPER: Render error page
// ============================================================

function renderErrorPage(req, res, status, title, message, stack = null) {
    if (
        req.path.startsWith("/api") ||
        req.xhr ||
        req.headers.accept?.includes("json")
    ) {
        return res.status(status).json({
            success: false,
            message,
            ...(process.env.NODE_ENV !== "production" && stack
                ? { error: { stack } }
                : {}),
        });
    }

    return res.status(status).render(
        "error",
        { title, message, statusCode: status, stack },
        (renderErr, html) => {
            if (renderErr) {
                console.error(
                    "[renderErrorPage] Render view 'error' thất bại:",
                    renderErr.message
                );

                return res.status(status).send(`
<!doctype html>
<html lang="vi">
<head>
    <meta charset="utf-8">
    <title>${title}</title>
    <style>
        body { font-family: system-ui, sans-serif; background: #f9fafb;
               display: flex; align-items: center; justify-content: center;
               min-height: 100vh; margin: 0; padding: 20px; }
        .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 16px;
                max-width: 600px; width: 100%; padding: 40px; text-align: center; }
        h1 { color: #dc2626; margin: 0 0 12px; font-size: 24px; }
        .status { color: #6b7280; font-size: 14px; margin-bottom: 24px; }
        p { color: #374151; line-height: 1.6; margin-bottom: 24px; }
        a { display: inline-block; background: #2563eb; color: #fff;
            padding: 12px 24px; border-radius: 10px; text-decoration: none;
            font-weight: 600; font-size: 14px; }
    </style>
</head>
<body>
    <div class="card">
        <h1>${title}</h1>
        <div class="status">Mã lỗi: ${status}</div>
        <p>${message}</p>
        <a href="/">← Về trang chủ</a>
    </div>
</body>
</html>
                `);
            }
            res.send(html);
        }
    );
}

// ============================================================
// 404
// ============================================================

app.use((req, res, next) => {
    try {
        console.warn("");
        console.warn("------------------------------------------------------------");
        console.warn("404 NOT FOUND");
        console.warn("Method:", req.method);
        console.warn("URL:", req.originalUrl);
        console.warn("IP:", req.ip);
        console.warn("User:", req.session?.user?.email || "Guest");
        console.warn("------------------------------------------------------------");
        console.warn("");

        return renderErrorPage(
            req,
            res,
            404,
            "404 — Không tìm thấy trang",
            "Trang bạn đang truy cập không tồn tại hoặc đã bị di chuyển.",
            null
        );
    } catch (error) {
        next(error);
    }
});

// ============================================================
// ERROR HANDLER
// ============================================================

app.use((err, req, res, next) => {
    logError("EXPRESS SERVER ERROR", err, {
        method: req.method,
        url: req.originalUrl,
        ip: req.ip,
        user: req.session?.user?.email || "Guest",
        userId: req.session?.user?._id || null,
    });

    if (res.headersSent) return next(err);

    let statusCode = err.status || err.statusCode || 500;
    if (typeof statusCode !== "number" || statusCode < 400 || statusCode > 599) {
        statusCode = 500;
    }

    if (
        err.code === "PUG:UNEXPECTED_TEXT" ||
        err.code?.startsWith?.("PUG:") ||
        err.name === "PugError" ||
        (err.message && err.message.includes(".pug:"))
    ) {
        return renderErrorPage(
            req,
            res,
            500,
            "Lỗi template",
            process.env.NODE_ENV === "production"
                ? "Đã xảy ra lỗi khi render giao diện. Vui lòng thử lại sau."
                : err.message,
            process.env.NODE_ENV === "production" ? null : err.stack
        );
    }

    // ★ Lỗi do GitHub (sập/bảo trì/mạng/giới hạn) ở BẤT KỲ trang nào → trang báo lỗi riêng
    if (isGithubUnavailable(err)) {
        return renderGithubDown(req, res, err);
    }

    if (
        err instanceof SyntaxError &&
        err.status === 400 &&
        err.type === "entity.parse.failed"
    ) {
        return renderErrorPage(
            req,
            res,
            400,
            "Dữ liệu không hợp lệ",
            "Dữ liệu JSON gửi lên không hợp lệ. Vui lòng kiểm tra lại."
        );
    }

    if (err.type === "entity.too.large" || err.status === 413) {
        return renderErrorPage(
            req,
            res,
            413,
            "Dữ liệu quá lớn",
            "Dữ liệu gửi lên vượt quá giới hạn cho phép."
        );
    }

    if (err.name === "ValidationError") {
        const details = Object.values(err.errors || {}).map((item) => ({
            field: item.path,
            message: item.message,
            value: item.value,
        }));

        if (
            req.path.startsWith("/api") ||
            req.xhr ||
            req.headers.accept?.includes("json")
        ) {
            return res.status(400).json({
                success: false,
                message: "Dữ liệu không hợp lệ.",
                errors: details,
            });
        }

        return renderErrorPage(
            req,
            res,
            400,
            "Dữ liệu không hợp lệ",
            "Một hoặc nhiều dữ liệu không hợp lệ."
        );
    }

    if (err.name === "CastError") {
        return renderErrorPage(
            req,
            res,
            400,
            "Dữ liệu không hợp lệ",
            "ID hoặc dữ liệu gửi lên không đúng định dạng."
        );
    }

    if (err.code === 11000) {
        const duplicateFields = Object.keys(err.keyPattern || err.keyValue || {});

        if (
            req.path.startsWith("/api") ||
            req.xhr ||
            req.headers.accept?.includes("json")
        ) {
            return res.status(409).json({
                success: false,
                message: "Dữ liệu đã tồn tại.",
                fields: duplicateFields,
            });
        }

        return renderErrorPage(
            req,
            res,
            409,
            "Dữ liệu đã tồn tại",
            "Dữ liệu bạn nhập đã tồn tại trong hệ thống."
        );
    }

    if (err.name === "VersionError") {
        return renderErrorPage(
            req,
            res,
            409,
            "Dữ liệu đã thay đổi",
            "Dữ liệu vừa được thay đổi bởi một yêu cầu khác. Vui lòng thử lại."
        );
    }

    const productionMessage =
        process.env.NODE_ENV === "production"
            ? "Đã xảy ra lỗi máy chủ."
            : err.message || "Đã xảy ra lỗi không xác định.";

    return renderErrorPage(
        req,
        res,
        statusCode,
        statusCode >= 500 ? "Lỗi máy chủ" : "Có lỗi xảy ra",
        productionMessage,
        process.env.NODE_ENV === "production" ? null : err.stack
    );
});

// ============================================================
// HTTP SERVER
// ============================================================

let server;

async function shutdown(signal) {
    console.log("");
    console.log("============================================================");
    console.log(`SERVER SHUTDOWN: ${signal}`);
    console.log("============================================================");

    try {
        if (server) {
            await new Promise((resolve) => {
                server.close((error) => {
                    if (error) logError("HTTP SERVER CLOSE ERROR", error);
                    resolve();
                });
            });
        }

        if (mongoose.connection.readyState !== 0) {
            await mongoose.connection.close(false);
            console.log("MongoDB connection closed");
        }

        console.log("Server shutdown completed");
        process.exit(0);
    } catch (error) {
        logError("GRACEFUL SHUTDOWN ERROR", error);
        process.exit(1);
    }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function startServer() {
    try {
        if (!process.env.MONGODB_URI) {
            throw new Error("MONGODB_URI chưa được cấu hình trong file .env");
        }

        if (!process.env.SESSION_SECRET) {
            console.warn("WARNING: SESSION_SECRET chưa được cấu hình.");

            if (process.env.NODE_ENV === "production") {
                throw new Error(
                    "SESSION_SECRET bắt buộc phải được cấu hình ở production."
                );
            }
        }

        console.log("");
        console.log("============================================================");
        console.log("STARTING SERVER");
        console.log("============================================================");
        console.log("Environment:", process.env.NODE_ENV || "development");
        console.log("Port:", PORT);

        const safeMongoURI = MONGODB_URI.replace(
            /\/\/([^:]+):([^@]+)@/,
            "//***:***@"
        );
        console.log("MongoDB:", safeMongoURI);

        try {
            await connectDB();
        } catch (error) {
            throw error;
        }

        try {
            server = app.listen(PORT, () => {
                console.log("");
                console.log("==============================================");
                console.log("  LUYEN THI CNTT UTC - MNHA");
                console.log("==============================================");
                console.log(`  Server: http://localhost:${PORT}`);
                console.log(`  Environment: ${process.env.NODE_ENV || "development"}`);
                console.log("  MongoDB: connected");
                console.log("  Status: ONLINE");
                console.log("==============================================");
                console.log("");
            });

            server.on("error", (error) => {
                logError("HTTP SERVER ERROR", error);
                if (error.code === "EADDRINUSE") {
                    console.error(`Port ${PORT} đang được sử dụng bởi process khác.`);
                }
                if (error.code === "EACCES") {
                    console.error(`Không có quyền sử dụng port ${PORT}.`);
                }
                process.exit(1);
            });

            server.on("clientError", (error, socket) => {
                logError("HTTP CLIENT ERROR", error);
                if (socket.writable) {
                    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
                }
            });
        } catch (error) {
            logError("HTTP SERVER START FAILED", error);
            await mongoose.connection.close();
            throw error;
        }
    } catch (error) {
        logError("SERVER STARTUP FAILED", error);

        try {
            if (mongoose.connection.readyState !== 0) {
                await mongoose.connection.close();
            }
        } catch (closeError) {
            logError("MONGODB CLOSE AFTER STARTUP FAILURE", closeError);
        }

        process.exit(1);
    }
}

if (require.main === module) {
    startServer();
}

app.connectDB = connectDB;
module.exports = app;