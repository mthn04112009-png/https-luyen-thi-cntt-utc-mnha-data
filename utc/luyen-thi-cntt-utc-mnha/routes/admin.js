const express = require("express");
const mongoose = require("mongoose");

const lessonController = require("../controllers/lesson.controller");
const subjectController = require("../controllers/subject.controller");
const submissionController = require("../controllers/submission.controller");
const disputeController = require("../controllers/dispute.controller");
const promptController = require("../controllers/prompt.controller");
const aiKeyController = require("../controllers/aikey.controller");
const cloudinaryController = require("../controllers/cloudinary.controller");
const userKeyController = require("../controllers/userkey.controller");
const layoutController = require("../controllers/layout.controller");
const layoutService = require("../services/layoutService");

const userKeyService = require("../services/userKeyService");
const githubSync = require("../services/githubSyncService");
const { attachUser, isDefaultAdmin } = require("../middleware/auth");
const { adminOnly, requireDefaultAdmin, ownContentFilter } = require("../middleware/role");

const router = express.Router();


// ============================================================
// MIDDLEWARE
// ============================================================

router.use("/users/:id", (req, res, next) => {
    req.headers["x-requested-with"] = "XMLHttpRequest";
    next();
});

router.use(attachUser, adminOnly);

function isValidId(id) {
    return mongoose.Types.ObjectId.isValid(id);
}


// ============================================================
// DASHBOARD
// ============================================================

router.get("/dashboard", async (req, res) => {
    try {
        const User = require("../models/User");
        const Subject = require("../models/Subject");
        const Lesson = require("../models/Lesson");
        const Submission = require("../models/Submission");

        const actor = req.user;
        const isDef = isDefaultAdmin(actor);

        const userScope = isDef ? {} : await userKeyService.buildUserListFilter(actor);
        const subjectOwn = ownContentFilter(actor, Subject);
        const lessonOwn = ownContentFilter(actor, Lesson);
        const submissionFilter = isDef
            ? {}
            : { lessonId: { $in: await Lesson.distinct("_id", lessonOwn) } };

        const [
            usersCount,
            subjectsCount,
            lessonsCount,
            submissionsCount,
            recentSubmissions
        ] = await Promise.all([
            User.countDocuments({ $and: [{ deletedForever: { $ne: true } }, userScope] }),
            Subject.countDocuments({ deletedForever: { $ne: true }, deletedAt: null, ...subjectOwn }),
            Lesson.countDocuments({ isDeleted: false, ...lessonOwn }),
            Submission.countDocuments(submissionFilter),
            Submission.find(submissionFilter)
                .populate("userId", "name email")
                .populate("lessonId", "title")
                .sort({ createdAt: -1 })
                .limit(10)
                .lean()
        ]);

        const stats = {
            users: usersCount,
            subjects: subjectsCount,
            lessons: lessonsCount,
            submissions: submissionsCount
        };

        const mappedRecent = recentSubmissions.map((s) => ({
            _id: s._id,
            student: s.userId || null,
            lesson: s.lessonId || null,
            score: s.score,
            status: s.status || (s.gradedAt ? "graded" : "pending"),
            createdAt: s.createdAt
        }));

        return res.render("admin/dashboard", {
            title: "Dashboard",
            user: req.user,
            isDefaultAdmin: isDef,
            stats,
            recentSubmissions: mappedRecent
        });
    } catch (error) {
        console.error("dashboard error:", error);
        return res.status(500).render("error", {
            title: "Lỗi",
            message: "Không thể tải dashboard.",
            statusCode: 500,
            stack: null
        });
    }
});


// ============================================================
// SUBJECTS
// ============================================================

router.get("/subjects", subjectController.getAdminSubjects);
router.post("/subjects", subjectController.createSubject);

router.get("/subjects/:id/edit", subjectController.showEditSubject);
router.post("/subjects/:id/edit", subjectController.updateSubject);

router.post("/subjects/:id/delete", subjectController.deleteSubject);
router.post("/subjects/:id/restore", subjectController.restoreSubject);
router.post("/subjects/:id/hard-delete", subjectController.hardDeleteSubject);


