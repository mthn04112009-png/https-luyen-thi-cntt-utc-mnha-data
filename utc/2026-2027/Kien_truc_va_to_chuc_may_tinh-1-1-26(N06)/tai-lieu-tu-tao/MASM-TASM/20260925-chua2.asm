.model small
.stack 100h
.data
    ms1 db  'nhap so thu nhat: $'
    ms2 db  10, 13, 'nhap so thu hai: $'
    ms3 db  10, 13, 'tong hai so: $'

.code
main proc
    mov ax, @data ; khoi tao thanh ghi ax
    mov ds, ax ; khoi tao thanh ghi ds
    
    mov ah, 9 ; hien thi thong bao nhap so thu nhat
    lea dx, ms1
    int 21h

; nhap so thu nhat    
    mov ah, 1
    int 21h ; nhap ky tu
    
    sub al, 48  ; doi thanh so
    
    mov bl, 10 ; 
    mul bl      ; ket qua trong ax
    
    mov bx, ax  ; luu tam vao bl/bx
    
    mov ah, 1
    int 21h ; nhap ky tu tiep theo
    sub al, 48
    add bl, al  ; luu so thu nhat
    
    
    mov ah, 9 ; hien thi thong bao nhap so thu hai
    lea dx, ms2 ; 
    int 21h    ; 
    
; nhap so thu 2    
    mov ah, 1
    int 21h
    sub al, 48
    
    mov bh, 10
    mul bh
    
    mov bh, al
    
    mov ah, 1
    int 21h
    sub al, 48
    add bh, al  ; luu so thu 2
    
    
    add bl, bh  ; tong luu trong bl
    
    mov ah, 9 ; hien thi thong bao tong hai so
    lea dx, ms3
    int 21h
    
    mov ah, 0
    mov al, bl
    mov bh, 10
    div bh      ; al: thuong, ah: du
    
    mov bh, ah
    
    mov ah, 2
    mov dl, al
    add dl, 48
    int 21h
    
    mov dl, bh
    add dl, 48
    int 21h
    
    
    mov ah, 4ch
    int 21h
    
    main endp
end main