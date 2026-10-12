//(Kiểm tra ngắn OOP C++) Đề 2 05/10/2026

#include <iostream>
#include <string>
#include <vector>

using namespace std;

class Nguoi {
    private:
        string hoTen;
        int namSinh;
    public:
        // (4) Bo sung ham tao mac dinh va ham tao tham so
        Nguoi() : hoTen(""), namSinh(0) {}
        Nguoi(string ht, int ns) : hoTen(ht), namSinh(ns) {}
        // Nap chong toan tu nhap cho lop Nguoi
        friend istream& operator >> (istream &is, Nguoi &n) {
            cout << "Nhap ho ten: ";
            // (1) Dung nhap chuan C++ xoa khoang trang/xuong dong thua truoc do
            is >> ws; 
            getline(is, n.hoTen);
            cout << "Nhap nam sinh: ";
            is >> n.namSinh;
            return is;
        }
        // Nap chong toan tu xuat cho lop Nguoi
        friend ostream& operator << (ostream &os, const Nguoi &n) {
            os << "Ho ten: " << n.hoTen << ", Nam sinh: " << n.namSinh;
            return os;
        }
        int getNS() const {
            return namSinh;
        }
        int getTuoi() const {
            return 2026 - namSinh;
        }
};

class NhanVien : public Nguoi {
    private:
        double heSoLuong;
    public:
        // (4) Bo sung ham tao mac dinh va ham tao tham so cho lop con
        NhanVien() : Nguoi(), heSoLuong(0.0) {}
        NhanVien(string ht, int ns, double hsl) : Nguoi(ht, ns), heSoLuong(hsl) {}
        double luong() const {
            return heSoLuong * 2570;
        }
        // Nap chong toan tu nhap cho lop NhanVien (goi lai toan tu cua Nguoi)
        friend istream& operator >> (istream &is, NhanVien &nv) {
            is >> (Nguoi&)nv;
            cout << "Nhap he so luong: ";
            is >> nv.heSoLuong;
            return is;
        }
        // Nap chong toan tu xuat cho lop NhanVien (goi lai toan tu cua Nguoi)
        friend ostream& operator << (ostream &os, const NhanVien &nv) {
            os << (const Nguoi&)nv;
            // (3) Da bo endl o cuoi de tranh loi thua dong trong
            os << ", He so luong: " << nv.heSoLuong << ", Luong: " << nv.luong();
            return os;
        }
};

int main() {
    int n;
    cout << "Nhap n: ";
    cin >> n;
    // (2) Thay the mang dong VLA (NhanVien nv[n]) bang std::vector chuan C++
    vector<NhanVien> nv(n);
    cout << "\n--- NHAP THONG TIN CHO NHAN VIEN ---\n";
    for (int i = 0; i < n; i++) {
        cout << "\nNhap nhan vien thu " << i + 1 << ":\n";
        cin >> nv[i];
    }
    cout << "\n--- DANH SACH NHAN VIEN VUA NHAP ---\n";
    for (int i = 0; i < n; i++) {
        // (3) Giu nguyen endl o day de xuong dong cho tung nhan vien
        cout << "[" << i + 1 << "] " << nv[i] << endl; 
    }
    return 0;
}


