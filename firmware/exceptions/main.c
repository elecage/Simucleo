/*
 * Exception-model self test for the simulator (cannot be compared with
 * Unicorn, which has no NVIC). Each check stores 1 (pass) or 0 (fail) in
 * `checks[]`; `checks_done` is set to 0xC0FFEE at the end. The Rust test
 * `crates/nucleo/tests/firmware.rs` reads them back.
 */
#include <stdint.h>

#define REG(a) (*(volatile uint32_t *)(a))
#define SYST_CSR REG(0xE000E010)
#define SYST_RVR REG(0xE000E014)
#define SYST_CVR REG(0xE000E018)
#define NVIC_ISER0 REG(0xE000E100)
#define NVIC_IPR(n) (*(volatile uint8_t *)(0xE000E400 + (n)))
#define NVIC_STIR REG(0xE000EF00)
#define SCB_ICSR REG(0xE000ED04)
#define SCB_AIRCR REG(0xE000ED0C)
#define SCB_CCR REG(0xE000ED14)
#define SCB_SHPR2 REG(0xE000ED1C)
#define SCB_SHPR3 REG(0xE000ED20)
#define SCB_SHCSR REG(0xE000ED24)
#define SCB_CFSR REG(0xE000ED28)
#define SCB_HFSR REG(0xE000ED2C)
#define SCB_CPACR REG(0xE000ED88)

enum {
    CHK_SYSTICK, CHK_WFI_WAKE, CHK_SVC_NUMBER, CHK_SVC_RETURN, CHK_PENDSV_MASKED,
    CHK_PENDSV_RUNS, CHK_NESTING, CHK_TAIL_CHAIN, CHK_PRIO_BITS, CHK_PSP_THREAD,
    CHK_EXC_RETURN_PSP, CHK_FP_PRESERVED, CHK_FP_EXC_RETURN, CHK_USAGE_FAULT,
    CHK_HARD_FAULT, CHK_RTOS_INTERLEAVE, CHK_RTOS_FP, CHK_COUNT
};
volatile uint32_t checks[CHK_COUNT];
volatile uint32_t checks_done;

static void check(int id, int ok) { checks[id] = ok ? 1 : 0; }

static inline void set_basepri(uint32_t v) { __asm__ volatile("msr basepri, %0" ::"r"(v) : "memory"); }
static inline void irq_disable(void) { __asm__ volatile("cpsid i" ::: "memory"); }
static inline void irq_enable(void) { __asm__ volatile("cpsie i" ::: "memory"); }
static inline void wfi(void) { __asm__ volatile("wfi"); }
static inline void barrier(void) { __asm__ volatile("dsb\n isb" ::: "memory"); }

/* ------------------------------------------------------------- SysTick */

volatile uint32_t ticks;
void SysTick_Handler(void) { ticks++; }

static void test_systick(void)
{
    SYST_RVR = 999;
    SYST_CVR = 0;
    SYST_CSR = 7; /* processor clock, interrupt, enable */
    uint32_t spins = 0;
    while (ticks < 5)
        spins++;
    check(CHK_SYSTICK, ticks >= 5 && spins > 0);
    uint32_t before = ticks;
    wfi(); /* sleeps until the next tick */
    check(CHK_WFI_WAKE, ticks == before + 1);
    SYST_CSR = 0;
}

/* ----------------------------------------------------------------- SVC */

volatile uint32_t svc_seen;
/* Called from the asm SVC_Handler for SVC numbers other than 0. */
void svc_dispatch(uint32_t *frame, uint32_t number)
{
    svc_seen = number;
    frame[0] = frame[0] * 2 + frame[1]; /* return value in stacked r0 */
}

static uint32_t svc_call(uint32_t a, uint32_t b)
{
    register uint32_t r0 __asm__("r0") = a;
    register uint32_t r1 __asm__("r1") = b;
    __asm__ volatile("svc #42" : "+r"(r0) : "r"(r1) : "memory");
    return r0;
}

