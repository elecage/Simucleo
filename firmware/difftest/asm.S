/* Hand-written sequences for encodings the compiler rarely emits. */
    .syntax unified
    .thumb
    .fpu fpv4-sp-d16
    .text

/* uint32_t asm_exclusive(uint32_t *p, uint32_t v) */
    .global asm_exclusive
    .thumb_func
asm_exclusive:
    push    {r4, lr}
    ldrex   r2, [r0]
    add     r2, r2, r1
    strex   r3, r2, [r0]          @ succeeds: r3 = 0
    ldrex   r4, [r0]
    clrex
    strex   r12, r1, [r0]         @ fails after CLREX: r12 = 1
    ldrexb  r2, [r0]
    strexb  lr, r2, [r0]
    ldrexh  r2, [r0]
    strexh  r1, r2, [r0]
    orr     r0, r3, r12, lsl #1
    orr     r0, r0, lr, lsl #2
    orr     r0, r0, r1, lsl #3
    add     r0, r0, r4
    pop     {r4, pc}

/* uint32_t asm_it_blocks(uint32_t a, uint32_t b) */
    .global asm_it_blocks
    .thumb_func
asm_it_blocks:
    movs    r2, #0
    cmp     r0, r1
    ite     hi
    addhi   r2, #1
    addls   r2, #2
    itt     cc
    lslcc   r2, r2, #3
    addcc   r2, #4               @ 16-bit forms in IT do not set flags
    cmp     r0, #0
    itete   mi
    eormi   r2, r2, #0x10
    eorpl   r2, r2, #0x20
    orrmi   r2, r2, #0x40
    orrpl   r2, r2, #0x80
    tst     r1, #1
    itttt   ne
    movne   r3, #7
    mulne   r2, r2, r3
    addne   r2, r2, r0, lsr #28
    subsne  r2, r2, #1           @ 32-bit flag-setting inside IT
    it      eq
    moveq   r2, #99
    cmp     r1, r0
    ite     ge
    addge   r2, r2, #0x100
    addlt   r2, r2, #0x200
    ite     gt
    addgt   r2, r2, #0x400
    addle   r2, r2, #0x800
    cmn     r0, r1
    ite     vs
    addvs   r2, r2, #0x1000
    addvc   r2, r2, #0x2000
    cbz     r2, 1f
    add     r2, r2, #0x10000
1:  cbnz    r2, 2f
    nop
2:  mov     r0, r2
    bx      lr

/* uint32_t asm_long_mul(a, b, c, d) */
    .global asm_long_mul
    .thumb_func
asm_long_mul:
    push    {r4-r8, lr}
    umull   r4, r5, r0, r1
    smull   r6, r7, r2, r3
    umlal   r4, r5, r2, r3
    smlal   r6, r7, r0, r1
    umaal   r4, r6, r1, r2
    smlalbb r4, r7, r0, r3
    smlaltb r5, r6, r1, r2
    smlald  r4, r5, r2, r3
    smlsldx r6, r7, r0, r1
    orr     r8, r1, #1
    udiv    r12, r0, r8
    sdiv    lr, r2, r8
    mls     r12, r12, r8, r0
    movs    r8, #0
    udiv    r8, r0, r8           @ divide by zero → 0 (trap disabled)
    mvn     r1, #0x80000000      @ 0x7FFFFFFF
    adds    r1, r1, #1           @ INT_MIN
    mov     r3, #-1
    sdiv    r3, r1, r3           @ INT_MIN / -1 → INT_MIN
    eor     r0, r4, r5
    eor     r0, r0, r6
    add     r0, r0, r7
    add     r0, r0, r12
    eor     r0, r0, lr
    add     r0, r0, r8
    eor     r0, r0, r3
    smmul   r1, r0, r2
    smmulr  r3, r0, r2
    smmls   r1, r1, r2, r3
    smulbt  r3, r0, r1
    smlawb  r1, r0, r1, r3
    smlsd   r3, r0, r1, r2
    add     r0, r0, r1
    eor     r0, r0, r3
    pop     {r4-r8, pc}

/* uint32_t asm_fixed_point(float f)   (f in s0) */
    .global asm_fixed_point
    .thumb_func