// ============================================================
// ĐỒNG BỘ GITHUB → MONGODB (bài học, prompt, lịch sử bài nộp)
// ------------------------------------------------------------
// GitHub là nguồn sự thật. Các trang danh sách tự đồng bộ nhẹ (tối thiểu 15s/lần);
// nút này ép ĐỌC LẠI toàn bộ file JSON — dùng khi vừa sửa/xoá file trực tiếp trên GitHub.
// Chỉ admin hệ thống (default) vì đồng bộ chạm dữ liệu của mọi tổ chức.
// ============================================================
const SYNC_BACK_OK = [/^\/admin\/lessons(\?.*)?$/, /^\/admin\/prompts(\?.*)?$/, /^\/admin\/submissions(\?.*)?$/];

router.post("/sync-github", requireDefaultAdmin, async (req, res) => {
    const back = String(req.body?.back || "");
    const target = SYNC_BACK_OK.some((re) => re.test(back)) ? back : "/admin/lessons";
    const sep = target.includes("?") ? "&" : "?";

    try {
        const results = await githubSync.syncKinds(["lessons", "prompts", "submissions"], { force: true });
        const failed = results.find((r) => r && r.error);
        if (failed) {
            return res.redirect(303, `${target}${sep}error=` + encodeURIComponent("Đồng bộ GitHub lỗi: " + failed.error));
        }
        const sum = (k) => results.find((r) => r && r.kind === k) || {};
        const part = (k, label) => {
            const r = sum(k);
            return `${label}: ${r.files ?? 0} file (+${r.imported || 0} mới, ~${r.updated || 0} cập nhật, -${r.removed || 0} xoá${r.pending ? `, còn ${r.pending} file chờ lần sau` : ""})`;
        };
        const msg = "Đã đồng bộ từ GitHub — " + [
            part("lessons", "Bài học"), part("prompts", "Prompt"), part("submissions", "Bài nộp")
        ].join(" · ");

        req.flash?.("success", msg);
        return res.redirect(303, `${target}${sep}success=` + encodeURIComponent(msg));
    } catch (err) {
        console.error("sync-github error:", err);
        return res.redirect(303, `${target}${sep}error=` + encodeURIComponent("Đồng bộ GitHub lỗi: " + err.message));
    }
});


// ============================================================
// LESSONS
// ============================================================

router.get("/lessons", lessonController.getAdminLessons);

router.get("/lessons/create", lessonController.showCreateLesson);
// ★ Vercel/proxy có thể "phát lại" POST (307/308) tới URL đích của redirect sau đồng bộ
//   (/admin/lessons?success=...) → createLesson báo "Thiếu subjectId hoặc title".
//   Form tạo bài thật không bao giờ có ?success / ?error → coi đó là POST bị phát lại, đổi sang GET.
router.post("/lessons", (req, res, next) => {
    if (req.query.success !== undefined || req.query.error !== undefined) {
        return res.redirect(303, req.originalUrl);
    }
    return next();
}, lessonController.createLesson);

router.get("/lessons/:id/edit", lessonController.showEditLesson);
router.post("/lessons/:id/edit", lessonController.updateLesson);

router.post("/lessons/:id/delete", lessonController.deleteLesson);
router.post("/lessons/:id/restore", lessonController.restoreLesson);
router.post("/lessons/:id/hard-delete", lessonController.hardDeleteLesson);


// ============================================================
// SUBMISSIONS
// ============================================================

router.get("/submissions", submissionController.getAdminSubmissions);

router.get("/submissions/:id/review", submissionController.getSubmissionReview);
router.post("/submissions/:id/review", submissionController.saveTeacherComment);


// ============================================================
// PROMPTS
// ============================================================

router.get("/prompts", promptController.getPrompts);

router.get("/prompts/create", promptController.showCreatePrompt);
router.post("/prompts", promptController.createPrompt);

router.get("/prompts/:id/edit", promptController.showEditPrompt);
router.post("/prompts/:id/edit", promptController.updatePrompt);

