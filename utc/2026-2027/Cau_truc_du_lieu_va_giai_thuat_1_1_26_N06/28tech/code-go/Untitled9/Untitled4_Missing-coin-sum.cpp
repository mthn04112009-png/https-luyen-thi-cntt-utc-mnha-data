#include<bits/stdc++.h>

using namespace std;
using ll = long long;

int main(){
	freopen("input4.cpp", "r", stdin);
	int n; cin >> n;
	int a[n];
	for(int i = 0; i < n; i++){
		cin >> a[i];
	}
	sort(a, a + n);
	ll sum = 0;
	for(int i = 0; i < n; i++){
		if(a[i] > sum + 1){
			cout << sum + 1 << endl;
			return 0;
		}
		else{
			sum += a[i];
		}
	}
	cout << sum + 1 << endl;
	return 0;
}