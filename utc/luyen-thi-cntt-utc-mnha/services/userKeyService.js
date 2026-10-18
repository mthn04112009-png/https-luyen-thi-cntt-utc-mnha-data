// services/userKeyService.js
// ============================================================
// Gom MỌI quy tắc phân quyền theo user_key vào một chỗ để các
// controller (lesson, subject, submission, admin user...) dùng
// chung, không mỗi nơi tự viết một kiểu.
//
// Định nghĩa:
//   - Admin default : role = 'admin' và userKey = null
//   - Admin user_key: role = 'admin' và userKey != null
//   - Student       : role != 'admin' (userKey null = tổ chức default)
//
// LUÔN đọc user mới từ DB (getActor) thay vì tin req.user /
// session, vì connectedUserKeys và role có thể đã đổi sau khi
// session được tạo.
// ============================================================
const mongoose = require('mongoose');

const User = require('../models/User');
const UserKey = require('../models/UserKey');

const toId = (v) => (v ? String(v._id || v) : null);

function httpError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

function normalizeUserKeyCode(input) {
    return String(input || '').trim().toUpperCase();
}

async function findActiveUserKeyByCode(code) {
    const c = normalizeUserKeyCode(code);
    if (!c) return null;
    return UserKey.findOne({ code: c, active: true }).lean();
}

async function getActor(req) {
    const id = req.user?._id || req.session?.user?._id;
    if (!id || !mongoose.Types.ObjectId.isValid(String(id))) return null;
    return User.findById(id)
        .select('role status userKey connectedUserKeys')
        .lean();
}

const isDefaultAdmin = (actor) =>
    !!actor && actor.role === 'admin' && !actor.userKey;

const isOrgAdmin = (actor) =>
    !!actor && actor.role === 'admin' && !!actor.userKey;

// ------------------------------------------------------------
// Nếu Subject/Lesson CHƯA có field userKey thì mọi document đều
// coi như thuộc tổ chức DEFAULT (không ném lỗi nữa). Khi đó KHÔNG
// được lọc theo userKey (Mongoose strictQuery sẽ lặng lẽ bỏ điều
// kiện đó), nên getContentScope trả scope "thuần default" bên dưới.
// ------------------------------------------------------------
let warnedMissingPath = false;

function missingUserKeyPath(...models) {
    const missing = models.filter((M) => !M.schema.path('userKey'));
    if (missing.length && !warnedMissingPath) {
        warnedMissingPath = true;
        console.warn(
            `[userKey] Model ${missing.map((m) => m.modelName).join(', ')} chưa có field "userKey" ` +
                `→ mọi nội dung được coi là tổ chức default. Thêm field vào schema để bật đa tổ chức.`
        );
    }
    return missing.length > 0;
}

/**
 * Phạm vi Subject/Lesson mà người đang đăng nhập được thấy/sửa.
 *
 * Trả về:
 *   filter    : Mongo filter, spread thẳng vào Subject.find / Lesson.find
 *   canAccess : (doc) => boolean, kiểm tra 1 document đã load
 *   isDefaultAdmin, isOrgAdmin, actor
 *
 * Quy tắc (theo README):
 *   - Admin default : thấy tất cả.
 *   - Admin user_key: chỉ userKey của mình VÀ createdBy = mình.
 *   - Student       : userKey ∈ [userKey gốc, ...connectedUserKeys] (chỉ tổ chức
 *                     đang active) VÀ createdBy là admin của đúng tổ chức đó.
 *                     Student default (userKey null) chỉ thấy nội dung userKey null
 *                     do ADMIN DEFAULT tạo.
 *   - Khách chưa đăng nhập: chỉ thấy nội dung tổ chức default.
 *
 * Lưu ý: `{ userKey: { $in: [null] } }` khớp cả document CHƯA CÓ
 * field userKey → dữ liệu cũ tự thuộc tổ chức default.
 */