static void test_svc(void)
{
    uint32_t r = svc_call(20, 2);
    check(CHK_SVC_NUMBER, svc_seen == 42);
    check(CHK_SVC_RETURN, r == 42);
}

/* ------------------------------------------- PendSV, BASEPRI, priorities */

volatile uint32_t pendsv_count;
volatile int use_rtos_pendsv;
void pendsv_simple(void) { pendsv_count++; }

static void test_pendsv_basepri(void)
{
    SCB_SHPR3 = (SCB_SHPR3 & 0xFF00FFFF) | (0xF0u << 16); /* PendSV lowest */
    NVIC_IPR(0) = 0xFF;
    check(CHK_PRIO_BITS, NVIC_IPR(0) == 0xF0); /* 4 implemented bits */
    NVIC_IPR(0) = 0;

    set_basepri(0x50);
    SCB_ICSR = 1u << 28; /* PENDSVSET */
    barrier();
    int masked = pendsv_count == 0 && (SCB_ICSR & (1u << 28));
    set_basepri(0);
    barrier();
    check(CHK_PENDSV_MASKED, masked);
    check(CHK_PENDSV_RUNS, pendsv_count == 1);
}

/* ------------------------------------------------ nesting, tail-chaining */

volatile uint32_t order[8];
volatile uint32_t order_n;
static void log_irq(uint32_t n) { order[order_n++ & 7] = n; }

void IRQ5_Handler(void)
{
    log_irq(5);
    NVIC_STIR = 6; /* higher priority: preempts immediately */
    barrier();
    log_irq(50);
}
void IRQ6_Handler(void) { log_irq(6); }
volatile uint32_t irq7_count;

static void test_nesting(void)
{
    NVIC_IPR(5) = 0xA0;
    NVIC_IPR(6) = 0x40;
    NVIC_IPR(7) = 0x80;
    NVIC_ISER0 = (1u << 5) | (1u << 6) | (1u << 7);
    order_n = 0;
    NVIC_STIR = 5;
    barrier();
    check(CHK_NESTING, order_n == 3 && order[0] == 5 && order[1] == 6 && order[2] == 50);

    /* Pend both with interrupts masked: the higher priority one runs first,
     * the other is tail-chained. */
    order_n = 0;
    irq_disable();
    NVIC_STIR = 5;
    NVIC_STIR = 6;
    irq_enable();
    barrier();
    /* IRQ6 first, then IRQ5 (which pends IRQ6 again and is preempted) */
    check(CHK_TAIL_CHAIN, order_n == 4 && order[0] == 6 && order[1] == 5 && order[2] == 6 && order[3] == 50);
}

/* --------------------------------------------------- PSP and EXC_RETURN */

volatile uint32_t last_exc_return;
void IRQ8_Handler(void)
{
    uint32_t lr;
    __asm__ volatile("mov %0, lr" : "=r"(lr));
    last_exc_return = lr;
}

static uint32_t psp_stack[64];

static void test_psp(void)
{
    uint32_t msp_before;
    __asm__ volatile("mrs %0, msp" : "=r"(msp_before));
    uint32_t top = (uint32_t)&psp_stack[64];
    __asm__ volatile("msr psp, %0\n mov r0, #2\n msr control, r0\n isb" ::"r"(top) : "r0", "memory");
    uint32_t sp_now;
    __asm__ volatile("mov %0, sp" : "=r"(sp_now));
    NVIC_ISER0 = 1u << 8;
    NVIC_STIR = 8;
    barrier();
    uint32_t msp_after;
    __asm__ volatile("mrs %0, msp" : "=r"(msp_after));
    /* back to MSP */
    __asm__ volatile("mov r0, #0\n msr control, r0\n isb" ::: "r0", "memory");
    check(CHK_PSP_THREAD, sp_now <= top && sp_now > top - 64 && msp_after == msp_before);
    check(CHK_EXC_RETURN_PSP, (last_exc_return & 0xF) == 0xD);
}

