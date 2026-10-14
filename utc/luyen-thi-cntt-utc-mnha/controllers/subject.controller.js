// controllers/subject.controller.js
const mongoose = require('mongoose');
const Subject = require('../models/Subject');
const Lesson = require('../models/Lesson');
const { paginate, paginateArray } = require('./pagination.controller');
const { sortNewestFirst } = require('../utils/lessonOrder');
// ★ USER KEY: toàn bộ phạm vi xem/sửa môn học lấy từ đây
const { getContentScope } = require('../services/userKeyService');
// ★ GitHub là nguồn sự thật của bài học: đồng bộ trước khi đếm / liệt kê
const githubSync = require('../services/githubSyncService');
// ★ Tìm kiếm (không phân biệt hoa/thường + dấu tiếng Việt)
const { getSearchTerm, buildSearchClause, withSearch } = require('../utils/search');

// ============================================================
// HELPERS
// ============================================================
function slugify(str) {
    return String(str || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 100);
}

// Slug phải duy nhất TOÀN HỆ THỐNG (vì URL /subjects/:slug không có tiền tố tổ chức)
async function generateUniqueSlug(name, excludeId = null) {
    let base = slugify(name) || 'mon-hoc';
    let slug = base;
    let i = 0;

    while (true) {
        const query = { slug };
        if (excludeId) query._id = { $ne: excludeId };

        const found = await Subject.findOne(query).lean();
        if (!found) return slug;

        i++;
        slug = `${base}-${i}`;
        if (i > 1000) return `${base}-${Date.now().toString(36)}`;
    }
}

function getUserId(req) {
    return req.session?.user?._id || req.user?._id || null;
}

function isObjectId(str) {
    return mongoose.Types.ObjectId.isValid(str) && String(str).length === 24;
}

// Lấy subject theo id/slug KHÔNG lọc trạng thái — để phân biệt 404 thật
// với "đã bị xoá mềm". Việc kiểm tra phạm vi tổ chức làm ở caller (scope.canAccess).
function findSubjectByParamAny(param) {
    const baseFilter = isObjectId(param) ? { _id: param } : { slug: param };
    return Subject.findOne(baseFilter)
        .populate('createdBy', 'name')
        .populate('updatedBy', 'name')   // ★ hiển thị "Cập nhật bởi" ở header môn
        .lean();
}

function readFlash(req, key) {
    if (typeof req.flash !== 'function') return null;
    const arr = req.flash(key);
    return Array.isArray(arr) && arr.length ? arr[0] : null;
}

// Đếm bài học (1 query cho cả trang thay vì N query)
async function attachLessonCounts(subjects) {
    const ids = subjects.map((s) => s._id);
    if (!ids.length) return subjects;

    const rows = await Lesson.aggregate([
        { $match: { subjectId: { $in: ids }, isDeleted: false } },
        { $group: { _id: '$subjectId', count: { $sum: 1 } } },
    ]);
    const map = Object.fromEntries(rows.map((r) => [String(r._id), r.count]));

    subjects.forEach((s) => {
        s.lessonCount = map[String(s._id)] || 0;
    });
    return subjects;
}

// ★ USER KEY: mọi truy cập vượt phạm vi → 404 (giống "không tồn tại"),
//   không lộ việc môn đó có thật ở tổ chức khác.
function renderNotFound(req, res, message = 'Không tìm thấy môn học.') {
    return res.status(404).render('error', {
        title: 'Không tìm thấy',
        message,
        user: req.user,
        statusCode: 404,
        stack: null,
    });
}

// ★ USER KEY: handler admin chỉ chạy khi actor (đọc từ DB) thật sự là admin.
//   Trả scope, hoặc null (đã redirect) nếu không đủ quyền.
async function requireAdminScope(req, res, backUrl = '/admin/subjects') {
    const scope = await getContentScope(req);
    if (scope.isDefaultAdmin || scope.isOrgAdmin) return scope;

    res.redirect(
        backUrl + '?error=' + encodeURIComponent('Bạn không có quyền thực hiện thao tác này.')
    );
    return null;
}

// Tải 1 môn (chưa bị xoá vĩnh viễn) mà actor ĐƯỢC PHÉP quản lý, hoặc null
async function findManageableSubject(scope, id) {
    if (!isObjectId(id)) return null;
    const subject = await Subject.findOne({
        _id: id,
        deletedForever: { $ne: true },
    });
    if (!subject || !scope.canAccess(subject)) return null;
    return subject;
}

const NOT_FOUND_MSG = 'Không tìm thấy môn học.';

// ============================================================
// STUDENT (và admin xem giao diện sinh viên)
// ============================================================