router.post("/prompts/:id/set-default", requireDefaultAdmin, promptController.setDefault);
router.post("/prompts/:id/delete", promptController.deletePrompt);
router.post("/prompts/:id/hard-delete", promptController.hardDeletePrompt);


// ============================================================
// AI KEYS
// ============================================================

router.use("/ai-keys", requireDefaultAdmin);

router.get("/ai-keys", aiKeyController.getAIKeys);

// Cloudinary (kiểm duyệt ảnh) — AES-256-GCM, không có bật/tắt
router.get("/ai-keys/cloudinary", cloudinaryController.getCloudinary);
router.post("/ai-keys/cloudinary", cloudinaryController.saveCloudinary);
router.post("/ai-keys/cloudinary/:id/delete", cloudinaryController.deleteCloudinary);

router.post("/ai-keys", aiKeyController.createAIKey);
router.post("/ai-keys/:id/toggle", aiKeyController.toggleAIKey);
router.post("/ai-keys/:id/delete", aiKeyController.deleteAIKey);


// ============================================================
// USER KEYS
// ============================================================

router.use("/user-keys", requireDefaultAdmin);

router.get("/user-keys", userKeyController.listUserKeys);
router.post("/user-keys", userKeyController.createUserKey);
router.post("/user-keys/:id/update", userKeyController.updateUserKey);
router.post("/user-keys/:id/toggle", userKeyController.toggleUserKey);


// ============================================================
// DISPUTES
// ============================================================

router.get("/disputes", disputeController.getDisputes);


// ============================================================
// ROLES
// ============================================================

router.use("/roles", requireDefaultAdmin);

router.get("/roles", async (req, res) => {
    try {
        const Role = require("../models/Role");
        const roles = await Role.find().sort({ name: 1 }).lean();

        return res.render("admin/roles", {
            title: "Quản lý quyền",
            user: req.user,
            isDefaultAdmin: true,
            roles
        });
    } catch (error) {
        console.error("roles error:", error);
        return res.status(500).render("admin/roles", {
            title: "Quản lý quyền",
            user: req.user,
            isDefaultAdmin: true,
            roles: [],
            error: error.message
        });
    }
});


// ============================================================
// USERS
// ------------------------------------------------------------
//  - admin default : thấy & xử lý toàn bộ user, được lọc theo userKey,
//                    được đổi userKey gốc VÀ connectedUserKeys (multi).
//  - admin user_key: chỉ client/student cùng userKey; mọi thay đổi
//                    userKey / connectedUserKeys gửi lên đều bị bỏ qua.
// ============================================================