async function getContentScope(req) {
    const Subject = require('../models/Subject');
    const Lesson = require('../models/Lesson');
    const actor = await getActor(req);

    // Chưa có field userKey → toàn bộ nội dung = default
    if (missingUserKeyPath(Subject, Lesson)) {
        const seesDefault = isDefaultAdmin(actor) || !actor || (actor.role !== 'admin' && !actor.userKey);
        return {
            actor,
            isDefaultAdmin: isDefaultAdmin(actor),
            isOrgAdmin: isOrgAdmin(actor),
            filter: seesDefault ? {} : { _id: null },
            canAccess: (doc) => !!doc && seesDefault
        };
    }

    if (isDefaultAdmin(actor)) {
        return {
            actor,
            isDefaultAdmin: true,
            isOrgAdmin: false,
            filter: {},
            canAccess: () => true
        };
    }

    if (isOrgAdmin(actor)) {
        const myKey = toId(actor.userKey);
        const me = toId(actor._id);
        return {
            actor,
            isDefaultAdmin: false,
            isOrgAdmin: true,
            filter: { userKey: actor.userKey, createdBy: actor._id },
            canAccess: (doc) =>
                !!doc && toId(doc.userKey) === myKey && toId(doc.createdBy) === me
        };
    }

    // Student (hoặc khách)
    const wanted = actor
        ? [actor.userKey, ...(actor.connectedUserKeys || [])]
              .filter(Boolean)
              .map(String)
        : [];

    const activeDocs = wanted.length
        ? await UserKey.find({ _id: { $in: wanted }, active: true })
              .select('_id')
              .lean()
        : [];

    const activeIds = activeDocs.map((k) => k._id);
    const activeSet = new Set(activeIds.map(String));
    const allowNull = !actor || !actor.userKey;

    // ------------------------------------------------------------
    // ★ XÁC ĐỊNH ADMIN CỦA TỪNG TỔ CHỨC
    //   Nội dung của tổ chức X chỉ hợp lệ khi userKey = X VÀ createdBy là
    //   một admin thuộc X (role 'admin', userKey = X).
    //   Tổ chức default: createdBy là admin default (role 'admin', userKey null).
    //   → Môn/bài do admin user_key tạo mà lỡ bị lưu userKey = null (dữ liệu cũ)
    //     sẽ KHÔNG lọt vào student default nữa, vì người tạo không phải admin default.
    // ------------------------------------------------------------
    const adminOr = [];
    if (allowNull) adminOr.push({ userKey: null }); // khớp cả user thiếu field
    if (activeIds.length) adminOr.push({ userKey: { $in: activeIds } });

    const admins = adminOr.length
        ? await User.find({
              role: 'admin',
              deletedForever: { $ne: true },
              $or: adminOr
          })
              .select('_id userKey')
              .lean()
        : [];

    const DEFAULT_ORG = 'default';
    const adminIdsByOrg = new Map(); // orgKey -> ObjectId[]
    for (const a of admins) {
        const org = toId(a.userKey) || DEFAULT_ORG;
        if (!adminIdsByOrg.has(org)) adminIdsByOrg.set(org, []);
        adminIdsByOrg.get(org).push(a._id);
    }
    const adminSetByOrg = new Map(
        [...adminIdsByOrg].map(([org, ids]) => [org, new Set(ids.map(String))])
    );

    const orgClauses = [];
    if (allowNull) {
        // null trong $in khớp cả createdBy null/thiếu (nội dung rất cũ của admin default)
        orgClauses.push({
            userKey: null,
            createdBy: { $in: [null, ...(adminIdsByOrg.get(DEFAULT_ORG) || [])] }
        });
    }
    for (const id of activeIds) {
        orgClauses.push({
            userKey: id,
            createdBy: { $in: adminIdsByOrg.get(String(id)) || [] }
        });
    }

    return {
        actor,
        isDefaultAdmin: false,
        isOrgAdmin: false,
        // $and bọc ngoài để không đè lên $or mà controller có thể tự thêm (vd ô tìm kiếm)
        filter: orgClauses.length ? { $and: [{ $or: orgClauses }] } : { _id: null },
        canAccess: (doc) => {
            if (!doc) return false;
            const k = toId(doc.userKey);
            const creator = toId(doc.createdBy);

            if (k === null) {
                return (
                    allowNull &&
                    (creator === null ||
                        (adminSetByOrg.get(DEFAULT_ORG)?.has(creator) ?? false))
                );
            }
            if (!activeSet.has(k)) return false;
            return !!creator && (adminSetByOrg.get(k)?.has(creator) ?? false);
        }
    };
}

