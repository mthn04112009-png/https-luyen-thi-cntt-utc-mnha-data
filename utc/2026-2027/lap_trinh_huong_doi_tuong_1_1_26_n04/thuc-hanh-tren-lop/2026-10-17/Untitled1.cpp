#include<bits/stdc++.h>
using namespace std;

class Vehicle {
	private:
	    string brand;
	    double speed;
	public:
	    Vehicle() {
	        brand = "";
	        speed = 0;
	    }
	    virtual ~Vehicle() {}
	    void nhap() {
	        cout << "Brand: ";
	        getline(cin >> ws, brand);
	        cout << "Speed: ";
	        cin >> speed;
	    }
	    virtual void move() {
	        cout << "Xe di chuyen bang: ";
	    }
	    void xuat() {                     // bo const
	        cout << "Brand: " << brand << " | Speed: " << speed << " | ";
	        move();                       // goi ham ao -> chay ban cua lop con
	        cout << endl;
	    }
};

class Car : public Vehicle {
	public:
	    void move() {                     // bo const va override
	        Vehicle::move();
	        cout << "Dong co\n";
	    }
};

class Bicycle : public Vehicle {
	public:
	    void move() {                     // bo const va override
	        Vehicle::move();
	        cout << "Suc nguoi\n";
	    }
};

class Motorcycle : public Vehicle {
	public:
	    void move() {                     // bo const va override
	        Vehicle::move();
	        cout << "Dong co\n";
	    }
};

int main() {
    int n;
    cout << "Nhap n: ";
    cin >> n;
    vector<Vehicle*> ds(n); // chuan CPP
//    Vehicle* ds[n]; //khong chuan CPP
    for (int i = 0; i < n; i++) {
        cout << "--- Xe " << i + 1 << " ---\n";
        int loai;
		do {
		    cout << "Chon loai (1: Car, 2: Bicycle, 3: Motorcycle): ";
		    cin >> loai;
		    if (loai == 1) ds[i] = new Car;
		    else if (loai == 2) ds[i] = new Bicycle;
		    else if (loai == 3) ds[i] = new Motorcycle;
		    else cout << "Vui long chon lai!\n";
		} while (loai < 1 || loai > 3);   // chon sai thi lap lai
        ds[i]->nhap();
    }
    cout << "\n===== DANH SACH XE =====\n";
    for (int i = 0; i < n; i++) {
        ds[i]->xuat();
    }
    for (int i = 0; i < n; i++) delete ds[i];
    return 0;
}