router.get("/users", async (req, res) => {
    try {
        const User = require("../models/User");
        const UserKey = require("../models/UserKey");
        const actor = req.user;
        const isDef = isDefaultAdmin(actor);

        const scope = await userKeyService.buildUserListFilter(actor);
        const scoped = (extra = {}) => ({ $and: [scope, extra] });

        const q = (req.query.q || "").trim();
        const role = req.query.role || "all";
        const status = req.query.status || "all";
        // 👇 Bộ lọc tổ chức gốc: 'all' | 'default' | ObjectId | 'unassigned'
        const userKeyFilter = (req.query.userKey || "all").toString().trim();
        // 👇 MỚI: lọc user có KẾT NỐI tới 1 tổ chức cụ thể (khớp connectedUserKeys)
        const connectedKeyFilter = (req.query.connectedKey || "").toString().trim();

        const extra = {};

        if (q) {
            extra.$or = [
                { name: { $regex: q, $options: "i" } },
                { email: { $regex: q, $options: "i" } }
            ];
        }

        if (role !== "all") {
            extra.role = role;
        }

        if (status !== "all") {
            extra.status = status;
        }

        // 👇 CHỈ admin default mới được lọc theo userKey (gốc)
        if (isDef && userKeyFilter !== "all") {
            if (userKeyFilter === "default" || userKeyFilter === "unassigned") {
                extra.userKey = { $in: [null] };
            } else if (mongoose.Types.ObjectId.isValid(userKeyFilter)) {
                extra.userKey = userKeyFilter;
            }
        }

        // 👇 MỚI: lọc user có connectedUserKeys chứa tổ chức X (chỉ admin default)
        if (isDef && connectedKeyFilter && mongoose.Types.ObjectId.isValid(connectedKeyFilter)) {
            extra.connectedUserKeys = connectedKeyFilter;
        }

        const [users, total, pending, student, admin, client] = await Promise.all([
            User.find(scoped(extra))
                .select("-password -passwordHash")
                .populate("approvedBy", "name email")
                .populate("userKey", "name code active")
                // 👇 MỚI: populate mảng connectedUserKeys để view hiện tên tổ chức
                .populate("connectedUserKeys", "name code active")
                .sort({ createdAt: -1 })
                .lean(),
            User.countDocuments(scoped()),
            User.countDocuments(scoped({ status: "pending" })),
            User.countDocuments(scoped({ role: "student" })),
            User.countDocuments(scoped({ role: "admin" })),
            User.countDocuments(scoped({ role: "client" }))
        ]);

        // 👇 userKeys dùng cho cả dropdown lọc lẫn checkbox trong modal Sửa
        const userKeys = isDef
            ? await UserKey.find({ active: true })
                  .sort({ name: 1 })
                  .select("name code")
                  .lean()
            : [];

        const stats = { total, pending, student, admin, client };
        const filters = {
            q,
            role,
            status,
            userKey: userKeyFilter,
            connectedKey: connectedKeyFilter
        };

        return res.render("admin/users", {
            title: "Quản lý người dùng",
            user: req.user,
            isDefaultAdmin: isDef,
            canManageUserKey: isDef,
            users,
            userKeys,
            stats,
            filters
        });
    } catch (error) {
        console.error("users error:", error);
        const isDef = isDefaultAdmin(req.user);
        return res.status(500).render("admin/users", {
            title: "Quản lý người dùng",
            user: req.user,
            isDefaultAdmin: isDef,
            canManageUserKey: isDef,
            users: [],
            userKeys: [],
            stats: { total: 0, pending: 0, student: 0, admin: 0, client: 0 },
            filters: { q: "", role: "all", status: "all", userKey: "all", connectedKey: "" },
            error: error.message
        });
    }
});

router.post("/users/:id/approve", async (req, res) => {
    try {
        const User = require("../models/User");
        const actor = req.user;

        if (!isValidId(req.params.id)) {
            return res.status(404).json({ success: false, message: "Không tìm thấy người dùng." });
        }

        const scope = await userKeyService.buildUserListFilter(actor);
        const targetUser = await User.findOne({ $and: [{ _id: req.params.id }, scope] });

        if (!targetUser) {
            return res.status(404).json({ success: false, message: "Không tìm thấy người dùng." });
        }

        const changes = await userKeyService.resolveApproval(actor, targetUser, {
            role: req.body.role || "student",
            userKey: req.body.userKey || undefined
        });

        // Ghi có điều kiện: nếu giữa chừng có admin khác đã duyệt / nhận user này rồi
        // (status hoặc userKey đã đổi) thì không ghi đè → báo 409.
        const result = await User.updateOne(
            {
                _id: targetUser._id,
                status: targetUser.status,
                role: targetUser.role,
                userKey: targetUser.userKey || null
            },
            { $set: changes }
        );
        if (!result.matchedCount) {
            return res.status(409).json({
                success: false,
                message: "Tài khoản này vừa được xử lý bởi người khác. Hãy tải lại trang."
            });
        }

        return res.json({ success: true });
    } catch (error) {
        const code = error.status || error.statusCode || 500;
        if (code >= 500) console.error("approve user error:", error);
        return res.status(code).json({
            success: false,
            message: code >= 500 ? "Lỗi máy chủ khi duyệt người dùng." : error.message
        });
    }
});

