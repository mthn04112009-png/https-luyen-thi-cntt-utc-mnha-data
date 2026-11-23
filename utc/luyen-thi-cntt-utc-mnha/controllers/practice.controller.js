// controllers/practice.controller.js
const Subject = require('../models/Subject');
const Lesson = require('../models/Lesson');
const Submission = require('../models/Submission');

const { paginate } = require('./pagination.controller');
// ★ USER KEY
const { getContentScope } = require('../services/userKeyService');
const githubSync = require('../services/githubSyncService');
const audience = require('../services/audienceService');   // "Chỉ hiển thị với"
// ★ Tìm kiếm (không phân biệt hoa/thường + dấu tiếng Việt)
const { getSearchTerm, buildSearchClause, withSearch } = require('../utils/search');

// ============================================================
// LIST PRACTICE — cả admin + student đều vào
// GET /practice
//
// Phạm vi nội dung (getContentScope, đọc user MỚI từ DB):
//   - Admin default  : thấy tất cả
//   - Admin user_key : chỉ môn/bài của tổ chức mình do chính mình tạo
//   - Student        : userKey ∈ [tổ chức gốc, ...đã kết nối] (đang active);
//                      student default (userKey null) chỉ thấy nội dung userKey null
//                      (= do admin default tạo)
// ============================================================
exports.listPractice = async (req, res, next) => {
    try {
        const user = req.user;
        const isAdmin = user?.role === 'admin';
        const subjectFilter = String(req.query.subject || '').trim() || null;
        const q = getSearchTerm(req); // ★ ô tìm kiếm ?q=

        const scope = await getContentScope(req);
        await githubSync.syncKinds(['lessons']);   // ★ bài học lấy từ GitHub

        // --- Môn học hiển thị được ---
        const subjectQuery = {
            deletedAt: null,
            deletedForever: { $ne: true },
            ...scope.filter // ★ USER KEY
        };
        if (!isAdmin) subjectQuery.isPublished = true;

        const subjects = await Subject.find(subjectQuery)
            .sort({ order: 1, name: 1 })
            .lean();

        // --- Bài học: PHẢI thuộc một môn đã qua bộ lọc phạm vi ở trên ---
        // (trước đây lọc thẳng theo query ?subject=<id> do client gửi → đổi id là xem được
        //  bài của tổ chức khác)
        let allowedSubjectIds = subjects.map((s) => s._id);
        if (subjectFilter) {
            const match = subjects.find(
                (s) => String(s._id) === subjectFilter || s.slug === subjectFilter
            );
            allowedSubjectIds = match ? [match._id] : []; // môn ngoài phạm vi → không có bài nào
        }

        const lessonQuery = {
            isDeleted: false, // cờ xoá mềm thật sự của Lesson (xem models/Lesson.js)
            subjectId: { $in: allowedSubjectIds },
            ...scope.filter // ★ USER KEY: phòng thủ thêm ở cấp bài học
        };
        if (!isAdmin) lessonQuery.isPublished = true;

        // Danh sách bài chia trang 9 bài/trang
        // ★ Tìm theo tên / mô tả bài (gộp $and để không đè bộ lọc userKey)
        const searchClause = buildSearchClause(q, ['title', 'description']);

        const { items: lessons, pagination } = await paginate(Lesson, withSearch(audience.withAudience(lessonQuery, user), searchClause), req, {
            limit: 9,
            // ★ Mới nhất → cũ nhất. Bài học lưu ở GitHub nên createdAt có thể trùng/bị đặt lại
            //   khi đồng bộ (cold start Vercel) → dùng _id (ObjectId mang mốc thời gian tạo,
            //   luôn duy nhất, ổn định) để thứ tự không bị xáo trộn.
            sort: { _id: -1 }
        });

        // Gắn subject cho từng lesson
        const subjectMap = Object.fromEntries(
            subjects.map((s) => [String(s._id), s])
        );

        const lessonsWithSubject = lessons.map((l) => ({
            ...l,
            subject: subjectMap[String(l.subjectId || l.subject)] || null
        }));

        // Lịch sử nộp bài của user (kể cả admin)
        const submittedMap = {};
        if (user) {
            const subs = await Submission.find({
                userId: user._id,
                lessonId: { $in: lessons.map((l) => l._id) }
            })
                .sort({ submittedAt: -1 })
                .lean();

            subs.forEach((s) => {
                const key = String(s.lessonId);
                if (!submittedMap[key]) {
                    submittedMap[key] = {
                        score: s.score,
                        maxScore: (s.promptSnapshot && s.promptSnapshot.maxScore) || 10,
                        submittedAt: s.submittedAt,
                        submissionId: s._id
                    };
                }
            });
        }

        return res.render('practice', {
            title: 'Luyện tập',
            user,
            subjects,
            lessons: lessonsWithSubject,
            submittedMap,
            filters: { subject: subjectFilter || '', q },
            ...pagination
        });
    } catch (error) {
        console.error('listPractice error:', error);
        return res.status(500).render('error', {
            title: 'Lỗi',
            message: 'Không thể tải trang luyện tập.',
            statusCode: 500,
            stack: null
        });
    }
};
