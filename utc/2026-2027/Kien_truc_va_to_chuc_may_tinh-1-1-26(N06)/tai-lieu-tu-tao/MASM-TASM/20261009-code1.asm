.model small
.stack 100h
.data
    ms1 db  'nhap so thu nhat: $'          ;thong bao nhap so thu nhat
    ms2 db  10, 13, 'nhap so thu hai: $'   ;10, 13: xuong dong + ve dau dong
    ms3 db  10, 13, 'tong hai so: $'       ;thong bao hien thi ket qua

.code
main proc
    ;khoi tao doan du lieu
    mov ax, @data
    mov ds, ax

    ;in thong bao nhap so thu nhat
    mov ah, 9           ;ham 9: hien thi chuoi ket thuc bang $
    lea dx, ms1         ;dx = dia chi chuoi ms1
    int 21h

    ;nhap so thu nhat
    mov ah, 1           ;ham 1: doc 1 ky tu tu ban phim, luu vao al
    int 21h

    sub al, 48          ;doi ky tu ASCII thanh so ('0' = 48)
    mov bl, al          ;luu so thu nhat vao bl

    ;in thong bao nhap so thu hai
    mov ah, 9
    lea dx, ms2
    int 21h

    ;nhap so thu hai
    mov ah, 1
    int 21h
    sub al, 48          ;doi ky tu ASCII thanh so, ket qua o al

    ;tinh tong
    add bl, al          ;bl = so thu nhat + so thu hai

    ;in thong bao ket qua
    mov ah, 9
    lea dx, ms3
    int 21h

    ;tach tong thanh chu so hang chuc va hang don vi
    mov ah, 0           ;xoa ah de ax = tong (div 8 bit chia ax cho toan hang)
    mov al, bl          ;al = tong
    mov bh, 10          ;bh = so chia
    div bh              ;al: thuong (hang chuc), ah: du (hang don vi)

    mov bh, ah          ;cat chu so hang don vi vao bh (vi ah sap bi ghi de)

    ;hien thi chu so hang chuc
    mov ah, 2           ;ham 2: hien thi 1 ky tu trong dl
    mov dl, al          ;dl = chu so hang chuc
    add dl, 48          ;doi thanh ky tu ASCII
    int 21h

    ;hien thi chu so hang don vi
    mov dl, bh          ;dl = chu so hang don vi (ah van = 2 nen khong can gan lai)
    add dl, 48          ;doi thanh ky tu ASCII
    int 21h

    ;ket thuc chuong trinh
    mov ah, 4ch         ;ham 4ch: thoat ve he dieu hanh
    int 21h

    main endp
end main