/* ------------------------------------------------------------ FP context */

extern int fp_preserved_across_irq(void);

static void test_fp_context(void)
{
    volatile float x = 1.25f;
    x = x * 2.0f; /* sets CONTROL.FPCA */
    check(CHK_FP_PRESERVED, fp_preserved_across_irq() && irq7_count == 1);
    NVIC_STIR = 8;
    barrier();
    check(CHK_FP_EXC_RETURN, (last_exc_return & 0x1F) == 0x09); /* FP frame: bit4 = 0 */
}

/* ---------------------------------------------------------------- faults */

volatile uint32_t usage_cfsr, hard_hfsr;

/* Skip the faulting 16- or 32-bit instruction on return. */
static void skip_instruction(uint32_t *frame)
{
    uint16_t hw = *(uint16_t *)frame[6];
    frame[6] += (hw >> 11) >= 0x1D ? 4 : 2;
}

__attribute__((naked)) void UsageFault_Handler(void)
{
    __asm__ volatile("tst lr, #4\n ite eq\n mrseq r0, msp\n mrsne r0, psp\n b usage_fault_c");
}
void usage_fault_c(uint32_t *frame)
{
    usage_cfsr = SCB_CFSR;
    SCB_CFSR = usage_cfsr; /* write-1-to-clear */
    skip_instruction(frame);
}

__attribute__((naked)) void HardFault_Handler(void)
{
    __asm__ volatile("tst lr, #4\n ite eq\n mrseq r0, msp\n mrsne r0, psp\n b hard_fault_c");
}
void hard_fault_c(uint32_t *frame)
{
    hard_hfsr = SCB_HFSR;
    SCB_HFSR = hard_hfsr;
    SCB_CFSR = SCB_CFSR;
    skip_instruction(frame);
}

static void test_faults(void)
{
    SCB_CCR |= 1u << 4;      /* DIV_0_TRP */
    SCB_SHCSR |= 1u << 18;   /* USGFAULTENA */
    volatile uint32_t zero = 0, n = 100, q = 7;
    q = n / zero;
    (void)q; /* the skipped UDIV leaves q compiler-dependent */
    check(CHK_USAGE_FAULT, usage_cfsr & (1u << 25));

    SCB_SHCSR &= ~(1u << 18); /* now escalates to HardFault */
    __asm__ volatile("udf #3");
    check(CHK_HARD_FAULT, hard_hfsr & (1u << 30));
    SCB_CCR &= ~(1u << 4);
}

/* -------------------------------------------- mini RTOS (FreeRTOS-like) */

typedef struct { uint32_t *top; } tcb_t;
static tcb_t tasks[2];
tcb_t *current_tcb;
static uint32_t stacks[2][256] __attribute__((aligned(8)));
volatile uint32_t trace[16];
volatile uint32_t trace_n;
volatile float task_fp[2];

void switch_context(void) { current_tcb = current_tcb == &tasks[0] ? &tasks[1] : &tasks[0]; }

static void yield(void) { SCB_ICSR = 1u << 28; barrier(); }

static void task(uint32_t id)
{
    float f = (float)(id + 1);
    for (int i = 0; i < 4; i++) {
        trace[trace_n++ & 15] = id;
        f = f * 1.5f + 0.25f; /* keeps FP state live across switches */
        yield();
    }
    task_fp[id] = f;
    for (;;)
        yield();
}

static void task0(void) { task(0); }
static void task1(void) { task(1); }

/* Build an initial stack exactly like pxPortInitialiseStack. */
static uint32_t *init_stack(uint32_t *top, void (*fn)(void))
{
    *--top = 1u << 24;            /* xPSR: Thumb */
    *--top = (uint32_t)fn;        /* PC */
    *--top = 0xFFFFFFFD;          /* LR */
    top -= 5;                     /* R12, R3, R2, R1, R0 */
    *--top = 0xFFFFFFFD;          /* EXC_RETURN: thread, PSP, no FP frame */
    top -= 8;                     /* R11..R4 */
    return top;
}