router.post("/users/:id/update", async (req, res) => {
    try {
        const User = require("../models/User");
        const UserKey = require("../models/UserKey");
        const actor = req.user;
        const isDef = isDefaultAdmin(actor);
        // 👇 MỚI: nhận thêm connectedUserKeys (mảng ObjectId)
        const { name, role, status, userKey, connectedUserKeys, canEditLayout } = req.body;

        if (!isValidId(req.params.id)) {
            return res.status(404).json({ success: false, message: "Không tìm thấy người dùng." });
        }

        const scope = await userKeyService.buildUserListFilter(actor);
        const targetUser = await User.findOne({ $and: [{ _id: req.params.id }, scope] });
        if (!targetUser) {
            return res.status(404).json({ success: false, message: "Không tìm thấy người dùng." });
        }

        // ★ Client mới chưa gán tổ chức: admin user_key chỉ được DUYỆT (nhận về tổ chức mình),
        //   không được sửa/từ chối — tránh tác động tới người chưa thuộc tổ chức mình.
        if (!isDef && !targetUser.userKey) {
            return res.status(403).json({
                success: false,
                message: "Hãy bấm Duyệt để nhận tài khoản này vào tổ chức của bạn trước khi chỉnh sửa."
            });
        }

        // Admin user_key không được nâng ai lên admin
        if (!isDef && role !== undefined && !["client", "student"].includes(role)) {
            return res.status(403).json({
                success: false,
                message: "Bạn chỉ được đặt vai trò client hoặc student."
            });
        }

        if (name !== undefined) targetUser.name = String(name).trim();
        if (role !== undefined) targetUser.role = role;
        if (status !== undefined) targetUser.status = status;

        // ------------------------------------------------------------
        // 👇 CHỈ admin default được đổi userKey (gốc) VÀ connectedUserKeys
        // ------------------------------------------------------------
        if (isDef && userKey !== undefined) {
            if (userKey === "" || userKey === null || userKey === "default") {
                targetUser.userKey = null;
            } else if (mongoose.Types.ObjectId.isValid(userKey)) {
                const org = await UserKey.exists({ _id: userKey, active: true });
                if (!org) {
                    return res.status(400).json({
                        success: false,
                        message: "Tổ chức không tồn tại hoặc đã bị tắt."
                    });
                }
                targetUser.userKey = userKey;
            } else {
                return res.status(400).json({
                    success: false,
                    message: "userKey không hợp lệ."
                });
            }
        }

        // 👇 MỚI: ghi đè mảng connectedUserKeys (chỉ admin default)
        //   - Chỉ nhận mảng ObjectId hợp lệ + tồn tại + active
        //   - Tự loại bỏ trùng với userKey GỐC (vì connected = "ngoài tổ chức gốc")
        //   - Loại bỏ trùng lặp trong chính mảng
        if (isDef && Array.isArray(connectedUserKeys)) {
            const seen = new Set();
            const rootId = targetUser.userKey ? String(targetUser.userKey) : null;
            const cleaned = [];

            for (const raw of connectedUserKeys) {
                const idStr = String(raw || "").trim();
                if (!idStr || !mongoose.Types.ObjectId.isValid(idStr)) continue;
                if (idStr === rootId) continue;            // trùng userKey gốc → bỏ
                if (seen.has(idStr)) continue;             // trùng lặp → bỏ
                seen.add(idStr);
                cleaned.push(idStr);
            }

            // Xác thực tất cả còn tồn tại + active (1 query)
            if (cleaned.length) {
                const validOrgs = await UserKey.find({
                    _id: { $in: cleaned },
                    active: true
                })
                    .select("_id")
                    .lean();
                const validSet = new Set(validOrgs.map((o) => String(o._id)));
                targetUser.connectedUserKeys = cleaned.filter((id) => validSet.has(id));
            } else {
                targetUser.connectedUserKeys = [];
            }
        }

        // ------------------------------------------------------------
        // 👇 MỚI: quyền sửa layout
        //   - CHỈ admin default được cấp/thu hồi (gửi lên từ admin user_key bị bỏ qua)
        //   - Chỉ có nghĩa với role=admin + userKey != null; ngược lại LUÔN ép về false
        //     (đổi admin thành student/client hoặc đưa về tổ chức default = tự thu hồi)
        // ------------------------------------------------------------
        const prevCanEditLayout = targetUser.canEditLayout === true;
        if (isDef && canEditLayout !== undefined) {
            targetUser.canEditLayout = canEditLayout === true || canEditLayout === "true";
        }
        if (targetUser.role !== "admin" || !targetUser.userKey) {
            targetUser.canEditLayout = false;
        }
        const nextCanEditLayout = targetUser.canEditLayout === true;

        await targetUser.save();

        if (nextCanEditLayout !== prevCanEditLayout) {
            await layoutService.audit(
                req,
                nextCanEditLayout ? "grant_layout_edit" : "revoke_layout_edit",
                { targetUser: targetUser._id, userKey: targetUser.userKey }
            );
        }

        return res.json({ success: true });
    } catch (error) {
        console.error("update user error:", error);
        return res.status(500).json({ success: false, message: "Lỗi máy chủ khi cập nhật người dùng." });
    }
});

