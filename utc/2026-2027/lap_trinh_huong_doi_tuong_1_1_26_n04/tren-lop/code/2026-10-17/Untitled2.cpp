#include<bits/stdc++.h>
using namespace std;

class DongVat{
	public:
		virtual void keu(){
			cout <<"Keu ......";
		}
};

class Meo : public DongVat{
	public:
		void keu(){
			cout << "Mewwww";
		}
};

class Vit : public DongVat{
	public:
		void keu(){
			cout << "Cap cap";
		}
};

//int main(){
//	DongVat *dv;
//	Vit v;
////	dv = &v;
//	dv = new Vit();
//	dv->keu();
////	Vit v;
////	v.keu();
////	Meo m;
////	m.keu();
//}

/*===nhập vào n động vật, 1 là mèo, 2 là vịt, in ra tiếng kêu mỗi loại===*/


int main(){
	DongVat **dv;
	int n; cout << "Nhap n: "; cin >> n;
	dv = new DongVat*[n];
	for(int i = 0; i < n; i++){
		int loai;
		cout << "Nhap loai dong vat (1: Meo, 2: Vit): ";
		cin >> loai;
		if(loai == 1){
			dv[i] = new Meo();
		}
		else if(loai == 2){
			dv[i] = new Vit();
		}
		else{
			cout << "Loai khong hop le!" << endl;
			dv[i] = nullptr;
		}
	}
	cout << "\nTieng keu cua cac dong vat:\n";
	for(int i = 0; i < n; i++){
		if(dv[i] != nullptr){
			dv[i]->keu();
			cout << endl;
		}
	}
	for(int i = 0; i < n; i++){
		delete dv[i];
	}
	delete[] dv;
	return 0;
}
