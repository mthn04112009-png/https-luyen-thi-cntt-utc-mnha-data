.model small
.stack 100h
.data
    ms1 db "nhap so: $"
    ms2 db "so vua nhap $"
    a   db  0

.code
    main proc

        ;khoi tao doan du lieu
        mov ax, @data
        mov ds, ax

        ;in thong bao nhap so
        mov ah, 9           ;ham 9: hien thi chuoi ket thuc bang $
        lea dx, ms1
        int 21h

        mov bl, 10          ;nhap so (2 chu so)
        ;SUA: doi mov bh, 1 thanh mov bh, 0 (so ghep bat dau tu 0)
        mov bh, 0           ;so dau tien = 0

    nhaptiep:                   ;nhan vong lap: doc tung ky tu cho den khi bam Enter
        mov ah, 1               ;ham 1: doc 1 ky tu, luu vao al
        int 21h
        cmp al, 13              ;kiem tra xem co phai la phim enter khong (ma ASCII 13)
        je stop1                ;neu la enter thi nhay ra ngoai vong lap (nhan stop1)
        sub al, 48              ;doi ky tu ASCII thanh so (chu so vua nhap)
        mov a, al               ;luu so vua nhap vao bien a
        mov al, bh              ;gan so dau tien vao al
        mul bl                  ;ax = al * bl (bl phai = 10 thi moi la nhan 10)
        add al, a               ;al = al + a
        ;SUA: doi mov bl, al thanh mov bh, al (cat so ghep vao bh, giu bl = 10)
        mov bh, al              ;gan ket qua vao bh
        jmp nhaptiep            ;quay lai doc ky tu tiep theo

    stop1:
        ;in thong bao so vua nhap
        mov ah, 9
        lea dx, ms2
        int 21h
        mov al, bh              ;gan so vua nhap vao al
        mov cx, 0               ;khoi tao bien dem cx = 0
        mov bl, 10              ;gan bl = 10 de chuan bi chia lay tung chu so

    ;[LIFO] stack vao sau ra truoc: chia 10 se lay chu so tu PHAI sang TRAI (5, 2, 1)
    ;[LIFO] push lan luot 5, 2, 1 -> khi pop se ra nguoc lai 1, 2, 5 dung thu tu can in
    chiatiep:
        mov ah, 0               ;gan ah = 0 de thuc hien phep chia
        div bl                  ;chia ax cho bl, ket qua trong al, so du trong ah (thuong: al, du: ah)
        cmp al, 0               ;kiem tra xem ket qua co bang 0 khong
        je stop2                ;neu ket qua = 0 thi nhay ra ngoai vong lap (nhan stop2)
        push ax                 ;luu ket qua vao stack
                                ;[LIFO] ah = du = chu so vua tach, duoc day vao dinh stack
        inc cx                  ;tang bien dem cx len 1
        jmp chiatiep            ;quay lai vong lap chia tiep

    stop2:
        push ax                 ;luu ket qua vao stack
                                ;[LIFO] day chu so cuoi cung (hang cao nhat, vd 1) vao dinh stack
        inc cl                  ;tang bien dem cx len 1

    ;[LIFO] pop lay phan tu tren dinh stack truoc: 1 roi 2 roi 5, cx lan lap = so chu so
    inso:
        mov ah, 2               ;ham 2: in ky tu
        pop dx                  ;lay ket qua tu stack vao dx
                                ;[LIFO] pop ra dung phan tu push sau cung, dh = ah luc push = chu so
        mov dl, dh              ;gan ky tu vao dl de in ra man hinh
        add dl, 48              ;doi so thanh ky tu ASCII
        int 21h                 ;goi ham in ky tu
        loop inso                ;lap lai cho den khi cx = 0

        ;xuong dong sau khi in so
        call xuong_dong

        main endp


;ham xuong dong
xuong_dong proc
    push ax
    push dx
    mov ah, 2           ;ham 2: in ky tu
    mov dl, 13          ;ve dau dong (carriage return)
    int 21h
    mov dl, 10          ;xuong dong (line feed)
    int 21h
    pop dx
    pop ax
    ret
xuong_dong endp

end main