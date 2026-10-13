// controllers/lesson.controller.js
const mongoose = require("mongoose");
const path = require("path");
const fs = require("fs");

const Subject = require("../models/Subject");
const Lesson = require("../models/Lesson");
const Submission = require("../models/Submission");
const User = require("../models/User");
const GradingPrompt = require("../models/GradingPrompt");
const githubService = require("../services/githubService");
const lessonContentService = require("../services/lessonContentService");
const githubSync = require("../services/githubSyncService");
const { resolvePrompt, findUnknownPlaceholders } = require("../services/promptService");
const { sanitizeExplanationHtml } = require("../services/sanitizeService");
const { getContentScope } = require("../services/userKeyService");
const { formatAiLabel } = require("../utils/aiLabel");
const { paginate } = require("./pagination.controller");

/* ============================================================
 * HELPERS
 * ============================================================ */

function slugify(str = "") {
    return String(str)
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/g, "d")
        .replace(/[^a-z0-9\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-");
}

function isObjectId(str) {
    return mongoose.Types.ObjectId.isValid(str) && String(str).length === 24;
}

// ★ vilao.ai: gắn nhãn "Gemini: {tên}" / "vilao.ai: {tên}" cho từng key (key cũ thiếu provider = gemini)
function withAiLabels(aiKeys) {
    return (aiKeys || []).map((k) => ({
        ...k,
        provider: k.provider || "gemini",
        aiLabel: formatAiLabel(k.provider || "gemini", k.name),
    }));
}

// ★ vilao.ai: nhãn AI hiện ở trang làm bài.
//   - Bài gán đích danh 1 key  -> nhãn của key đó
//   - Bài dùng xoay key        -> "Gemini" (mặc định, chưa biết key nào sẽ chấm)
async function getLessonAiLabel(lesson) {
    try {
        if (lesson && lesson.aiKeyId) {
            const AIKey = require("../models/AIKey");
            const key = await AIKey.findById(lesson.aiKeyId).select("name provider").lean();
            if (key) return formatAiLabel(key.provider || "gemini", key.name);
        }
    } catch (err) {
        console.warn("[lesson] Không lấy được nhãn AI key:", err.message);
    }
    return formatAiLabel("gemini");
}

// ★ Lấy provider THẬT của từng AI key từ MongoDB -> { "<keyId>": "vilao" | "gemini" }
//   View dùng map này để gắn nhãn đúng (không phụ thuộc /api/ai/keys có trả provider hay không).
//   Chỉ trả id + provider (không trả tên/khoá).
async function getAiKeyProviderMap() {
    try {
        const AIKey = require("../models/AIKey");
        const rows = await AIKey.find({ isRevoked: { $ne: true } })
            .select("_id provider")
            .lean();
        const map = {};
        rows.forEach((r) => {
            map[String(r._id)] = String(r.provider || "gemini").toLowerCase();
        });
        return map;
    } catch (err) {
        console.warn("[lesson] Không lấy được provider của AI key:", err.message);
        return {};
    }
}

// ★ FIX: đổi model sang 1 field `isDeleted` (boolean) = XOÁ MỀM (vào thùng rác).
//   XOÁ CỨNG (hardDeleteLesson) giờ xoá thật khỏi database — không còn field
//   "deletedForever" nữa, vì bài đã bị xoá cứng thì document không còn tồn tại,
//   tự nhiên không match bất kỳ query nào.
// - findLessonByParam: CHỈ lấy bài đang hoạt động (isDeleted: false) — dùng cho
//   luồng học/nộp bài bình thường.
// - findLessonByParamAny: lấy cả bài đang ở thùng rác (isDeleted: true) để còn
//   hiển thị trang "Bài học đã bị xoá" thay vì quăng lỗi 404 chung chung.
//   Bài đã bị xoá CỨNG thì document không còn trong DB → tự động trả về null
//   → rơi vào nhánh 404 (đúng bản chất: nó không còn tồn tại).
async function findLessonByParam(param) {
    const baseFilter = isObjectId(param) ? { _id: param } : { slug: param };
    return Lesson.findOne({
        ...baseFilter,
        isDeleted: false,
    }).lean();
}

async function findLessonByParamAny(param) {
    const baseFilter = isObjectId(param) ? { _id: param } : { slug: param };
    return Lesson.findOne(baseFilter).lean();
}

async function readLessonFromGithub(filePath) {
    const fn =
        (typeof githubService.readJsonFile === "function" && githubService.readJsonFile) ||
        (typeof githubService.getJSON === "function" && githubService.getJSON) ||
        null;

    if (!fn) throw new Error("githubService không có method readJsonFile/getJSON");
    return fn(filePath);
}

async function attachSubjects(lessons) {
    const subjectIds = [
        ...new Set(
            lessons
                .map((l) => l.subjectId || l.subject)
                .filter(Boolean)
                .map(String)
        ),
    ];

    const subjects = subjectIds.length
        ? await Subject.find({ _id: { $in: subjectIds } }).lean()
        : [];

    const subjectMap = Object.fromEntries(subjects.map((s) => [String(s._id), s]));

    return lessons.map((l) => {
        const sid = String(l.subjectId || l.subject || "");
        return {
            ...l,
            subjectId: l.subjectId || l.subject || null,
            subject: subjectMap[sid] || null,
        };
    });
}

// ★ GitHub là nguồn sự thật: thông tin người thao tác ghi vào JSON bài học
//   để dựng lại được MongoDB chỉ từ GitHub.
function actorMeta(req) {
    const u = req.user || req.session?.user || {};
    return { id: String(u._id || u.id || ""), name: u.name || "", email: u.email || "" };
}

async function userMeta(userId) {
    if (!userId) return null;
    try {
        const User = require("../models/User");
        const u = await User.findById(userId).select("name email").lean();
        return u ? { id: String(u._id), name: u.name || "", email: u.email || "" } : { id: String(userId), name: "", email: "" };
    } catch (_) {
        return { id: String(userId), name: "", email: "" };
    }
}

// Chỉ thao tác (chuyển/xoá) file nằm đúng quy ước subjects/{môn}/lessons/{file}.json
const STD_LESSON_RE = /^subjects\/[^/]+\/lessons\/[^/]+\.json$/;

// ★ FIX: helper đọc flash message an toàn (connect-flash trả về mảng)
function readFlash(req, key) {
    if (typeof req.flash !== "function") return null;
    const arr = req.flash(key);
    return Array.isArray(arr) && arr.length ? arr[0] : null;
}

// ★ FIX: lấy userId an toàn — ưu tiên req.user (nếu middleware đã gán),
//   fallback về req.session.user. Nhờ vậy controller không phụ thuộc vào
//   việc middleware có gán req.user hay không → createdBy/updatedBy luôn
//   ghi được ObjectId thay vì null.
function currentUserId(req) {
    return req.user?._id || req.session?.user?._id || null;
}

// ★ USER KEY: mọi truy cập vượt phạm vi tổ chức đều trả 404 (giống "không tồn
//   tại") thay vì 403, để không lộ việc bài/môn đó có thật ở tổ chức khác.
//   Phạm vi được tính bởi getContentScope() trong services/userKeyService.js:
//     - scope.filter    : spread vào Subject.find / Lesson.find
//     - scope.canAccess : kiểm tra 1 document đã load
function renderNotFound(req, res, message) {
    return res.status(404).render("error", {
        title: "Không tìm thấy",
        message,
        user: req.user,
        statusCode: 404,
        stack: null,
    });
}

/* ============================================================
 * 1. LIST SUBJECTS
 * ============================================================ */
exports.listSubjects = async (req, res, next) => {
    try {
        const isAdmin = req.user?.role === "admin";
        const scope = await getContentScope(req); // ★ USER KEY
        await githubSync.syncKinds(["lessons"]);   // ★ số bài học lấy từ GitHub

        const { items: subjects, pagination } = await paginate(
            Subject,
            {
                deletedAt: null,
                deletedForever: false,
                ...scope.filter,
            },
            req,
            { limit: 9, sort: { createdAt: -1 } }
        );

        const subjectIds = subjects.map((s) => s._id);

        const lessonCounts = await Lesson.aggregate([
            { $match: { subjectId: { $in: subjectIds }, isDeleted: false } },
            { $group: { _id: "$subjectId", count: { $sum: 1 } } },
        ]);

        const countMap = Object.fromEntries(lessonCounts.map((l) => [String(l._id), l.count]));

        const data = subjects.map((s) => ({
            ...s,
            lessonCount: countMap[String(s._id)] || 0,
        }));

        res.render("student/subjects", {
            title: "Môn học",
            user: req.user,
            subjects: data,
            isAdminView: isAdmin,
            ...pagination,
        });
    } catch (err) {
        next(err);
    }
};

/* ============================================================
 * 2. LIST LESSONS (theo subject)
 * ============================================================ */
exports.listLessons = async (req, res, next) => {
    try {
        const { slug } = req.params;
        const scope = await getContentScope(req); // ★ USER KEY

        const subject = await Subject.findOne({
            slug,
            deletedAt: null,
            deletedForever: false,
            ...scope.filter,
        }).lean();

        if (!subject) {
            return res.status(404).render("error", {
                title: "Không tìm thấy",
                message: "Môn học không tồn tại",
                user: req.user,
                statusCode: 404,
                stack: null,
            });
        }

        await githubSync.syncKinds(["lessons"]);

        // ★ Đề mới nhất lên đầu (mới → cũ)
        const lessons = await Lesson.find({
            subjectId: subject._id,
            isDeleted: false,
        }).sort({ createdAt: -1 }).populate("createdBy", "name").lean();

        const submittedMap = {};
        if (req.user) {
            const subs = await Submission.find({
                userId: req.user._id,
                lessonId: { $in: lessons.map((l) => l._id) },
            }).sort({ submittedAt: -1 }).lean();

            subs.forEach((s) => {
                const key = String(s.lessonId);
                if (!submittedMap[key]) {
                    submittedMap[key] = {
                        score: s.score,
                        maxScore: s.maxScore || 10,
                        submittedAt: s.submittedAt,
                        submissionId: s._id,
                    };
                }
            });
        }

        res.render("student/lessons", {
            title: subject.name,
            user: req.user,
            subject,
            lessons,
            submittedMap,
            isAdminView: req.user?.role === "admin",
        });
    } catch (err) {
        next(err);
    }
};

/* ============================================================
 * 2b. LIST ALL LESSONS — admin + student
 * ============================================================ */
exports.listAllLessons = async (req, res, next) => {
    try {
        const user = req.user;
        const isAdmin = user?.role === "admin";

        const scope = await getContentScope(req); // ★ USER KEY
        await githubSync.syncKinds(["lessons"]);

        const subjectQuery = req.query.subject || req.query.subjectId || null;
        const filter = { isDeleted: false, ...scope.filter };

        let currentSubject = null;
        if (subjectQuery) {
            // ★ USER KEY: môn ngoài phạm vi = coi như không tìm thấy
            currentSubject = isObjectId(subjectQuery)
                ? await Subject.findOne({ _id: subjectQuery, ...scope.filter }).lean()
                : await Subject.findOne({ slug: subjectQuery, ...scope.filter }).lean();

            if (currentSubject) filter.subjectId = currentSubject._id;
        }

        const lessons = await Lesson.find(filter)
            .sort({ createdAt: -1 })
            .populate("createdBy", "name email")
            .populate("updatedBy", "name email")
            .lean();
        const lessonsWithSubject = await attachSubjects(lessons);

        const submittedMap = {};
        if (!isAdmin && user) {
            const subs = await Submission.find({
                userId: user._id,
                lessonId: { $in: lessons.map((l) => l._id) },
            }).sort({ submittedAt: -1 }).lean();

            subs.forEach((s) => {
                const key = String(s.lessonId);
                if (!submittedMap[key]) {
                    submittedMap[key] = {
                        score: s.score,
                        maxScore: s.maxScore || 10,
                        submittedAt: s.submittedAt,
                        submissionId: s._id,
                    };
                }
            });
        }

        const preferredView = isAdmin ? "admin/lessons" : "student/lessons";
        const viewFile = path.join(__dirname, "..", "views", preferredView + ".pug");
        const finalView = fs.existsSync(viewFile) ? preferredView : "student/lessons";

        res.render(finalView, {
            title: currentSubject ? currentSubject.name : "Tất cả bài học",
            user,
            subject: currentSubject,
            lessons: lessonsWithSubject,
            submittedMap,
            // ★ FIX: trang này chỉ liệt kê bài đang hoạt động, không phải trang thùng rác
            showDeleted: false,
            filters: { subject: subjectQuery || "", search: "" },
            isAdminView: isAdmin,
        });
    } catch (err) {
        console.error("❌ listAllLessons:", err);
        next(err);
    }
};

/* ============================================================
 * 3. SHOW LESSON
 * ★ FIX: trước đây bài đã xoá mềm bị lọc mất ở findLessonByParam nên
 *        luôn rơi vào nhánh 404 "Bài học không tồn tại" — gây hiểu lầm
 *        là bài chưa từng có, dù thật ra nó đang nằm trong thùng rác.
 *        Giờ tách riêng: không tìm thấy thật sự → 404; tìm thấy nhưng
 *        đã bị xoá mềm → render trang "lesson-deleted".
 * ============================================================ */
exports.showLesson = async (req, res, next) => {
    try {
        const key = req.params.id || req.params.slug;
        const lesson = await findLessonByParamAny(key);

        if (!lesson) {
            return res.status(404).render("error", {
                title: "Không tìm thấy",
                message: "Bài học không tồn tại",
                user: req.user,
                statusCode: 404,
                stack: null,
            });
        }

        // ★ USER KEY: chặn cả trang bài học lẫn trang "đã bị xoá" nếu ngoài phạm vi
        const scope = await getContentScope(req);
        if (!scope.canAccess(lesson)) {
            return renderNotFound(req, res, "Bài học không tồn tại");
        }

        if (lesson.isDeleted) {
            return renderDeletedLessonPage(req, res, lesson);
        }

        await renderLessonPage(req, res, lesson);
    } catch (err) {
        next(err);
    }
};

exports.getStudentLesson = exports.showLesson;

/* ============================================================
 * ★ LỊCH SỬ LÀM BÀI CỦA 1 BÀI HỌC — GET /lessons/:id/history
 * ------------------------------------------------------------
 *   - admin  : xem bài nộp của TẤT CẢ sinh viên vào bài học này
 *              (admin user_key vẫn bị giới hạn bởi scope.canAccess(lesson),
 *               giống trang bài học: ngoài tổ chức → 404)
 *   - student: CHỈ xem bài nộp của chính mình (ép userId = user._id ở server,
 *              KHÔNG đọc userId từ query nên không thể xem chéo)
 *   Dùng chung cho cả bài tự luận lẫn trắc nghiệm.
 * ============================================================ */
const HISTORY_PAGE_SIZE = 15;

function escapeRegex(str = "") {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

exports.showLessonHistory = async (req, res, next) => {
    try {
        const user = req.user;
        if (!user) return res.redirect("/auth/login");

        const isAdmin = user.role === "admin";
        if (!isAdmin && user.role !== "student") {
            return res.status(403).render("error", {
                title: "Không có quyền",
                message: "Bạn không có quyền xem lịch sử làm bài.",
                user,
                statusCode: 403,
                stack: null,
            });
        }

        const key = req.params.id || req.params.slug;
        const lesson = await findLessonByParamAny(key);
        if (!lesson) return renderNotFound(req, res, "Bài học không tồn tại");

        // ★ USER KEY: ngoài phạm vi → 404 (không lộ việc bài học có thật)
        const scope = await getContentScope(req);
        if (!scope.canAccess(lesson)) {
            return renderNotFound(req, res, "Bài học không tồn tại");
        }

        // Bài đã vào thùng rác → về trang bài học (đang hiển thị trang "đã bị xoá")
        if (lesson.isDeleted) return res.redirect(`/lessons/${lesson._id}`);

        // Đảm bảo danh sách bài nộp (GitHub → RAM) đang mới
        await githubSync.syncKinds(["submissions"]);

        // ---- Bộ lọc: student luôn bị ép về chính mình ----
        const filter = { lessonId: lesson._id };
        if (!isAdmin) filter.userId = user._id;

        // Admin: tìm theo tên / email sinh viên
        const q = isAdmin ? String(req.query.q || "").trim().slice(0, 100) : "";
        if (isAdmin && q) {
            const safe = escapeRegex(q);
            const userIds = await User.find({
                $or: [
                    { name: { $regex: safe, $options: "i" } },
                    { email: { $regex: safe, $options: "i" } },
                ],
            }).distinct("_id");
            filter.userId = { $in: userIds };
        }

        // ---- Thống kê (trên toàn bộ kết quả lọc, không phụ thuộc trang) ----
        const allRows = await Submission.find(filter)
            .select("userId score maxScore type")
            .lean();
        const isQuizLesson = (lesson.type || "essay") === "quiz";
        let bestScore = null;
        let bestMax = null;
        const studentIds = new Set();
        allRows.forEach((r) => {
            if (r.userId) studentIds.add(String(r.userId._id || r.userId));
            if (r.score !== null && r.score !== undefined && !Number.isNaN(Number(r.score))) {
                if (bestScore === null || Number(r.score) > bestScore) {
                    bestScore = Number(r.score);
                    bestMax = isQuizLesson ? (Number(r.maxScore) || 10) : 10;
                }
            }
        });
        const stats = {
            total: allRows.length,
            students: studentIds.size,
            bestScore,
            bestMax,
        };

        // ---- Danh sách phân trang (mới nộp lên đầu) ----
        const { items: submissions, pagination } = await paginate(Submission, filter, req, {
            limit: HISTORY_PAGE_SIZE,
            sort: { submittedAt: -1, createdAt: -1 },
            select: "-teacherCommentHistory",
            populate: [{ path: "userId", select: "name email" }],
        });

        const subject = lesson.subjectId
            ? await Subject.findById(lesson.subjectId).select("name code slug").lean()
            : null;

        res.render("student/lesson-history", {
            title: `Lịch sử làm bài — ${lesson.title}`,
            user,
            isAdmin,
            lesson: {
                _id: lesson._id,
                title: lesson.title,
                type: lesson.type || "essay",
            },
            subject,
            submissions,
            stats,
            q,
            ...pagination,
        });
    } catch (err) {
        next(err);
    }
};

// ============================================================
// ★ TRẮC NGHIỆM — chuyển đề sang dạng AN TOÀN gửi xuống trình duyệt
// ------------------------------------------------------------
// COPY theo ALLOWLIST: chỉ các field cần để hiển thị. KHÔNG bao giờ gồm
// correct / answers / explanationHtml (đáp án + giải thích chỉ trả sau khi nộp).
// Dùng allowlist (không dùng "xoá field nhạy cảm") để field mới thêm vào đề
// sau này không vô tình bị lộ.
// ============================================================
function toStudentView(quiz) {
    // Dùng CHUNG bản của quiz.controller (đã có audioUrl, pointsPerQuestion,
    // statements + scoring của phần Đúng/Sai). Require lười để tránh vòng lặp require.
    const view = require("./quiz.controller").toStudentView(quiz || {});

    // ★ CÂU HỎI CHÙM (phần mcq / fill): thêm vào bản gửi cho sinh viên, theo allowlist
    //   (id, text, image, questionIds). Nội dung chùm là HTML ngắn → sanitize lại lần nữa
    //   (đã sanitize khi lưu đề). Không chứa đáp án nên an toàn gửi trước khi nộp.
    try {
        ["mcq", "fill"].forEach((k) => {
            const src = quiz && quiz.parts && quiz.parts[k];
            const dst = view && view.parts && view.parts[k];
            if (!src || !dst || !Array.isArray(src.clusters) || !src.clusters.length) return;

            const clusterOf = {};
            dst.clusters = src.clusters.map((c) => {
                const ids = Array.isArray(c.questionIds) ? c.questionIds.map(String) : [];
                ids.forEach((id) => { clusterOf[id] = String(c.id); });
                return {
                    id: String(c.id),
                    text: sanitizeExplanationHtml(c.text || ""),
                    image: c.image || null,
                    questionIds: ids,
                };
            });
            (dst.questions || []).forEach((q) => { q.clusterId = clusterOf[q.id] || null; });
        });
    } catch (err) {
        console.warn("[lesson] Không gắn được câu hỏi chùm:", err.message);
    }
    return view;
}

async function renderQuizLessonPage(req, res, lesson, subject) {
    const user = req.user;

    const subjectSlug = subject?.slug || `subject-${lesson.subjectId}`;
    const lessonSlug = lesson.slug || `lesson-${lesson._id}`;
    const filePath = lesson.githubFile || `subjects/${subjectSlug}/lessons/${lessonSlug}.json`;

    let json = null;
    try {
        json = await readLessonFromGithub(filePath);
    } catch (err) {
        console.warn("[lesson] Không đọc được đề trắc nghiệm từ GitHub:", err.message);
    }

    if (!json || json.type !== "quiz" || !json.quiz) {
        return res.status(503).render("error", {
            title: "Chưa mở được bài",
            message: "Không đọc được đề trắc nghiệm. Vui lòng thử lại sau.",
            user,
            statusCode: 503,
            stack: null,
        });
    }

    const quizView = toStudentView(json.quiz);
    if (!Object.keys(quizView.parts).length) {
        return res.status(503).render("error", {
            title: "Chưa mở được bài",
            message: "Đề trắc nghiệm chưa có câu hỏi nào.",
            user,
            statusCode: 503,
            stack: null,
        });
    }

    const lastSubmission = await Submission.findOne({
        userId: user._id,
        lessonId: lesson._id,
        type: "quiz",
    }).sort({ submittedAt: -1 }).select("_id score maxScore correctCount totalCount submittedAt syncStatus").lean();

    res.render("student/quiz-lesson", {
        title: json.title || lesson.title,
        user,
        subject,
        lesson: {
            _id: lesson._id,
            title: json.title || lesson.title,
            contentHtml: sanitizeExplanationHtml(json.contentHtml || ""),
            duration: Number(lesson.duration) || 20,
            type: "quiz",
        },
        quiz: quizView,
        lastSubmission,
        isAdminView: user.role === "admin",
    });
}

async function renderLessonPage(req, res, lesson) {
    const user = req.user;
    if (!user) return res.redirect("/auth/login");

    const subject = lesson.subjectId
        ? await Subject.findById(lesson.subjectId).lean()
        : null;

    // ★ TRẮC NGHIỆM: view/luồng riêng. Bài cũ không có `type` → essay (giữ nguyên bên dưới).
    if ((lesson.type || "essay") === "quiz") {
        return renderQuizLessonPage(req, res, lesson, subject);
    }

    // ★ NEW: biết chính xác lesson này đang dùng prompt nào (và tại sao)
    const resolvedPrompt = await resolvePrompt(lesson, subject, "essay");
    const promptUnknownPlaceholders = findUnknownPlaceholders(resolvedPrompt?.content);

    const subjectSlug = subject?.slug || `subject-${lesson.subjectId}`;
    const lessonSlug = lesson.slug || `lesson-${lesson._id}`;
    const filePath = lesson.githubFile || `subjects/${subjectSlug}/lessons/${lessonSlug}.json`;

    let lessonContent = {
        title: lesson.title,
        contentHtml: "",
        attachments: [],
        sampleSolution: "",
    };

    // ★ contentHtml CHỈ đọc từ GitHub. Không đọc được → báo lỗi, KHÔNG cho làm bài với đề rỗng
    try {
        const json = await lessonContentService.getLessonContent(lesson, subject?.slug);
        lessonContent = { ...lessonContent, ...json };
    } catch (err) {
        console.warn("[lesson] Không đọc được file GitHub:", err.message);
        return res.status(503).render("error", {
            title: "Chưa mở được bài",
            message: "Không tải được đề bài. Vui lòng thử lại sau ít phút.",
            user,
            statusCode: 503,
            stack: null,
        });
    }

    const finalContentHtml = lessonContent.contentHtml || "";
    const finalSampleSolution = lessonContent.sampleSolution || lesson.sampleSolution || "";

    const lastSubmission = await Submission.findOne({
        userId: user._id,
        lessonId: lesson._id,
    }).sort({ submittedAt: -1 }).lean();

    // ★ vilao.ai: nhãn của key thực tế đã chấm (snapshot lúc chấm; bài cũ = Gemini)
    if (lastSubmission) {
        lastSubmission.aiLabel = formatAiLabel(lastSubmission.aiProvider || "gemini", lastSubmission.aiKeyName);
    }

    const canSeeSample = !!lastSubmission;
    const sampleSolution = canSeeSample ? finalSampleSolution : "";

    // ★ duration từ DB — fallback 20 phút
    const duration = Number(lesson.duration) || 20;

    // ★ vilao.ai: nhãn AI chấm bài
    const aiLabel = await getLessonAiLabel(lesson);
    const aiKeyProviders = await getAiKeyProviderMap();

    res.render("student/lesson", {
        title: lessonContent.title || lesson.title,
        user,
        subject,
        lesson: {
            ...lesson,
            contentHtml: finalContentHtml,
            attachments: lessonContent.attachments || [],
            duration,
        },
        sampleSolution,
        lastSubmission,
        isAdminView: user.role === "admin",
        resolvedPrompt,             // ★ NEW
        promptUnknownPlaceholders,  // ★ NEW
        aiLabel,                    // ★ vilao.ai
        aiKeyProviders,             // ★ provider thật từ MongoDB cho từng key
    });
}

// ★ NEW: trang hiển thị khi bài học đang ở trạng thái xoá mềm (thùng rác).
// - Admin: thấy nút Khôi phục + Xoá vĩnh viễn ngay trên trang.
// - Student: chỉ thấy thông báo lịch sự, không có action.
async function renderDeletedLessonPage(req, res, lesson) {
    const user = req.user;
    const isAdmin = user?.role === "admin";

    const subject = lesson.subjectId
        ? await Subject.findById(lesson.subjectId).lean()
        : null;

    res.status(410).render("lesson-deleted", {
        title: "Bài học đã bị xoá",
        user,
        lesson,
        subject,
        isAdminView: isAdmin,
    });
}

/* ============================================================
 * 5. GET ADMIN LESSONS
 * ★ FIX: hàm này trước đây `Lesson.find()` KHÔNG có điều kiện lọc nào —
 *        luôn trả về TẤT CẢ bài học (kể cả đã xoá mềm) trộn chung một
 *        danh sách, và không hề đọc `req.query.deleted`, `subject`,
 *        `search` dù view `admin/lessons.pug` đã có sẵn UI cho các
 *        filter này (nút "Thùng rác", filter theo môn, ô tìm kiếm).
 *        Ngoài ra `success`/`error` flash cũng chưa được truyền vào view
 *        nên thông báo sau khi xoá/khôi phục không bao giờ hiện ra.
 * ============================================================ */
exports.getAdminLessons = async (req, res, next) => {
    try {
        const showDeleted = req.query.deleted === "1";
        const subjectQuery = req.query.subject || "";
        const search = (req.query.search || "").trim();

        const scope = await getContentScope(req); // ★ USER KEY
        await githubSync.syncKinds(["lessons"]);  // ★ danh sách lấy từ GitHub
        const filter = { isDeleted: showDeleted, ...scope.filter };

        if (subjectQuery && isObjectId(subjectQuery)) {
            filter.subjectId = subjectQuery;
        }

        if (search) {
            filter.title = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
        }

        // ★ FIX: populate để view hiện tên/email người tạo - người sửa
        //   thay vì chỉ là ObjectId thô (xem lessons.pug)
        const { items: lessons, pagination } = await paginate(Lesson, filter, req, {
            limit: 10,
            // ★ Mới nhất → cũ nhất, giống /subjects/:id: dùng _id (mốc thời gian tạo, ổn định)
            //   vì createdAt/updatedAt bị đặt lại khi đồng bộ GitHub nên cùng ngày bị xáo trộn
            sort: { _id: -1 },
            populate: [
                { path: "createdBy", select: "name email" },
                { path: "updatedBy", select: "name email" },
            ],
        });
        const lessonsWithSubject = await attachSubjects(lessons);

        const allSubjects = await Subject.find({
            deletedAt: null,
            deletedForever: false,
            ...scope.filter, // ★ USER KEY
        }).sort({ name: 1 }).lean();

        res.render("admin/lessons", {
            title: "Quản lý Bài học",
            user: req.user,
            lessons: lessonsWithSubject,
            subjects: allSubjects,
            showDeleted,
            ...pagination,
            filters: { subject: subjectQuery, search },
            success: readFlash(req, "success"),
            error: readFlash(req, "error"),
            isAdminView: true,
        });
    } catch (err) {
        console.error("❌ getAdminLessons:", err);
        next(err);
    }
};

/* ============================================================
 * 6. SHOW CREATE FORM
 * ============================================================ */
exports.showCreateLesson = async (req, res, next) => {
    try {
        const AIKey = require("../models/AIKey");
        const { SUPPORTED_MODELS, DEFAULT_MODEL, VILAO_MODELS, VILAO_DEFAULT_MODEL } = require("../config/aiModels");

        // ★ USER KEY: admin user_key KHÔNG được thấy/chọn AI key (README: menu API Key
        //   ẩn hoàn toàn) → không query AIKey, trả mảng rỗng + cờ để view ẩn dropdown.
        const scope = await getContentScope(req);
        const canPickAIKey = scope.isDefaultAdmin;

        const [subjects, prompts, aiKeys] = await Promise.all([
            Subject.find({ deletedAt: null, deletedForever: false, ...scope.filter }).sort({ name: 1 }).lean(),
            GradingPrompt.find({ active: { $ne: false } }).lean(), // ★ FIX: khớp điều kiện với resolvePrompt(), tránh prompt bị "ẩn" khỏi dropdown
            canPickAIKey
                ? AIKey.find({ isActive: true, isRevoked: { $ne: true } }).sort({ createdAt: -1 }).lean()
                : Promise.resolve([]),
        ]);

        res.render("admin/lesson-form", {
            title: "Thêm Bài học",
            user: req.user,
            lesson: null,
            content: null,
            subjects,
            prompts,
            aiKeys: withAiLabels(aiKeys),
            canPickAIKey,
            supportedModels: SUPPORTED_MODELS,
            defaultModel: DEFAULT_MODEL,
            vilaoModels: VILAO_MODELS || [],            // ★ vilao.ai
            vilaoDefaultModel: VILAO_DEFAULT_MODEL || "", // ★ vilao.ai
            isAdminView: true,
        });
    } catch (err) {
        next(err);
    }
};

/* ============================================================
 * 7. CREATE LESSON  ✅ contentHtml: ghi GitHub trước, Mongo sau
 * ============================================================ */
exports.createLesson = async (req, res, next) => {
    try {
        const {
            subjectId, title, description,
            contentHtml, sampleSolution, promptId, githubFile,
            duration, aiKeyId, model,
        } = req.body;

        if (!subjectId || !title || !title.trim()) {
            return res.status(400).json({ error: "Thiếu subjectId hoặc title" });
        }

        // ★ USER KEY: chỉ được tạo bài trong môn thuộc phạm vi của mình
        const scope = await getContentScope(req);
        const subject = await Subject.findById(subjectId).lean();
        if (!subject || !scope.canAccess(subject)) {
            return res.status(404).json({ error: "Môn học không tồn tại" });
        }

        let slug = slugify(title);

        // ★ FIX: trước đây so trùng bằng `Lesson.findOne({ subjectId, slug })` không
        //   lọc isDeleted, nên một bài ĐÃ XOÁ MỀM (đang trong thùng rác) vẫn khiến
        //   API báo 409 "đã tồn tại" dù danh sách active không còn nó.
        //   → chỉ chặn tạo mới khi có bài ĐANG HOẠT ĐỘNG trùng slug trong cùng môn.
        //   (Bài đã bị XOÁ CỨNG thì document không còn trong DB nên không thể va chạm.)
        const existedActive = await Lesson.findOne({
            subjectId,
            slug,
            isDeleted: false,
        });
        if (existedActive) {
            return res.status(409).json({ error: `Bài "${title}" đã tồn tại trong môn này` });
        }

        // Nếu slug đang bị giữ bởi một bài trong thùng rác (isDeleted: true),
        // không tái sử dụng slug đó để tránh 2 document cùng slug gây tra cứu mập mờ
        // (findLessonByParamAny tìm theo slug, không lọc isDeleted).
        const slugHeldByTrashed = await Lesson.findOne({ subjectId, slug });
        if (slugHeldByTrashed) {
            slug = `${slug}-${Date.now().toString(36)}`;
        }

        // ★ contentHtml CHỈ lưu ở GitHub → ghi GitHub TRƯỚC, thành công mới ghi MongoDB.
        //   GitHub lỗi → KHÔNG tạo bài (không có bản nháp contentHtml trong Mongo).
        const lessonId = new mongoose.Types.ObjectId();
        const trimmedTitle = title.trim();
        const resolvedGithubFile =
            (scope.isDefaultAdmin && githubFile) ||
            // ★ Thêm timestamp (giây unix) ở đuôi để giảm tỉ lệ trùng tên file: <slug>_<unix>.json
            `subjects/${subject.slug}/lessons/${slug}_${Math.floor(Date.now() / 1000)}.json`;
        const now = new Date();

        const safePromptId = promptId && mongoose.Types.ObjectId.isValid(promptId) ? promptId : null;
        // ★ USER KEY: chỉ admin default được gán AI key cho bài
        const safeAiKeyId = scope.isDefaultAdmin && aiKeyId && mongoose.Types.ObjectId.isValid(aiKeyId) ? aiKeyId : null;

        let saved = null;
        try {
            // ★ File JSON chứa ĐỦ thông tin để dựng lại bài học chỉ từ GitHub
            saved = await lessonContentService.saveLessonContent(
                resolvedGithubFile,
                {
                    lessonId: String(lessonId),
                    type: "essay",
                    title: trimmedTitle,
                    slug,
                    subjectSlug: subject.slug,
                    description: description || "",
                    contentHtml: contentHtml || "",
                    sampleSolution: sampleSolution || "",
                    duration: Number(duration) || 20,
                    model: model ? String(model).trim() : null,
                    promptId: safePromptId ? String(safePromptId) : null,
                    aiKeyId: safeAiKeyId ? String(safeAiKeyId) : null,
                    isPublished: true,
                    isDeleted: false,
                    createdBy: actorMeta(req),
                    createdAt: now,
                    updatedAt: now,
                },
                `[Lesson] Create: ${trimmedTitle}`
            );
        } catch (e) {
            console.error("[lesson] Ghi GitHub lỗi, KHÔNG tạo bài:", e.message);
            return res.status(502).json({
                error: `Không lưu được đề bài lên GitHub nên bài chưa được tạo. Vui lòng thử lại. (${e.message})`,
            });
        }

        const lesson = await Lesson.create({
            _id: lessonId,
            subjectId,
            title: trimmedTitle,
            slug,
            description: description || "",
            // ⛔ KHÔNG lưu contentHtml vào MongoDB
            sampleSolution: sampleSolution || "",
            promptId: safePromptId,
            // ★ USER KEY: userKey kế thừa từ MÔN, không nhận từ body
            userKey: subject.userKey || null,
            githubFile: resolvedGithubFile,
            githubSha: (saved && saved.sha) || null,
            duration: Number(duration) || 20,
            aiKeyId: safeAiKeyId,
            model: model ? String(model).trim() : null,
            createdBy: currentUserId(req),
            updatedBy: currentUserId(req),
            isDeleted: false,
            deletedAt: null,
        });

        if (req.accepts("html") && !req.xhr) {
            req.flash?.("success", `Đã tạo bài "${lesson.title}"`);
            return res.redirect("/admin/lessons");
        }
        return res.status(201).json({ ok: true, lesson });
    } catch (err) {
        next(err);
    }
};

/* ============================================================
 * 8. SHOW EDIT FORM
 * ============================================================ */
exports.showEditLesson = async (req, res, next) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).render("error", {
                title: "Lỗi", message: "ID không hợp lệ", user: req.user,
                statusCode: 400, stack: null,
            });
        }

        const AIKey = require("../models/AIKey");
        const { SUPPORTED_MODELS, DEFAULT_MODEL, VILAO_MODELS, VILAO_DEFAULT_MODEL } = require("../config/aiModels");

        // ★ USER KEY (xem showCreateLesson)
        const scope = await getContentScope(req);
        const canPickAIKey = scope.isDefaultAdmin;

        const [lesson, subjects, prompts, aiKeys] = await Promise.all([
            Lesson.findById(id).lean(),
            Subject.find({ deletedAt: null, deletedForever: false, ...scope.filter }).sort({ name: 1 }).lean(),
            GradingPrompt.find({ active: { $ne: false } }).lean(), // ★ FIX: khớp điều kiện với resolvePrompt(), tránh prompt bị "ẩn" khỏi dropdown
            canPickAIKey
                ? AIKey.find({ isActive: true, isRevoked: { $ne: true } }).sort({ createdAt: -1 }).lean()
                : Promise.resolve([]),
        ]);

        if (!lesson || !scope.canAccess(lesson)) { // ★ USER KEY
            return res.status(404).render("error", {
                title: "Không tìm thấy", message: "Bài học không tồn tại",
                user: req.user, statusCode: 404, stack: null,
            });
        }

        // ★ TRẮC NGHIỆM: form sửa tự luận KHÔNG hiểu JSON đề quiz → chuyển sang form riêng
        if ((lesson.type || "essay") === "quiz") {
            return res.redirect(`/admin/quiz/${lesson._id}/edit`);
        }

        // ★ contentHtml CHỈ đọc từ GitHub. Không đọc được → KHÔNG mở form
        //   (nếu mở với ô trống rồi lưu sẽ ghi đè mất đề bài trên GitHub)
        let content = null;
        try {
            const subjectDoc = await Subject.findById(lesson.subjectId).select("slug").lean();
            // ★ FIX Vercel: form sửa LUÔN đọc tươi từ GitHub (bỏ qua cache RAM theo instance)
            content = await lessonContentService.getLessonContent(lesson, subjectDoc?.slug, { fresh: true });
        } catch (err) {
            console.warn("[lesson] Không đọc được đề bài từ GitHub để sửa:", err.message);
            return res.status(503).render("error", {
                title: "Chưa mở được form sửa",
                message: "Không tải được đề bài từ GitHub. Vui lòng thử lại sau.",
                user: req.user, statusCode: 503, stack: null,
            });
        }

        res.render("admin/lesson-form", {
            title: "Sửa Bài học",
            user: req.user,
            lesson,
            content,
            subjects,
            prompts,
            aiKeys: withAiLabels(aiKeys),
            canPickAIKey,
            supportedModels: SUPPORTED_MODELS,
            defaultModel: DEFAULT_MODEL,
            vilaoModels: VILAO_MODELS || [],            // ★ vilao.ai
            vilaoDefaultModel: VILAO_DEFAULT_MODEL || "", // ★ vilao.ai
            isAdminView: true,
        });
    } catch (err) {
        next(err);
    }
};

