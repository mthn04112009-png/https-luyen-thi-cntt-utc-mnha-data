#include <bits/stdc++.h>

using namespace std;


class LopMon {
	private:
		string maMon;
		string tenMon;
		int soTin;
	public:
		LopMon(string hoTen = "", string tenMon = "", double soTin = 0.0){
			this->maMon = hoTen;
			this->tenMon = tenMon;
			this->soTin = (int)soTin;
		}
		void nhap() {
			cout << "Nhap ma mon: ";
			getline(cin >> ws, maMon);
			cout << "Nhap ten mon: ";
			getline(cin, tenMon);
			cout << "Nhap so tin chi: ";
			cin >> soTin;
		}
		void xuat() {
			cout << "Ma mon: " << maMon << ", Ten mon: " << tenMon << ", So tin chi: " << soTin << endl;
		}
		int getSoTin() {
			return this->soTin;
		}
};


class quanLyMon {
	private:
		string maKyHoc;
		int soMonHoc;
		LopMon* dsMonHoc; 
	public:
		quanLyMon(string maKyHoc = "", int soMonHoc = 0) {
			this->maKyHoc = maKyHoc;
			this->soMonHoc = soMonHoc;
			this->dsMonHoc = nullptr;
		}
		~quanLyMon() {
			delete[] dsMonHoc;
		}
		void nhap(){
			cout << "Nhap ma ky hoc: ";
			getline(cin >> ws, maKyHoc);
			cout << "Nhap so mon hoc: ";
			cin >> soMonHoc;
			dsMonHoc = new LopMon[soMonHoc];
			for(int i = 0; i < soMonHoc; i++) {
				cout << "Nhap thong tin mon hoc thu " << i + 1 << ":\n";
				dsMonHoc[i].nhap(); 
			}
		}
		int tongTinChi() {
			int tong = 0;
			for(int i = 0; i < soMonHoc; i++) {
				if(dsMonHoc != nullptr) {
					tong += dsMonHoc[i].getSoTin();
				}
			}
			return tong;
		}
		void xuat(){
			cout << "Ma ky hoc: " << maKyHoc << ", So mon hoc: " << soMonHoc << ", Tong so tin chi: " << tongTinChi() << endl;
			cout << "Danh sach cac mon hoc:\n";
			for(int i = 0; i < soMonHoc; i++) {
				dsMonHoc[i].xuat();
			}
		}
};


int main() {
    int soKy;
    cout << "Nhap so luong ky hoc: ";
    cin >> soKy;
    quanLyMon* dsKyHoc = new quanLyMon[soKy];
    for (int i = 0; i < soKy; i++) {
        cout << "\nNhap thong tin cho ky hoc thu " << i + 1 << ":\n";
        dsKyHoc[i].nhap();
    }
    cout << "\n--- THONG TIN CAC KY HOC ---\n";
    for (int i = 0; i < soKy; i++) {
        dsKyHoc[i].xuat();
    }
    if (soKy > 0) {
        int maxTongTin = dsKyHoc[0].tongTinChi();
        for (int i = 1; i < soKy; i++) {
            if (dsKyHoc[i].tongTinChi() > maxTongTin) {
                maxTongTin = dsKyHoc[i].tongTinChi();
            }
        }
        cout << "\n--- KY HOC CO NHIEU TIN CHI NHAT ---\n";
        for (int i = 0; i < soKy; i++) {
            if (dsKyHoc[i].tongTinChi() == maxTongTin) {
                dsKyHoc[i].xuat();
            }
        }
    }
    delete[] dsKyHoc;
    return 0;
}