void IRQ9_Handler(void) {}

static void test_rtos(void)
{
    tasks[0].top = init_stack(&stacks[0][256], task0);
    tasks[1].top = init_stack(&stacks[1][256], task1);
    current_tcb = &tasks[0];
    use_rtos_pendsv = 1;
    SCB_SHPR2 = 0x00u << 24; /* SVCall highest */
    SYST_RVR = 1999;
    SYST_CVR = 0;
    SYST_CSR = 7;
    __asm__ volatile("cpsie i\n svc #0");
    /* not reached: the tasks never return */
}

/* The rest of the checks run from task context once both tasks finished. */
static void finish(void)
{
    int interleaved = trace_n >= 8;
    for (int i = 0; i < 8; i++)
        interleaved &= trace[i] == (uint32_t)(i & 1);
    check(CHK_RTOS_INTERLEAVE, interleaved);
    float expect[2];
    for (int id = 0; id < 2; id++) {
        float f = (float)(id + 1);
        for (int i = 0; i < 4; i++)
            f = f * 1.5f + 0.25f;
        expect[id] = f;
    }
    check(CHK_RTOS_FP, task_fp[0] == expect[0] && task_fp[1] == expect[1]);
    checks_done = 0xC0FFEE;
}

/* SysTick re-enabled during the RTOS phase ends the test after both tasks
 * have produced their results. */
void rtos_tick(void)
{
    if (task_fp[0] != 0.0f && task_fp[1] != 0.0f && checks_done == 0)
        finish();
}

int main(void)
{
    test_systick();
    test_svc();
    test_pendsv_basepri();
    test_nesting();
    test_psp();
    test_fp_context();
    test_faults();
    test_rtos();
    for (;;)
        ;
}

/* ------------------------------------------------- startup + vectors */

extern uint32_t _estack, _sidata, _sdata, _edata, _sbss, _ebss;
void Reset_Handler(void);
void PendSV_Handler(void);
void SVC_Handler(void);
void IRQ7_Handler(void);
void Default_Handler(void) { for (;;) {} }

/* PendSV: before the RTOS phase, a simple counter; afterwards, the
 * FreeRTOS-style switcher in switch.S. */
__attribute__((naked)) void PendSV_Entry(void)
{
    __asm__ volatile(
        "ldr r0, =use_rtos_pendsv\n"
        "ldr r0, [r0]\n"
        "cbz r0, 1f\n"
        "b PendSV_Handler\n"
        "1: push {r4, lr}\n"
        "bl pendsv_simple\n"
        "pop {r4, pc}\n");
}

void SysTick_Entry(void)
{
    SysTick_Handler();
    if (use_rtos_pendsv)
        rtos_tick();
}

__attribute__((section(".isr_vector"), used))
static void (*const vectors[16 + 10])(void) = {
    (void (*)(void))&_estack,
    Reset_Handler,
    Default_Handler,      /* NMI */
    HardFault_Handler,
    Default_Handler,      /* MemManage */
    Default_Handler,      /* BusFault */
    UsageFault_Handler,
    0, 0, 0, 0,
    SVC_Handler,
    0, 0,
    PendSV_Entry,
    SysTick_Entry,
    Default_Handler, Default_Handler, Default_Handler, Default_Handler, Default_Handler,
    IRQ5_Handler, IRQ6_Handler, IRQ7_Handler, IRQ8_Handler, IRQ9_Handler,
};

void Reset_Handler(void)
{
    uint32_t *src = &_sidata, *dst = &_sdata;
    while (dst < &_edata)
        *dst++ = *src++;
    for (dst = &_sbss; dst < &_ebss;)
        *dst++ = 0;
    SCB_CPACR |= 0xFu << 20;
    barrier();
    main();
    for (;;) {}
}
