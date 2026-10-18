#include<bits/stdc++.h>
using namespace std;
class Xe{
	protected:
		// private: truy cap duoc lop cha (khong truy cap duoc ham con va ham main)
		// protected: truy cap duoc lop con
		string bien;
		double trongluong;
	public:
		//public: truy cap tat ca
		Xe(){
			bien = "";
			trongluong = 0;
		}
		void nhap(){
			cout<<"Nhap bien so xe: ";
			getline(cin >> ws, bien);
			cin>>bien;
			cout<<"Nhap trong luong xe: ";
			cin>>trongluong;
		}
		void xuat(){
			cout<<endl<<"Bien so: "<<bien<<" "<<"Trong luong: "<<trongluong;
		}
		float getTrongluong(){
			return trongluong;
//		}	
//		double getTL(){
//			return trongluong;
//		} // khi class Xe dung private	
};
class XeCon : public Xe{
// class XeCon : protected Xe
	private:
		int sochongoi;
	public:
		XeCon(){
			sochongoi = 0;
		}
		void nhap(){
			Xe::nhap();
			cout<<"So cho ngoi: ";
			cin>>sochongoi;
		}
		void xuat(){
			Xe::xuat();
			cout<<endl<<"So cho ngoi: "<<sochongoi;
		}
		int getSoChoNgoi(){
			return sochongoi;
		}
		double getTL(){
			return trongluong;
		} // khi class Xe dung protected	
};
int main(){
	int n;
	cout<<"Nhap n xe:";
	cin>>n;
	XeCon a[n];
	for(int i=0;i<n;i++){
		a[i].nhap();
	}
	cout << "\n---DANH SACH XE---";
	for(int i=0;i<n;i++){
		a[i].xuat();
	}
	
	cout<<"\n\nDanh sach xe thoa man dieu kien";
	for(int i=0;i<n;i++){
		if(a[i].getTrongluong()<1 && a[i].getSoChoNgoi()<=5){
			a[i].xuat();
		}
	}
	return 0;
}