/* ============================================================
 * 9. UPDATE LESSON  ✅ contentHtml: ghi GitHub trước, Mongo sau
 * ============================================================ */
exports.updateLesson = async (req, res, next) => {
    try {
        const { id } = req.params;
        const {
            subjectId, title, description,
            contentHtml, sampleSolution, promptId, githubFile,
            duration, aiKeyId, model,
        } = req.body;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ error: "ID không hợp lệ" });
        }

        const lesson = await Lesson.findById(id);
        const scope = await getContentScope(req); // ★ USER KEY
        if (!lesson || !scope.canAccess(lesson)) {
            return res.status(404).json({ error: "Bài học không tồn tại" });
        }

        // ★ TRẮC NGHIỆM: không cho cập nhật bằng API tự luận (sẽ ghi đè/hỏng JSON đề quiz trên GitHub)
        if ((lesson.type || "essay") === "quiz") {
            return res.status(400).json({ error: "Bài trắc nghiệm được sửa ở trang riêng: /admin/quiz/" + lesson._id + "/edit" });
        }

        let movedToSubject = null;
        if (title && title.trim() && title.trim() !== lesson.title) {
            lesson.title = title.trim();
            lesson.slug = slugify(title.trim());
        }
        // ★ USER KEY: đổi môn → môn mới cũng phải trong phạm vi, và bài đổi
        //   userKey theo môn mới (không cho chuyển bài sang tổ chức khác lén lút)
        if (
            subjectId &&
            mongoose.Types.ObjectId.isValid(subjectId) &&
            String(subjectId) !== String(lesson.subjectId)
        ) {
            const newSubject = await Subject.findById(subjectId).lean();
            if (!newSubject || !scope.canAccess(newSubject)) {
                return res.status(404).json({ error: "Môn học không tồn tại" });
            }
            lesson.subjectId = subjectId;
            lesson.userKey = newSubject.userKey || null;
            movedToSubject = newSubject;
        }
        if (typeof description === "string") lesson.description = description;
        if (typeof sampleSolution === "string") lesson.sampleSolution = sampleSolution;
        // ★ USER KEY: chỉ admin default được đổi đường dẫn GitHub
        if (scope.isDefaultAdmin && typeof githubFile === "string" && githubFile) lesson.githubFile = githubFile;
        if (promptId !== undefined) {
            lesson.promptId = promptId && mongoose.Types.ObjectId.isValid(promptId) ? promptId : null;
        }
        if (duration !== undefined) lesson.duration = Number(duration) || 20;

        // ★ AI KEY + MODEL
        if (aiKeyId !== undefined && scope.isDefaultAdmin) { // ★ USER KEY
            lesson.aiKeyId = aiKeyId && mongoose.Types.ObjectId.isValid(aiKeyId) ? aiKeyId : null;
        }
        if (model !== undefined) {
            lesson.model = model ? String(model).trim() : null;
        }

        // ★ FALLBACK: nếu bài cũ không có githubFile → tự tạo từ subject.slug + lesson.slug
        if (!lesson.githubFile) {
            const subjectDoc = await Subject.findById(lesson.subjectId).lean();
            if (subjectDoc && subjectDoc.slug) {
                const subjectSlug = subjectDoc.slug;
                const lessonSlug = lesson.slug || String(lesson._id);
                lesson.githubFile = `subjects/${subjectSlug}/lessons/${lessonSlug}.json`;
                console.log(`📁 [lesson] Fallback githubFile: ${lesson.githubFile}`);
            }
        }

        lesson.updatedBy = currentUserId(req);  // ★ FIX: lấy từ session an toàn

        // ★ contentHtml CHỈ lưu ở GitHub → ghi GitHub TRƯỚC, thành công mới lưu MongoDB.
        //   GitHub lỗi → KHÔNG lưu gì (lesson chưa .save()).
        if (lesson.githubFile) {
            const subjectForFile = movedToSubject
                || await Subject.findById(lesson.subjectId).select("slug").lean();

            // ★ Đổi môn → file phải nằm trong thư mục của môn mới, nếu không lần đồng bộ
            //   kế tiếp sẽ suy ra môn từ đường dẫn và trả bài về môn cũ.
            const oldFile = lesson.githubFile;
            let newFile = oldFile;
            if (movedToSubject && movedToSubject.slug && STD_LESSON_RE.test(oldFile)) {
                newFile = `subjects/${movedToSubject.slug}/lessons/${oldFile.split("/").pop()}`;
            }

            const patch = {
                lessonId: String(lesson._id),
                type: "essay",
                title: lesson.title,
                slug: lesson.slug,
                subjectSlug: subjectForFile?.slug || null,
                description: lesson.description || "",
                sampleSolution: lesson.sampleSolution || "",
                duration: lesson.duration || 20,
                model: lesson.model || null,
                promptId: lesson.promptId ? String(lesson.promptId) : null,
                aiKeyId: lesson.aiKeyId ? String(lesson.aiKeyId) : null,
                isPublished: lesson.isPublished !== false,
                isDeleted: lesson.isDeleted === true,
                updatedAt: new Date(),
            };
            const creator = await userMeta(lesson.createdBy);
            if (creator) patch.createdBy = creator;
            if (typeof contentHtml === "string") patch.contentHtml = contentHtml;

            try {
                const saved = newFile !== oldFile
                    ? await lessonContentService.moveLessonFile(oldFile, newFile, patch, `[Lesson] Update: ${lesson.title}`)
                    : await lessonContentService.saveLessonContent(oldFile, patch, `[Lesson] Update: ${lesson.title}`);
                lesson.githubFile = newFile;
                lesson.githubSha = (saved && saved.sha) || lesson.githubSha || null;
            } catch (e) {
                console.error("[lesson] Ghi GitHub lỗi, KHÔNG lưu cập nhật:", e.message);
                return res.status(502).json({
                    error: `Không lưu được đề bài lên GitHub nên chưa cập nhật. Vui lòng thử lại. (${e.message})`,
                });
            }
        } else if (typeof contentHtml === "string" && contentHtml.trim()) {
            return res.status(400).json({ error: "Bài học chưa có githubFile nên không lưu được nội dung đề bài." });
        }

        await lesson.save();

        if (req.accepts("html") && !req.xhr) {
            req.flash?.("success", "Đã cập nhật bài học");
            return res.redirect("/admin/lessons");
        }
        return res.json({ ok: true, lesson });
    } catch (err) {
        next(err);
    }
};

