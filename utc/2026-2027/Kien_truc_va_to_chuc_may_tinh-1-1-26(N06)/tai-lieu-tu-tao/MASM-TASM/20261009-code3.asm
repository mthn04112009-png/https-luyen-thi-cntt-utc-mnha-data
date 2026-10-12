.model small
.stack 100h
.data
    ms1 db  'nhap so thu nhat: $'                  ;thong bao nhap so thu nhat
    ;thay ham xuong_dong bang 10, 13 (xuong dong)
    ms2 db  'nhap so thu hai: $'           ;thong bao nhap so thu hai
    ;thay ham xuong_dong bang 10, 13 (xuong dong)
    ms3 db 'tong hai so: $'               ;thong bao hien thi ket qua
    a   db 0                                       ;bien luu so thu nhat / chu so hang don vi
    b   db 0

.code
main proc
    ;khoi tao doan du lieu
    mov ax, @data
    mov ds, ax

    ;in thong bao nhap so thu nhat
    mov ah, 9           ;ham 9: hien thi chuoi ket thuc bang $
    lea dx, ms1
    int 21h

    ;nhap so thu nhat (2 chu so)
    mov ah, 1           ;ham 1: doc 1 ky tu, luu vao al
    int 21h
    sub al, 48          ;doi thanh so (chu so hang chuc)
    mov bl, 10
    mul bl              ;ax = al * 10 (hang chuc * 10)
    mov bx, ax          ;luu ket qua tam vao bl/bx

    mov ah, 1
    int 21h
    sub al, 48          ;doi thanh so (chu so hang don vi)
    add bl, al          ;luu so thu nhat                //bl = so thu nhat
    mov a, bl           ;luu so thu nhat vao bien a

    ;xuong dong sau khi in tong
    call xuong_dong

    ;in thong bao nhap so thu hai
    mov ah, 9
    lea dx, ms2
    int 21h

    ;nhap so thu hai (2 chu so)
    mov ah, 1
    int 21h
    sub al, 48          ;doi thanh so (chu so hang chuc)
    mov bl, 10
    mul bl              ;ax = al * 10 (hang chuc * 10)
    mov bl, al          ;luu tam vao bl

    mov ah, 1
    int 21h
    sub al, 48          ;doi thanh so (chu so hang don vi)
    add bl, al          ;luu so thu hai                 //bl = so thu hai

    ;tinh tong
    ;thay add bl, bh bang add bl, a (so thu nhat nam trong bien a)
    add bl, a           ;tong luu trong bl

    ;xuong dong sau khi in tong
    call xuong_dong

    ;in thong bao ket qua ms3
    mov ah, 9
    lea dx, ms3
    int 21h

    ;tach tong thanh chu so hang chuc va hang don vi
    mov ah, 0           ;xoa ah de ax = tong
    mov al, bl          ;al = tong
    mov bl, 10          ;bl = so chia
    div bl              ;al: thuong (hang chuc), ah: du (hang don vi)

    mov a, ah           ;cat chu so hang don vi vao bien a

    ;hien thi chu so hang chuc
    mov ah, 2           ;ham 2: hien thi 1 ky tu trong dl
    mov dl, al          ;dl = chu so hang chuc
    add dl, 48          ;doi thanh ky tu ASCII
    int 21h

    ;hien thi chu so hang don vi
    mov dl, a           ;dl = chu so hang don vi
    add dl, 48          ;doi thanh ky tu ASCII
    int 21h

    ;xuong dong sau khi in tong
    call xuong_dong

    ;ket thuc chuong trinh
    mov ah, 4ch         ;ham 4ch: thoat ve he dieu hanh
    int 21h

    main endp

;ham xuong dong: in ky tu 13 (ve dau dong) va 10 (xuong dong)
xuong_dong proc
    push ax             ;cat ax, dx de khong lam hong gia tri ben ngoai
    push dx

    mov ah, 2           ;ham 2: hien thi 1 ky tu
    mov dl, 13          ;ve dau dong
    int 21h
    mov dl, 10          ;xuong dong
    int 21h

    pop dx              ;lay lai dx, ax
    pop ax
    ret
xuong_dong endp
end main