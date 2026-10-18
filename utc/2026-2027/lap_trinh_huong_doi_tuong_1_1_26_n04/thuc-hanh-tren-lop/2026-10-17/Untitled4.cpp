// Du lieu cua Shape la protected

#include <bits/stdc++.h>
using namespace std;

class Shape{
	protected:
		double width;
		double height;
	public:
		Shape(){
			width = 0;
			height = 0;
		}
		virtual ~Shape(){
		}
		virtual void nhap(){
			cout << "Nhap chieu rong (Chieu rong day): ";
			cin >> width;
			cout << "Nhap chieu dai (Chieu cao): ";
			cin >> height;
		}
		virtual double area() const = 0;
		virtual void xuat(){
			cout << "Chieu rong: " << width << " | Chieu dai: " << height << " | Dien tich: " << fixed << setprecision(2) << area() << endl;
		}
};

class Triangle : public Shape{
	public:
		double area() const override{
			return 0.5 * width * height;
		}
};

class Rectangle : public Shape{
	public:
		double area() const override{
			return width * height;
		}
};

int main(){
    int n;
    cout << "Nhap n: ";
    cin >> n;
    vector<Shape*> ds(n);
    for (int i = 0; i < n; i++) {
    	cout << "--- Hinh " << i + 1 << " ---\n";
    	int loai = 0;
    	do{
    		cout << "Chon loai (1. Hinh tam giac, 2. Hinh chu nhat): ";
    		cin >> loai;
            if (loai == 1) ds[i] = new Triangle;
            else if (loai == 2) ds[i] = new Rectangle;
            else cout << "Vui long chon lai!\n";
		} while (loai < 1 || loai > 2);
		ds[i]->nhap();
	}
    cout << "\n===== DANH SACH HINH =====\n";
    for (int i = 0; i < n; i++){
    	ds[i]->xuat();
	}
    for (int i = 0; i < n; i++) delete ds[i];
    return 0;
}