/* ============================================================
 * 10-12. DELETE (mềm) / RESTORE / HARD DELETE (vĩnh viễn)
 * ★ THEO YÊU CẦU: `isDeleted` = xoá mềm (vào thùng rác, khôi phục được).
 *   Xoá vĩnh viễn = xoá thật document khỏi MongoDB (`Lesson.deleteOne`),
 *   không giữ lại gì cả.
 *
 *   ⚠️ Lưu ý đánh đổi: Submission.lessonId, GradingPrompt.lessonId,
 *   Submission.promptSnapshot... có thể đang tham chiếu tới lesson này.
 *   Sau khi xoá cứng, các bản ghi đó sẽ trỏ tới một _id không còn tồn
 *   tại (populate ra null) — lịch sử điểm/bài nộp cũ sẽ mất tên bài học
 *   gốc. Đây là lựa chọn có chủ đích theo yêu cầu, không phải bug.
 * ============================================================ */
exports.deleteLesson = async (req, res, next) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "ID không hợp lệ" });

        const lesson = await Lesson.findById(id);
        const scope = await getContentScope(req); // ★ USER KEY
        if (!lesson || !scope.canAccess(lesson)) return res.status(404).json({ error: "Không tìm thấy" });

        // ★ GitHub là nguồn sự thật: đánh dấu xoá mềm ngay trong file JSON TRƯỚC,
        //   rồi mới ghi MongoDB (nếu không, lần đồng bộ sau sẽ khôi phục lại bài).
        const deletedAt = new Date();
        if (lesson.githubFile) {
            try {
                const saved = await lessonContentService.patchLessonFile(
                    lesson.githubFile,
                    { isDeleted: true, deletedAt, updatedAt: deletedAt },
                    `[Lesson] Trash: ${lesson.title}`
                );
                lesson.githubSha = (saved && saved.sha) || lesson.githubSha;
            } catch (e) {
                console.error("[lesson] Ghi GitHub lỗi khi xoá mềm:", e.message);
                return res.status(502).json({ error: `Không cập nhật được GitHub nên chưa xoá. (${e.message})` });
            }
        }

        lesson.isDeleted = true;
        lesson.deletedAt = deletedAt;
        lesson.updatedBy = currentUserId(req);   // ★ FIX
        lesson.deletedBy = currentUserId(req);   // ★ THÊM: ghi ai đã xoá (schema đã có field)
        await lesson.save();

        if (req.accepts("html") && !req.xhr) {
            req.flash?.("success", "Đã chuyển bài vào thùng rác");
            return res.redirect("/admin/lessons");
        }
        return res.json({ ok: true });
    } catch (err) { next(err); }
};

