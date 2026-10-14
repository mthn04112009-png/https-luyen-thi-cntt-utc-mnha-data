// =============================================================
// controllers/pagination.controller.js
// Helper phân trang dùng chung. KHÔNG cần route riêng.
// Các controller danh sách gọi paginate() rồi truyền kết quả vào res.render.
// Tên biến trả về khớp với views/pagination.pug:
//   currentPage, totalPages, baseUrl
// =============================================================

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

const toPositiveInt = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Tạo baseUrl cho pagination.pug.
 * - Giữ lại mọi query hiện có (q, status, limit...) trừ "page".
 * - Luôn kết thúc bằng "?" hoặc "&" vì partial nối thêm "page=N".
 *   vd: "/admin/tours?"  hoặc  "/admin/tours?q=abc&status=active&"
 */
const buildBaseUrl = (req) => {
  const path = req.originalUrl.split("?")[0];
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(req.query)) {
    // Bỏ "page" (partial tự nối) và các thông báo flash qua query
    if (key === "page" || key === "success" || key === "error") continue;

    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (v === undefined || v === null || v === "") continue;
      if (typeof v === "object") continue; // query lồng nhau (a[b]=c) bỏ qua
      params.append(key, String(v));
    }
  }

  const qs = params.toString();
  return qs ? `${path}?${qs}&` : `${path}?`;
};

/**
 * Phân trang một Mongoose model.
 *
 * @param {Model}  Model   Mongoose model
 * @param {Object} filter  điều kiện find (vd { deletedAt: null })
 * @param {Request} req    để đọc ?page=, ?limit= và dựng baseUrl
 * @param {Object} options { limit, sort, select, populate, lean }
 * @returns {{ items: Array, pagination: Object }}
 */
const paginate = async (Model, filter = {}, req, options = {}) => {
  const {
    limit: defaultLimit = DEFAULT_LIMIT,
    sort = { createdAt: -1 },
    select,
    populate,
    lean = true,
  } = options;

  const limit = Math.min(toPositiveInt(req.query.limit, defaultLimit), MAX_LIMIT);

  const totalItems = await Model.countDocuments(filter);
  const totalPages = Math.max(Math.ceil(totalItems / limit), 1);

  // Kẹp trang vào [1, totalPages] để ?page=999 không ra danh sách rỗng
  const currentPage = Math.min(toPositiveInt(req.query.page, 1), totalPages);

  let query = Model.find(filter)
    .sort(sort)
    .skip((currentPage - 1) * limit)
    .limit(limit);

  if (select) query = query.select(select);
  if (populate) query = query.populate(populate);
  if (lean) query = query.lean();

  const items = await query;

  return {
    items,
    pagination: {
      currentPage,
      totalPages,
      totalItems,
      limit,
      baseUrl: buildBaseUrl(req),
    },
  };
};

/**
 * Phân trang một MẢNG đã sắp xếp sẵn (dùng khi cách sắp xếp không biểu diễn được bằng sort của model).
 * Trả về cùng dạng với paginate().
 */
const paginateArray = (all, req, options = {}) => {
  const { limit: defaultLimit = DEFAULT_LIMIT } = options;
  const limit = Math.min(toPositiveInt(req.query.limit, defaultLimit), MAX_LIMIT);
  const totalItems = all.length;
  const totalPages = Math.max(Math.ceil(totalItems / limit), 1);
  const currentPage = Math.min(toPositiveInt(req.query.page, 1), totalPages);
  const items = all.slice((currentPage - 1) * limit, currentPage * limit);
  return {
    items,
    pagination: { currentPage, totalPages, totalItems, limit, baseUrl: buildBaseUrl(req) },
  };
};

module.exports = { paginate, paginateArray, buildBaseUrl };
