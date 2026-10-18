#include <bits/stdc++.h>
using namespace std;

class Employee {
private:
    string maNV;
    string hoTen;
public:
    Employee() : maNV(""), hoTen("") {}
    virtual ~Employee() {}
    virtual void nhap() {
        cout << "Nhap ma nhan vien: ";
        getline(cin >> ws, maNV);
        cout << "Nhap ho ten: ";
        getline(cin >> ws, hoTen);
    }
    // ham ao thuan tuy: lop dan xuat bat buoc phai cai dat
    virtual double calculateSalary() const = 0;
    virtual void xuat() {
        cout << "Ma nhan vien: " << maNV << " | Ho ten: " << hoTen << " | Luong = " << fixed << setprecision(2) << calculateSalary() << endl;
    }
};

class FullTimeEmployee : public Employee {
private:
    double luongCoBan = 0, phuCap = 0;
public:
    void nhap() {
        Employee::nhap();
        cout << "Nhap luong co ban: ";
        cin >> luongCoBan;
        cout << "Nhap phu cap: ";
        cin >> phuCap;
    }
    double calculateSalary() const {
        return luongCoBan + phuCap;
    }
};

class PartTimeEmployee : public Employee {
private:
    double gioLam = 0, donGiaMotGio = 0;
public:
    void nhap() {
        Employee::nhap();
        cout << "Nhap gio lam: ";
        cin >> gioLam;
        cout << "Nhap don gia mot gio: ";
        cin >> donGiaMotGio;
    }
    double calculateSalary() const {
        return gioLam * donGiaMotGio;
    }
};

class CommissionEmployee : public Employee {
private:
    double luongCoBan = 0, hoaHong = 0, doanhThu = 0;
public:
    void nhap() {
        Employee::nhap();
        cout << "Nhap luong co ban: ";
        cin >> luongCoBan;
        cout << "Nhap hoa hong (vd 0.1): ";
        cin >> hoaHong;
        cout << "Nhap doanh thu: ";
        cin >> doanhThu;
    }
    double calculateSalary() const {
        return luongCoBan + hoaHong * doanhThu;
    }
};

int main() {
    int n;
    cout << "Nhap n: ";
    cin >> n;
    vector<Employee*> ds(n); // chuan CPP
//    Employee* ds[n]; //khong chuan CPP
    for (int i = 0; i < n; i++) {
        cout << "--- Nhan vien thu " << i + 1 << " ---\n";
        int loai = 0;
        do {
            cout << "Chon loai (1: FullTime, 2: PartTime, 3: Commission): ";
            cin >> loai;
            if (loai == 1) ds[i] = new FullTimeEmployee;
            else if (loai == 2) ds[i] = new PartTimeEmployee;
            else if (loai == 3) ds[i] = new CommissionEmployee;
            else cout << "Vui long chon lai!\n";
        } while (loai < 1 || loai > 3);
        ds[i]->nhap();
    }
    cout << "\n===== DANH SACH NHAN VIEN =====\n";
    double tongQuyLuong = 0;
    for (int i = 0; i < n; i++){
    	ds[i]->xuat();
    	tongQuyLuong += ds[i]->calculateSalary();
	}
	cout << "\nTong quy luong: " << fixed << setprecision(2) << tongQuyLuong << endl;
    for (int i = 0; i < n; i++) delete ds[i];
    return 0;
}