// Du lieu cua Shape la private

#include <bits/stdc++.h>
using namespace std;

class Shape{
	private:
		double width;
		double height;
	public:
		Shape(){
			width = 0;
			height = 0;
		}
		Shape(double w, double h){
			width = w;
			height = h;
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
		double getWidth() const {
			return width;
		}
		double getHeight() const {
			return height;
		}
};

class Triangle : public Shape{
	public:
		Triangle() : Shape(){}
		Triangle(double w, double h) : Shape(w, h){}
		double area() const override{
			return 0.5 * getWidth() * getHeight();
		}
};

class Rectangle : public Shape{
	public:
		Rectangle() : Shape(){}
		Rectangle(double w, double h) : Shape(w, h){}
		double area() const override{
			return getWidth() * getHeight();
		}
};

int main(){
    // Phan theo de: hai doi tuong khoi tao bang ham tao co doi
    Triangle t(3, 4);
    Rectangle r(5, 6);
    cout << "Dien tich tam giac: " << fixed << setprecision(2) << t.area() << endl;
    cout << "Dien tich hinh chu nhat: " << r.area() << endl;
    // Phan mo rong: nhap n hinh, dung da hinh
    int n;
    cout << "\nNhap n: ";
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