const app = require("../server");

// Đảm bảo MongoDB đã kết nối trước khi Express xử lý request.
// Nếu lỗi kết nối, trả về thông báo rõ ràng thay vì để request treo đến timeout.
module.exports = async (req, res) => {
    // /api/node/health là endpoint công khai để web chính dò "web dữ liệu còn sống".
    // Không chặn theo MongoDB: web dữ liệu vẫn phải trả lời được khi Mongo tạm lỗi.
    const pathname = String(req.url || "").split("?")[0];
    if (pathname === "/api/node/health") return app(req, res);

    try {
        await app.connectDB();
    } catch (error) {
        console.error("[api/index] Không kết nối được MongoDB:", error.message);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        return res.end(
            JSON.stringify({
                success: false,
                message:
                    "Không kết nối được cơ sở dữ liệu. Kiểm tra MONGODB_URI và Network Access của MongoDB Atlas.",
            })
        );
    }

    return app(req, res);
};