// GET /subjects
exports.getSubjects = async (req, res, next) => {
    try {
        await githubSync.syncKinds(['lessons']);

        // ★ USER KEY: admin default → {} ; admin user_key → userKey+createdBy của mình ;
        //   student → userKey ∈ [null (nếu default), tổ chức gốc, tổ chức đã kết nối]
        const scope = await getContentScope(req);

        // ★ Ô tìm kiếm: ?q= theo tên / mã / mô tả môn
        const q = getSearchTerm(req);
        const searchClause = buildSearchClause(q, ['name', 'code', 'description']);

        const { items: subjects, pagination } = await paginate(
            Subject,
            withSearch(
                {
                    isPublished: true,
                    deletedAt: null,
                    deletedForever: { $ne: true },
                    ...scope.filter,
                },
                searchClause
            ),
            req,
            {
                limit: 9,
                // ★ Mới nhất → cũ nhất; _id làm tiêu chí phụ để các môn tạo cùng lúc không bị xáo
                sort: { createdAt: -1, _id: -1 },
                populate: { path: 'createdBy', select: 'name' },
            }
        );

        await attachLessonCounts(subjects);

        return res.render('student/subjects', {
            title: 'Môn học',
            user: req.user,
            subjects,
            filters: { q },
            ...pagination,
        });
    } catch (error) {
        console.error('getSubjects error:', error);
        return res.status(500).render('error', {
            title: 'Lỗi',
            message: 'Không thể tải danh sách môn học.',
            statusCode: 500,
            stack: null,
        });
    }
};

// GET /subjects/:id  (id hoặc slug)
exports.getSubject = async (req, res, next) => {
    try {
        const key = req.params.id || req.params.slug;
        const subjectAny = await findSubjectByParamAny(key);

        if (!subjectAny || subjectAny.deletedForever) {
            return renderNotFound(req, res);
        }

        // ★ USER KEY: ngoài phạm vi → 404 NGAY, trước cả nhánh "đã xoá/không công khai"
        //   (nếu để sau thì người ngoài tổ chức vẫn biết môn đó tồn tại qua mã 410)
        const scope = await getContentScope(req);
        if (!scope.canAccess(subjectAny)) {
            return renderNotFound(req, res);
        }

        if (subjectAny.deletedAt || !subjectAny.isPublished) {
            return res.status(410).render('error', {
                title: 'Môn học không khả dụng',
                message: 'Môn học này hiện không được công khai hoặc đã bị xoá.',
                user: req.user,
                statusCode: 410,
                stack: null,
            });
        }

        const subject = subjectAny;

        await githubSync.syncKinds(['lessons']);

        // ★ Ô tìm kiếm: ?q= theo tên / mô tả bài học
        const q = getSearchTerm(req);
        const searchClause = buildSearchClause(q, ['title', 'description']);

        // ★ Đề MỚI nhất lên đầu, không phân biệt trắc nghiệm / tự luận (xem utils/lessonOrder.js)
        const allLessons = await Lesson.find(
            withSearch(
                {
                    subjectId: subject._id,
                    isDeleted: false,
                    ...scope.filter, // ★ USER KEY: phòng thủ thêm ở cấp bài học
                },
                searchClause
            )
        ).populate([
            { path: 'createdBy', select: 'name' },
            { path: 'updatedBy', select: 'name' }, // ★ Cập nhật bởi
        ]).lean();
        const { items: lessons, pagination } = paginateArray(sortNewestFirst(allLessons), req, { limit: 10 });

        return res.render('student/subject', {
            title: subject.name,
            user: req.user,
            subject,
            lessons,
            filters: { q },
            ...pagination,
        });
    } catch (error) {
        console.error('getSubject error:', error);
        return res.status(500).render('error', {
            title: 'Lỗi',
            message: 'Không thể tải môn học.',
            statusCode: 500,
            stack: null,
        });
    }
};

// ============================================================
// ADMIN — LIST
// GET /admin/subjects
// ============================================================
exports.getAdminSubjects = async (req, res, next) => {
    try {
        const scope = await requireAdminScope(req, res, '/');
        if (!scope) return;
        await githubSync.syncKinds(['lessons']);

        const showDeleted = req.query.deleted === '1';
        const search = (req.query.search || '').trim();

        // ★ USER KEY: admin user_key chỉ thấy môn do chính mình tạo trong tổ chức mình
        const filter = { deletedForever: { $ne: true }, ...scope.filter };
        filter.deletedAt = showDeleted ? { $ne: null } : null;

        if (search) {
            const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            filter.$or = [
                { name: { $regex: safe, $options: 'i' } },
                { code: { $regex: safe, $options: 'i' } },
            ];
        }

        const { items: subjects, pagination } = await paginate(Subject, filter, req, {
            limit: 9,
            sort: { order: 1, createdAt: -1 },
            populate: [
                { path: 'createdBy', select: 'name email' },
                { path: 'updatedBy', select: 'name email' },
            ],
        });

        await attachLessonCounts(subjects);

        return res.render('admin/subjects', {
            title: 'Quản lý môn học',
            user: req.user,
            subjects,
            ...pagination,
            showDeleted,
            filters: { search },
            success: req.query.success || readFlash(req, 'success'),
            error: req.query.error || readFlash(req, 'error'),
        });
    } catch (error) {
        console.error('getAdminSubjects error:', error);
        return res.status(500).render('error', {
            title: 'Lỗi',
            message: 'Không thể tải danh sách môn học.',
            statusCode: 500,
            stack: null,
        });
    }
};