exports.restoreLesson = async (req, res, next) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "ID không hợp lệ" });

        const lesson = await Lesson.findById(id);
        const scope = await getContentScope(req); // ★ USER KEY
        if (!lesson || !scope.canAccess(lesson)) return res.status(404).json({ error: "Không tìm thấy" });

        if (lesson.githubFile) {
            try {
                const saved = await lessonContentService.patchLessonFile(
                    lesson.githubFile,
                    { isDeleted: false, deletedAt: null, updatedAt: new Date() },
                    `[Lesson] Restore: ${lesson.title}`
                );
                lesson.githubSha = (saved && saved.sha) || lesson.githubSha;
            } catch (e) {
                console.error("[lesson] Ghi GitHub lỗi khi khôi phục:", e.message);
                return res.status(502).json({ error: `Không cập nhật được GitHub nên chưa khôi phục. (${e.message})` });
            }
        }

        lesson.isDeleted = false;
        lesson.deletedAt = null;
        lesson.deletedBy = null;                 // ★ THÊM: clear ai đã xoá (schema đã có field)
        lesson.updatedBy = currentUserId(req);   // ★ FIX
        await lesson.save();

        if (req.accepts("html") && !req.xhr) {
            req.flash?.("success", "Đã khôi phục bài học");
            return res.redirect("/admin/lessons");
        }
        return res.json({ ok: true });
    } catch (err) { next(err); }
};

