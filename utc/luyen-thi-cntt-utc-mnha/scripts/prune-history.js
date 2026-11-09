// scripts/prune-history.js
// Xoá lịch sử commit CŨ của repo dữ liệu GitHub, chỉ giữ commit trong N ngày gần nhất (mặc định 5). Chi tiết: services/githubPrune.js
//   Xem trước (mặc định, KHÔNG sửa gì):  node scripts/prune-history.js
//   Chạy thật:                            node scripts/prune-history.js --yes
//   --days=5 · --backup (tạo nhánh backup/pre-prune-…) · --only-main (bỏ qua repo -1, -2…)
// Hằng ngày đã tự chạy qua Vercel Cron (vercel.json → /api/github/prune-history); script này để chạy tay khi cần.
require('dotenv').config();
const { pruneAll } = require('../services/githubPrune');
const argv = process.argv.slice(2);
const val = (n) => { const a = argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : null; };
const apply = argv.includes('--yes'), days = Number(val('days') || 5);
console.log(apply ? `CẮT LỊCH SỬ THẬT — giữ ${days} ngày gần nhất` : `XEM TRƯỚC (thêm --yes để chạy thật) — giữ ${days} ngày gần nhất`);
pruneAll({ apply, days, backup: argv.includes('--backup'), onlyMain: argv.includes('--only-main') })
  .then((r) => process.exit(r.some((x) => x.status === 'error') ? 1 : 0))
  .catch((e) => { console.error('❌', e.message); process.exit(1); });
