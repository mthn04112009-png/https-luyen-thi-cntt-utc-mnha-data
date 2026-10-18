.model small
.stack 100h
.data
    ms1 db  'nhap day ky tu: $'
    ms2 db  10, 13, 'day ky tu vua nhap: $'
    ms3 db  10, 13, 'day chu hoa: $'
    ms4 db  10, 13, 'day chu thuong: $'
    s   db  20 dup(?)
    s1  db  20 dup(?)
    s2  db  20 dup(?)
.code
    main procAb
        mov ax, @data
        mov ds, ax

        mov ah, 9
        lea dx, ms1
        int 21h

        mov bx, 0               ;bx = chi so trong mang s, cung la so ky tu da nhap
nhaptiep:
        mov ah, 1               ;ham 1: doc 1 ky tu, luu vao al
        int 21h
        cmp al, 13              ;kiem tra co phai phim Enter khong (ma ASCII 13)
        je kt                   ;neu la Enter thi thoat vong lap nhap

        mov s[bx], al           ;cat ky tu vao mang s
        inc bx
        jmp nhaptiep

kt:
        inc bx
        mov s[bx], '$'          ;them $ de ket thuc chuoi s

        mov ah, 9
        lea dx, ms2
        int 21h                 ;in thong bao "day ky tu vua nhap"

        lea dx, s
        int 21h                 ;in day ky tu vua nhap

        dec bx                  ;bx tro lai gia tri so ky tu da nhap

        mov si, 0               ;si = chi so trong mang s1 (chu thuong)
        mov di, 0               ;di = chi so trong mang s2 (chu hoa)

        mov cx, bx              ;cx = gioi han duyet
        mov bx, 0               ;bx = 0, bat dau duyet tu ky tu dau tien
doitiep:
        cmp s[bx], 'a'
        jl  chuhoa              ;ma nho hon 'a' thi la chu hoa

        mov al, s[bx]           ;nguoc lai la chu thuong, chep sang s1
        mov s1[si], al
        inc si
        jmp duyettiep
chuhoa:
        mov al, s[bx]           ;chep sang s2
        mov s2[di], al
        inc di
duyettiep:
        inc bx
        cmp bx, cx
        jle doitiep             ;lap den khi bx vuot cx

        inc si
        mov s1[si], '$'         ;ket thuc chuoi s1
        inc di
        mov s2[di], '$'         ;ket thuc chuoi s2

        mov ah, 9
        lea dx, ms3
        int 21h
        lea dx, s2
        int 21h                 ;in day chu hoa

        lea dx, ms4
        int 21h
        lea dx, s1
        int 21h                 ;in day chu thuong

        mov ah, 4ch
        int 21h
        main endp
    end main