exports.hardDeleteLesson = async (req, res, next) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "ID không hợp lệ" });

        const lesson = await Lesson.findById(id);
        const scope = await getContentScope(req); // ★ USER KEY
        if (!lesson || !scope.canAccess(lesson)) return res.status(404).json({ error: "Không tìm thấy" });

        // Chỉ cho xoá vĩnh viễn bài ĐANG ở thùng rác (đã xoá mềm trước) —
        // buộc đi qua bước xác nhận "vào thùng rác" trước khi xoá thật.
        if (!lesson.isDeleted) {
            const msg = "Chỉ có thể xoá vĩnh viễn bài học đang ở trong thùng rác";
            if (req.accepts("html") && !req.xhr) {
                req.flash?.("error", msg);
                return res.redirect("/admin/lessons");
            }
            return res.status(400).json({ error: msg });
        }

        // ★ Xoá file JSON trên GitHub TRƯỚC (nguồn sự thật), rồi mới xoá khỏi MongoDB.
        //   Chỉ xoá file đúng quy ước subjects/{môn}/lessons/{file}.json.
        if (lesson.githubFile && STD_LESSON_RE.test(lesson.githubFile) && githubService.isConfigured) {
            try {
                await githubService.deleteFile(lesson.githubFile, `[Lesson] Hard delete: ${lesson.title}`);
                lessonContentService.clearCache(lesson.githubFile);
            } catch (e) {
                console.error("[lesson] Xoá file GitHub lỗi:", e.message);
                const msg = `Không xoá được file trên GitHub nên chưa xoá bài. (${e.message})`;
                if (req.accepts("html") && !req.xhr) {
                    req.flash?.("error", msg);
                    return res.redirect("/admin/lessons?deleted=1");
                }
                return res.status(502).json({ error: msg });
            }
        }

        // ★ Xoá thật khỏi database
        await Lesson.deleteOne({ _id: lesson._id });

        if (req.accepts("html") && !req.xhr) {
            req.flash?.("success", "Đã xoá vĩnh viễn bài học");
            return res.redirect("/admin/lessons?deleted=1");
        }
        return res.json({ ok: true });
    } catch (err) { next(err); }
};exports._toStudentView = toStudentView;