// Cấp / thu hồi quyền sửa layout (chỉ admin default; đích phải là admin thuộc một user_key)
router.post("/users/:id/layout-permission", requireDefaultAdmin, layoutController.setLayoutPermission);

router.post("/users/:id/delete", requireDefaultAdmin, async (req, res) => {
    try {
        const User = require("../models/User");

        if (!isValidId(req.params.id)) {
            return res.status(404).json({ success: false, message: "Không tìm thấy người dùng." });
        }
        if (String(req.params.id) === String(req.user._id)) {
            return res.status(400).json({ success: false, message: "Không thể tự xoá tài khoản của chính mình." });
        }

        const deleted = await User.findByIdAndDelete(req.params.id);

        if (!deleted) {
            return res.status(404).json({ success: false, message: "Không tìm thấy người dùng." });
        }

        return res.json({ success: true });
    } catch (error) {
        console.error("delete user error:", error);
        return res.status(500).json({ success: false, message: "Lỗi máy chủ khi xoá người dùng." });
    }
});


// ============================================================
// AUDIT LOG
// ============================================================

router.use("/audit-log", requireDefaultAdmin);

router.get("/audit-log", async (req, res) => {
    const q = String(req.query.q || "").trim().slice(0, 100);
    const action = String(req.query.action || "").trim().slice(0, 100);
    const entity = String(req.query.entity || "").trim().slice(0, 100);
    const page = Math.max(1, Number(req.query.page) || 1);

    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (action) params.set("action", action);
    if (entity) params.set("entity", entity);
    const baseUrl = "/admin/audit-log?" + (params.toString() ? params.toString() + "&" : "");

    try {
        // ★ Audit log lưu ở GitHub (auditlogs/index.json) — xem services/auditLogService.js
        const auditLogService = require("../services/auditLogService");
        const result = await auditLogService.list({
            page,
            limit: 50,
            q,
            action,
            entity,
            force: req.query.refresh === "1",   // ?refresh=1 → bỏ cache 15 giây, đọc lại GitHub
        });

        return res.render("admin/auditlog", {
            title: "Audit Log",
            user: req.user,
            logs: result.logs,
            total: result.total,
            grandTotal: result.grandTotal,
            currentPage: result.page,
            totalPages: result.pages,
            actions: result.actions,
            entities: result.entities,
            filters: { q, action, entity },
            baseUrl
        });
    } catch (error) {
        // ★ GitHub sập / bảo trì / mất mạng → trang báo lỗi riêng ("GitHub đang gặp vấn đề, vui lòng quay lại sau")
        const { isGithubUnavailable, renderGithubDown } = require("../utils/githubErrors");
        if (isGithubUnavailable(error, { assumeGithub: true })) {
            return renderGithubDown(req, res, error);
        }
        console.error("audit-log error:", error);
        return res.status(500).render("admin/auditlog", {
            title: "Audit Log",
            user: req.user,
            logs: [],
            total: 0,
            grandTotal: 0,
            currentPage: 1,
            totalPages: 1,
            actions: [],
            entities: [],
            filters: { q, action, entity },
            baseUrl,
            error: error.message
        });
    }
});


module.exports = router;