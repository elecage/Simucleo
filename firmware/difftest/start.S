/* Entry for lock-step tests: no vector table, no system registers (Unicorn
 * has no NVIC/SCB), just copy .data, clear .bss, run, and stop at `done`. */
    .syntax unified
    .thumb
    .section .text.start, "ax"
    .global _start
    .global done
    .type _start, %function
    .thumb_func
_start:
    ldr  r0, =_sidata
    ldr  r1, =_sdata
    ldr  r2, =_edata
1:  cmp  r1, r2
    itt  lo
    ldrlo r3, [r0], #4
    strlo r3, [r1], #4
    blo  1b
    ldr  r1, =_sbss
    ldr  r2, =_ebss
    movs r3, #0
2:  cmp  r1, r2
    itt  lo
    strlo r3, [r1], #4
    blo  2b
    bl   run_tests
    .thumb_func
done:
    b    done
