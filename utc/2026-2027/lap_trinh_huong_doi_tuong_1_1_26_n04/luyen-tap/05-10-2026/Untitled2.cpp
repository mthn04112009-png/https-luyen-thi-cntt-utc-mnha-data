// (Kiểm tra ngắn OOP C++) Đề 3 05/10/2026

#include <iostream>
#include <string>
#include <vector>
#include <algorithm>

using namespace std;

// ================= LỚP CHA: NGUOI =================
class Nguoi {
    private:
        string hoTen;
        int namSinh;
    public:
        // Hàm tạo mặc định và hàm tạo đầy đủ tham số
        Nguoi() : hoTen(""), namSinh(0) {}
        Nguoi(string ht, int ns) : hoTen(ht), namSinh(ns) {}
        // Nạp chồng toán tử nhập cho lớp Nguoi
        friend istream& operator >> (istream &is, Nguoi &n) {
            cout << "Nhap ho ten: ";
            is >> ws; // Xóa khoảng trắng và ký tự xuống dòng thừa trong bộ đệm
            getline(is, n.hoTen);
            cout << "Nhap nam sinh: ";
            is >> n.namSinh;
            return is;
        }
        // Nạp chồng toán tử xuất cho lớp Nguoi
        friend ostream& operator << (ostream &os, const Nguoi &n) {
            os << "Ho ten: " << n.hoTen << ", Nam sinh: " << n.namSinh;
            return os;
        }
        // Phương thức getter lấy năm sinh
        int getNS() const {
            return namSinh;
        }
        // Phương thức phụ trợ tính tuổi dựa trên mốc năm 2026 của đề bài
        int getTuoi() const {
            return 2026 - namSinh;
        }
};

// ================= LỚP CON: NHAN VIEN =================
class NhanVien : public Nguoi {
    private:
        double heSoLuong;
    public:
        NhanVien() : Nguoi(), heSoLuong(0.0) {}
        NhanVien(string ht, int ns, double hsl) : Nguoi(ht, ns), heSoLuong(hsl) {}
        // Phương thức tính lương
        double luong() const {
            return heSoLuong * 2570;
        }
        // Nạp chồng toán tử nhập cho lớp NhanVien (gọi lại toán tử lớp cha qua ép kiểu)
        friend istream& operator >> (istream &is, NhanVien &nv) {
            is >> (Nguoi&)nv;
            cout << "Nhap he so luong: ";
            is >> nv.heSoLuong;
            return is;
        }
        // Nạp chồng toán tử xuất cho lớp NhanVien (gọi lại toán tử lớp cha qua ép kiểu)
        friend ostream& operator << (ostream &os, const NhanVien &nv) {
            os << (const Nguoi&)nv;
            os << ", He so luong: " << nv.heSoLuong << ", Luong: " << nv.luong();
            return os;
        }
};

// ================= LỚP CON: SINH VIEN =================
class SinhVien : public Nguoi {
    private:
        double diemSo;
    public:
        // Hàm tạo mặc định và hàm tạo tham số
        SinhVien() : Nguoi(), diemSo(0.0) {}
        SinhVien(string ht, int ns, double d) : Nguoi(ht, ns), diemSo(d) {}
        // Phương thức kiểm tra điều kiện học tập
        bool quaMon() const {
            return diemSo >= 6;
        }
        // Nạp chồng toán tử nhập cho lớp SinhVien (gọi lại toán tử lớp cha)
        friend istream& operator >> (istream &is, SinhVien &sv) {
            is >> (Nguoi&)sv;
            cout << "Nhap diem: ";
            is >> sv.diemSo;
            return is;
        }
        // Nạp chồng toán tử xuất cho lớp SinhVien (gọi lại toán tử lớp cha)
        friend ostream& operator << (ostream &os, const SinhVien &sv) {
            os << (const Nguoi&)sv; 
            os << ", Diem: " << sv.diemSo;
            if (sv.quaMon()) {
                os << " (Qua mon)";
            } else {
                os << " (Hoc lai)";
            }
            return os;
        }
};

// ================= HÀM TEMPLATE TÌM ĐỐI TƯỢNG TUỔI MAX =================
// (2) Giải quyết nhược điểm: Hàm trả về một const T& (tham chiếu hằng đến phần tử trong vector)
// Giúp ta lấy được TOÀN BỘ thông tin (tên, điểm, lương...) thay vì chỉ lấy một con số tuổi nguyên đơn thuần.
template <typename T>
const T& timNguoiTuoiMax(const vector<T>& danhSach) {
    size_t indexMax = 0;
    for (size_t i = 1; i < danhSach.size(); i++) {
        if (danhSach[i].getTuoi() > danhSach[indexMax].getTuoi()) {
            indexMax = i;
        }
    }
    return danhSach[indexMax];
}

// ================= HÀM MAIN SỬA ĐỔI TOÀN DIỆN =================
int main() {
    int n, m;
    // --- PHẦN 1: QUẢN LÝ NHÂN VIÊN ---
    cout << "Nhap so luong nhan vien (n): ";
    cin >> n;
    vector<NhanVien> nv(n);
    cout << "\n--- NHAP THONG TIN CHO NHAN VIEN ---\n";
    for (int i = 0; i < n; i++) {
        cout << "\nNhap nhan vien thu " << i + 1 << ":\n";
        cin >> nv[i];
    }
    cout << "\n--- DANH SACH NHAN VIEN VUA NHAP ---\n";
    for (int i = 0; i < n; i++) {
        cout << "[" << i + 1 << "] " << nv[i] << " (" << nv[i].getTuoi() << " tuoi)" << endl; 
    }
    if (!nv.empty()) {
        const NhanVien& nvMax = timNguoiTuoiMax(nv);
        cout << "\n=> THONG TIN NHAN VIEN LON TUOI NHAT:\n";
        cout << nvMax << " (" << nvMax.getTuoi() << " tuoi)\n";
    }
    cout << "\n----------------------------------------------------\n";
    // --- PHẦN 2: QUẢN LÝ SINH VIÊN ---
    cout << "Nhap so luong sinh vien (m): ";
    cin >> m;
    vector<SinhVien> sv(m);
    cout << "\n--- NHAP THONG TIN CHO SINH VIEN ---\n";
    for (int i = 0; i < m; i++) {
        cout << "\nNhap sinh vien thu " << i + 1 << ":\n";
        cin >> sv[i];
    }
    cout << "\n--- DANH SACH SINH VIEN VUA NHAP ---\n";
    for (int i = 0; i < m; i++) {
        cout << "[" << i + 1 << "] " << sv[i] << " (" << sv[i].getTuoi() << " tuoi)" << endl; 
    }
    if (!sv.empty()) {
        const SinhVien& svMax = timNguoiTuoiMax(sv);
        cout << "\n=> THONG TIN SINH VIEN LON TUOI NHAT:\n";
        cout << svMax << " (" << svMax.getTuoi() << " tuoi)\n";
    }
    return 0;
}