// ============================================================
// ADMIN — CREATE POST
// POST /admin/subjects
// ============================================================
exports.createSubject = async (req, res, next) => {
    try {
        const scope = await requireAdminScope(req, res);
        if (!scope) return;

        const { name, code, description, order, isPublished } = req.body;

        if (!name || !name.trim()) {
            return res.redirect(
                '/admin/subjects?error=' +
                    encodeURIComponent('Tên môn học không được để trống.')
            );
        }

        // ★ USER KEY: userKey do SERVER gán theo actor, KHÔNG nhận từ body.
        //   (Trước đây không gán → môn của admin user_key mặc định userKey=null
        //    → bị coi là nội dung của tổ chức default → mọi student default đều thấy.)
        const ownerKey = scope.actor.userKey || null;

        // ★ USER KEY: trùng tên chỉ tính trong CÙNG tổ chức (không lộ tên môn của tổ chức khác)
        const existed = await Subject.findOne({
            name: name.trim(),
            userKey: ownerKey,
            deletedForever: { $ne: true },
        });

        if (existed) {
            return res.redirect(
                '/admin/subjects?error=' +
                    encodeURIComponent('Tên môn học đã tồn tại.')
            );
        }

        const slug = await generateUniqueSlug(name);

        await Subject.create({
            name: name.trim(),
            code: (code || '').trim() || null,
            description: (description || '').trim(),
            slug,
            order: Number(order) || 0,
            isPublished: isPublished === 'on' || isPublished === true,
            userKey: ownerKey,                 // ★ USER KEY
            createdBy: scope.actor._id,        // ★ USER KEY (dùng cho phân quyền admin user_key)
            updatedBy: scope.actor._id,
        });

        req.flash?.('success', 'Đã tạo môn học thành công.');

        return res.redirect(
            '/admin/subjects?success=' +
                encodeURIComponent('Đã tạo môn học thành công.')
        );
    } catch (error) {
        console.error('createSubject error:', error);
        return res.redirect(
            '/admin/subjects?error=' +
                encodeURIComponent('Không thể tạo môn học: ' + error.message)
        );
    }
};

// ============================================================
// ADMIN — EDIT FORM
// GET /admin/subjects/:id/edit
// ============================================================
exports.showEditSubject = async (req, res, next) => {
    try {
        const scope = await requireAdminScope(req, res);
        if (!scope) return;

        const found = await findManageableSubject(scope, req.params.id);
        if (!found) {
            return res.redirect(
                '/admin/subjects?error=' + encodeURIComponent(NOT_FOUND_MSG)
            );
        }

        const subject = await Subject.findById(found._id)
            .populate('createdBy', 'name email')
            .populate('updatedBy', 'name email')
            .lean();

        return res.render('admin/subject-edit', {
            title: 'Chỉnh sửa môn học',
            user: req.user,
            subject,
            success: req.query.success || null,
            error: req.query.error || null,
        });
    } catch (error) {
        console.error('showEditSubject error:', error);
        return res.redirect(
            '/admin/subjects?error=' +
                encodeURIComponent('Không thể tải môn học.')
        );
    }
};

// ============================================================
// ADMIN — UPDATE
// POST /admin/subjects/:id/edit
// ============================================================
exports.updateSubject = async (req, res, next) => {
    try {
        const scope = await requireAdminScope(req, res);
        if (!scope) return;

        const { id } = req.params;
        // ★ USER KEY: cố ý KHÔNG đọc userKey / createdBy từ body
        const { name, code, description, order, isPublished } = req.body;

        const subject = await findManageableSubject(scope, id);
        if (!subject) {
            return res.redirect(
                '/admin/subjects?error=' + encodeURIComponent(NOT_FOUND_MSG)
            );
        }

        if (name && name.trim() !== subject.name) {
            const dup = await Subject.findOne({
                _id: { $ne: subject._id },
                name: name.trim(),
                userKey: subject.userKey || null, // ★ USER KEY: chỉ so trong cùng tổ chức
                deletedForever: { $ne: true },
            });

            if (dup) {
                return res.redirect(
                    `/admin/subjects/${id}/edit?error=` +
                        encodeURIComponent('Tên môn học đã tồn tại.')
                );
            }

            subject.name = name.trim();
            subject.slug = await generateUniqueSlug(name, subject._id);
        }

        if (code !== undefined) subject.code = (code || '').trim() || null;
        if (description !== undefined)
            subject.description = (description || '').trim();
        if (order !== undefined) subject.order = Number(order) || 0;
        if (isPublished !== undefined)
            subject.isPublished =
                isPublished === 'on' || isPublished === true;

        subject.updatedBy = getUserId(req);

        await subject.save();

        req.flash?.('success', 'Đã cập nhật môn học.');

        return res.redirect(
            `/admin/subjects/${id}/edit?success=` +
                encodeURIComponent('Đã cập nhật môn học.')
        );
    } catch (error) {
        console.error('updateSubject error:', error);
        return res.redirect(
            `/admin/subjects/${req.params.id}/edit?error=` +
                encodeURIComponent('Không thể cập nhật: ' + error.message)
        );
    }
};