asm_fixed_point:
    vpush   {s16-s19}
    vmov.f32 s16, s0
    vmov.f32 s1, s0
    vcvt.s32.f32 s1, s1, #16
    vmov.f32 s2, s0
    vcvt.u16.f32 s2, s2, #3
    vmov    s3, r0
    vcvt.f32.s32 s3, s3, #8
    vcvtr.s32.f32 s4, s0
    vcvt.u32.f32 s5, s0
    vcvtb.f16.f32 s6, s0
    vcvtt.f16.f32 s6, s3
    vcvtb.f32.f16 s7, s6
    vcvtt.f32.f16 s8, s6
    vmov.f32 s9, #1.5
    vmov.f32 s10, #-0.125
    vnmla.f32 s9, s16, s10
    vnmls.f32 s10, s16, s9
    vfnma.f32 s17, s9, s10
    vfms.f32 s17, s16, s16
    vmls.f32 s18, s9, s10
    vnmul.f32 s19, s9, s16
    vabs.f32 s11, s16
    vneg.f32 s12, s11
    vsqrt.f32 s13, s11
    vdiv.f32 s14, s12, s9
    vcmpe.f32 s16, s9
    vmrs    APSR_nzcv, fpscr
    ite     gt
    vmovgt.f32 s15, s13
    vmovle.f32 s15, s14
    vcmp.f32 s16, #0
    vmrs    r1, fpscr
    vmov    r2, r3, s1, s2
    vmov    s20, s21, r3, r2
    sub     sp, sp, #32
    vstmia  sp, {s1-s8}
    vldmia  sp!, {s20-s27}
    vstr    s27, [sp, #-4]
    vldr    s28, [sp, #-4]
    vmov    r0, s28
    vmov    r12, s15
    eor     r0, r0, r12
    vmov    r12, s17
    eor     r0, r0, r12
    vmov    r12, s18
    add     r0, r0, r12
    vmov    r12, s19
    eor     r0, r0, r12
    vmov    r12, s21
    add     r0, r0, r12
    eor     r0, r0, r1
    vmov    r12, s5
    add     r0, r0, r12
    vmov    r12, s4
    eor     r0, r0, r12, ror #3
    vpop    {s16-s19}
    bx      lr

/* uint32_t asm_misc(uint32_t a, uint32_t b) */
    .global asm_misc
    .thumb_func
asm_misc:
    push.w  {r4-r7, lr}
    and     r2, r0, #7
    tbb     [pc, r2]
1:  .byte   (c0-1b)/2, (c1-1b)/2, (c2-1b)/2, (c3-1b)/2, (c4-1b)/2, (c5-1b)/2, (c6-1b)/2, (c7-1b)/2
c0: rrx     r3, r1
    b       9f
c1: adds    r3, r0, r1
    adcs    r3, r3, r1, lsl #3
    b       9f
c2: subs    r3, r0, r1
    sbcs    r3, r3, #0x100
    b       9f
c3: rsb     r3, r1, #0x1000
    orn     r3, r3, r0, asr #5
    b       9f
c4: teq     r0, r1
    mrs     r3, APSR
    b       9f
c5: mvn     r3, r0, ror #11
    bfc     r3, #4, #12
    b       9f
c6: sxtah   r3, r0, r1, ror #8
    uxtab   r3, r3, r1, ror #16
    b       9f
c7: clz     r3, r1
    cmn     r3, r0
    b       9f
9:  and     r2, r1, #3
    tbh     [pc, r2, lsl #1]
2:  .hword  (d0-2b)/2, (d1-2b)/2, (d2-2b)/2, (d3-2b)/2
d0: eor     r3, r3, #0x55
    b       8f
d1: lsls    r3, r3, #1
    b       8f
d2: asrs    r3, r3, #2
    b       8f
d3: lsrs    r3, r3, #3
8:  sub     sp, sp, #16
    strd    r0, r1, [sp, #8]!
    ldrd    r4, r5, [sp], #-8
    strb    r3, [sp, #3]
    ldrsb   r6, [sp, #3]
    mov     r12, sp
    strh    r0, [r12, #2]!       @ pre-indexed writeback (on a GPR: SP must stay aligned)
    ldrsh   r7, [r12], #-2
    stmdb   sp!, {r3, r6, r7}
    ldmia   sp!, {r4, r5, r6}
    add     sp, sp, #16
    msr     APSR_nzcvq, r0
    mrs     r2, APSR
    eor     r0, r4, r5
    add     r0, r0, r6
    eor     r0, r0, r7
    add     r0, r0, r2
    pop.w   {r4-r7, pc}