/**
 * Filter danh sách user mà admin được nhìn thấy trong trang duyệt user.
 * Admin user_key: client/student cùng userKey + client pending chưa gán tổ chức.
 * Admin default: tất cả.
 */
function buildUserListFilter(actor, { includeDefaultAdmins = false } = {}) {
    if (isDefaultAdmin(actor)) return {};
    if (isOrgAdmin(actor)) {
        // Lưu ý: filter này có $or ở TOP-LEVEL → caller phải gộp bằng $and
        // ({ $and: [filter, extra] }), không spread cùng một $or khác.
        return {
            $or: [
                // 1) user đã thuộc tổ chức của admin
                { userKey: actor.userKey, role: { $in: ['client', 'student', 'admin'] } },
                // 2) ★ client MỚI ĐĂNG KÝ, chưa ai duyệt, chưa gán tổ chức (userKey null/thiếu):
                //    đăng ký không có mã tổ chức nên userKey = null (xem auth.controller verifyOtp);
                //    admin user_key phải thấy để duyệt → duyệt = nhận về tổ chức của mình.
                { userKey: null, role: 'client', status: 'pending' },
                // 3) (chỉ khi includeDefaultAdmins) admin default: HIỂN THỊ để xem, KHÔNG được tác động
                ...(includeDefaultAdmins ? [{ userKey: null, role: 'admin' }] : [])
            ]
        };
    }
    return { _id: null }; // không phải admin → không thấy ai
}

/**
 * Tính các field cần $set khi ADMIN DUYỆT một user.
 * Gọi hàm này trong controller duyệt user rồi User.updateOne / save.
 *
 *   - Admin user_key: chỉ duyệt user CÙNG userKey (hoặc client pending chưa gán
 *                     tổ chức → nhận về tổ chức mình), chỉ thành 'student',
 *     userKey bị CỐ ĐỊNH theo admin — mọi userKey gửi lên bị bỏ qua.
 *   - Admin default : chọn role 'student' | 'admin'; được đổi userKey
 *     (input.userKey: '' hoặc null = tổ chức default).
 *
 * Ném lỗi có `.status` (403/400) nếu vi phạm.
 */
async function resolveApproval(actor, target, input = {}) {
    if (!actor || actor.role !== 'admin') {
        throw httpError(403, 'Bạn không có quyền duyệt user.');
    }
    if (!target) throw httpError(404, 'Không tìm thấy user.');

    const approvedFields = { status: 'approved', approvedAt: new Date(), approvedBy: actor._id };

    if (isOrgAdmin(actor)) {
        // ★ client mới đăng ký (pending, chưa có tổ chức) → được duyệt & nhận về tổ chức mình
        const isUnclaimed =
            !target.userKey && target.role === 'client' && target.status === 'pending';
        if (!isUnclaimed && toId(target.userKey) !== toId(actor.userKey)) {
            throw httpError(403, 'Bạn chỉ được duyệt user thuộc tổ chức của mình.');
        }
        if (!['client', 'student'].includes(target.role)) {
            throw httpError(403, 'Bạn không được thay đổi tài khoản này.');
        }
        if (input.role && input.role !== 'student') {
            throw httpError(403, 'Admin tổ chức chỉ được duyệt user thành student.');
        }
        return { ...approvedFields, role: 'student', userKey: actor.userKey };
    }

    // Admin default
    const role = input.role || 'student';
    if (!['student', 'admin'].includes(role)) {
        throw httpError(400, 'Role không hợp lệ.');
    }

    let userKey = target.userKey || null;
    if (input.userKey !== undefined) {
        if (!input.userKey) {
            userKey = null;
        } else {
            if (!mongoose.Types.ObjectId.isValid(String(input.userKey))) {
                throw httpError(400, 'userKey không hợp lệ.');
            }
            const org = await UserKey.exists({ _id: input.userKey, active: true });
            if (!org) throw httpError(400, 'Tổ chức không tồn tại hoặc đã bị tắt.');
            userKey = input.userKey;
        }
    }

    return { ...approvedFields, role, userKey };
}

module.exports = {
    normalizeUserKeyCode,
    findActiveUserKeyByCode,
    getActor,
    isDefaultAdmin,
    isOrgAdmin,
    getContentScope,
    buildUserListFilter,
    resolveApproval
};
