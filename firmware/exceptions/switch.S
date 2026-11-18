/* PendSV context switch in the style of the FreeRTOS ARM_CM4F port, and a
 * handler that clobbers the caller-saved FP registers. */
    .syntax unified
    .thumb
    .fpu fpv4-sp-d16
    .text

    .global PendSV_Handler
    .type PendSV_Handler, %function
    .thumb_func
PendSV_Handler:
    mrs     r0, psp
    isb
    ldr     r3, =current_tcb
    ldr     r2, [r3]
    tst     lr, #0x10
    it      eq
    vstmdbeq r0!, {s16-s31}
    stmdb   r0!, {r4-r11, lr}
    str     r0, [r2]                 @ save top of stack in TCB
    stmdb   sp!, {r0, r3}
    mov     r0, #0x50
    msr     basepri, r0              @ configMAX_SYSCALL_INTERRUPT_PRIORITY
    dsb
    isb
    bl      switch_context           @ picks the next task
    mov     r0, #0
    msr     basepri, r0
    ldmia   sp!, {r0, r3}
    ldr     r1, [r3]
    ldr     r0, [r1]
    ldmia   r0!, {r4-r11, lr}
    tst     lr, #0x10
    it      eq
    vldmiaeq r0!, {s16-s31}
    msr     psp, r0
    isb
    bx      lr

    /* Start the first task like vPortStartFirstTask: SVC 0. */
    .global SVC_Handler
    .type SVC_Handler, %function
    .thumb_func
SVC_Handler:
    tst     lr, #4
    ite     eq
    mrseq   r0, msp
    mrsne   r0, psp
    ldr     r1, [r0, #24]            @ stacked PC
    ldrb    r1, [r1, #-2]            @ SVC immediate
    cmp     r1, #0
    bne     svc_other
    ldr     r3, =current_tcb
    ldr     r1, [r3]
    ldr     r0, [r1]
    ldmia   r0!, {r4-r11, lr}
    msr     psp, r0
    isb
    mov     r0, #0
    msr     basepri, r0
    bx      lr
svc_other:
    b       svc_dispatch             @ C handler (r0 = frame, r1 = number)

    /* IRQ 7 handler clobbers S0-S15 without saving them: the hardware FP
     * frame must restore them for the interrupted code. */
    .global IRQ7_Handler
    .type IRQ7_Handler, %function
    .thumb_func
IRQ7_Handler:
    vmov.f32 s0, #-1.0
    vmov.f32 s1, #-1.0
    vmov.f32 s7, #-1.0
    vmov.f32 s15, #-1.0
    vmrs    r0, fpscr
    orr     r0, r0, #0x80000000
    vmsr    fpscr, r0
    ldr     r0, =irq7_count
    ldr     r1, [r0]
    add     r1, r1, #1
    str     r1, [r0]
    bx      lr

    /* Run with live values in s0-s15 while IRQ7 fires; return 1 if intact. */
    .global fp_preserved_across_irq
    .type fp_preserved_across_irq, %function
    .thumb_func
fp_preserved_across_irq:
    vmov.f32 s0, #2.0
    vmov.f32 s1, #3.0
    vmov.f32 s7, #0.5
    vmov.f32 s15, #10.0
    vmrs    r1, fpscr
    bic     r1, r1, #0xF0000000
    vmsr    fpscr, r1
    ldr     r1, =0xE000EF00          @ STIR: pend IRQ 7
    movs    r2, #7
    str     r2, [r1]
    dsb
    isb
    nop
    vmrs    r3, fpscr                @ FPSCR is restored from the FP frame too
    vadd.f32 s0, s0, s1              @ 5
    vadd.f32 s0, s0, s7              @ 5.5
    vadd.f32 s0, s0, s15             @ 15.5
    vmov.f32 s1, #15.5
    vcmp.f32 s0, s1
    vmrs    r1, fpscr
    vmrs    APSR_nzcv, fpscr
    ite     eq
    moveq   r0, #1
    movne   r0, #0
    tst     r3, #0x80000000          @ FPSCR.N set by the IRQ must not leak
    it      ne
    movne   r0, #0
    bx      lr