// ============================================================
// ADMIN — DELETE (soft)
// POST /admin/subjects/:id/delete
// ============================================================
exports.deleteSubject = async (req, res, next) => {
    try {
        const scope = await requireAdminScope(req, res);
        if (!scope) return;

        const subject = await findManageableSubject(scope, req.params.id);
        if (!subject) {
            return res.redirect(
                '/admin/subjects?error=' + encodeURIComponent(NOT_FOUND_MSG)
            );
        }

        subject.deletedAt = new Date();
        subject.deletedBy = getUserId(req);
        subject.updatedBy = getUserId(req);
        await subject.save();

        req.flash?.('success', 'Đã xoá môn học (có thể khôi phục).');

        return res.redirect(
            '/admin/subjects?success=' +
                encodeURIComponent('Đã xoá môn học (có thể khôi phục).')
        );
    } catch (error) {
        console.error('deleteSubject error:', error);
        return res.redirect(
            '/admin/subjects?error=' +
                encodeURIComponent('Không thể xoá: ' + error.message)
        );
    }
};

// ============================================================
// ADMIN — RESTORE
// POST /admin/subjects/:id/restore
// ============================================================
exports.restoreSubject = async (req, res, next) => {
    try {
        const scope = await requireAdminScope(req, res);
        if (!scope) return;

        const subject = await findManageableSubject(scope, req.params.id);
        if (!subject) {
            return res.redirect(
                '/admin/subjects?error=' + encodeURIComponent(NOT_FOUND_MSG)
            );
        }

        subject.deletedAt = null;
        subject.deletedBy = null;
        subject.updatedBy = getUserId(req);
        await subject.save();

        req.flash?.('success', 'Đã khôi phục môn học.');

        return res.redirect(
            '/admin/subjects?deleted=1&success=' +
                encodeURIComponent('Đã khôi phục môn học.')
        );
    } catch (error) {
        console.error('restoreSubject error:', error);
        return res.redirect(
            '/admin/subjects?error=' +
                encodeURIComponent('Không thể khôi phục.')
        );
    }
};

// ============================================================
// ADMIN — HARD DELETE
// POST /admin/subjects/:id/hard-delete
// ============================================================
exports.hardDeleteSubject = async (req, res, next) => {
    try {
        const scope = await requireAdminScope(req, res);
        if (!scope) return;

        const subject = await findManageableSubject(scope, req.params.id);
        if (!subject) {
            return res.redirect(
                '/admin/subjects?error=' + encodeURIComponent(NOT_FOUND_MSG)
            );
        }

        // Chỉ cho xoá vĩnh viễn môn ĐANG ở thùng rác
        if (!subject.deletedAt) {
            return res.redirect(
                '/admin/subjects?error=' +
                    encodeURIComponent(
                        'Chỉ có thể xoá vĩnh viễn môn học đang ở trong thùng rác.'
                    )
            );
        }

        const lessonCount = await Lesson.countDocuments({
            subjectId: subject._id,
            isDeleted: false,
        });

        if (lessonCount > 0) {
            return res.redirect(
                '/admin/subjects?deleted=1&error=' +
                    encodeURIComponent(
                        `Không thể xoá vĩnh viễn: còn ${lessonCount} bài học.`
                    )
            );
        }

        subject.deletedForever = true;
        subject.updatedBy = getUserId(req);
        await subject.save();

        req.flash?.('success', 'Đã xoá vĩnh viễn môn học.');

        return res.redirect(
            '/admin/subjects?deleted=1&success=' +
                encodeURIComponent('Đã xoá vĩnh viễn môn học.')
        );
    } catch (error) {
        console.error('hardDeleteSubject error:', error);
        return res.redirect(
            '/admin/subjects?error=' +
                encodeURIComponent('Không thể xoá vĩnh viễn.')
        );
    }
};
