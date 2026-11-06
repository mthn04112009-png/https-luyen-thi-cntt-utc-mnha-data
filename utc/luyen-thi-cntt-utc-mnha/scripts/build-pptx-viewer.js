// scripts/build-pptx-viewer.js
// ------------------------------------------------------------
// Chép tài nguyên của Nutrient Web SDK (npm "@nutrient-sdk/viewer") vào public/vendor/nutrient/
// để trang xem slide (public/js/studyFileViewer.js) nạp cho file .pptx.
// Nếu thư mục chưa có / lỗi → trang tự dùng lõi dự phòng js/pptxPlayer.js.
//
// Cách dùng (chạy 1 lần ở máy bạn, rồi COMMIT public/vendor để Vercel phục vụ file tĩnh):
//   npm install @nutrient-sdk/viewer@1.22.0
//   npm run build:pptx
//
// Giấy phép: bản dùng thử có watermark. Có key thì đặt biến môi trường NUTRIENT_LICENSE_KEY
// và đưa vào slData (field nutrientKey) ở controller.
// ------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'node_modules', '@nutrient-sdk', 'viewer', 'dist');
const dest = path.join(root, 'public', 'vendor', 'nutrient');

if (!fs.existsSync(path.join(src, 'nutrient-viewer.js'))) {
    console.error('Chưa cài thư viện. Chạy:  npm install @nutrient-sdk/viewer@1.22.0');
    process.exit(1);
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', '@nutrient-sdk', 'viewer', 'package.json'), 'utf8'));
console.log('@nutrient-sdk/viewer', pkg.version);

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
fs.cpSync(src, dest, { recursive: true });
if (!fs.existsSync(path.join(dest, 'nutrient-viewer-lib'))) { console.error('Thiếu thư mục nutrient-viewer-lib sau khi chép.'); process.exit(1); }
console.log('Xong → public/vendor/nutrient/');
