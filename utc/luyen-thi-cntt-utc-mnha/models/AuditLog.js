// models/AuditLog.js
// ============================================================
// AuditLog KHÔNG còn là Mongoose model: nhật ký được lưu ở GitHub
// (auditlogs/index.json) qua services/auditLogService.js.
// File này giữ lại để các controller cũ vẫn gọi `AuditLog.create({...})` như trước.
// Dữ liệu cũ trong MongoDB: chạy `node migrateMongoToGithub.js --only=auditlogs --run`.
// ============================================================
const service = require('../services/auditLogService');

module.exports = {
    create: (doc) => service.create(doc),
    list: (opts) => service.list(opts),
    readAll: (opts) => service.readAll(opts),
};
