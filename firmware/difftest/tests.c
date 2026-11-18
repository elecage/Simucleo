/*
 * Workloads for lock-step CPU comparison. Every result is stored in
 * `results`, and Unicorn and the Rust core must agree on every register
 * after every instruction. The mix aims at broad instruction coverage:
 * integer ALU, shifts, 64-bit math through libgcc, division, bit
 * manipulation, table branches, block copies, DSP intrinsics and
 * single-precision floating point (double precision runs in software).
 */
#include <arm_acle.h>
#include <stdint.h>

/* Intrinsics that GCC's arm_acle.h does not provide (CMSIS style). */
static inline uint32_t rbit(uint32_t x) { uint32_t r; __asm__("rbit %0, %1" : "=r"(r) : "r"(x)); return r; }
static inline uint32_t rev16(uint32_t x) { uint32_t r; __asm__("rev16 %0, %1" : "=r"(r) : "r"(x)); return r; }
static inline int32_t revsh(int32_t x) { int32_t r; __asm__("revsh %0, %1" : "=r"(r) : "r"(x)); return r; }
static inline int32_t smulwt(int32_t a, int32_t b) { int32_t r; __asm__("smulwt %0, %1, %2" : "=r"(r) : "r"(a), "r"(b)); return r; }
static inline int32_t smmla(int32_t a, int32_t b, int32_t c)
{ int32_t r; __asm__("smmla %0, %1, %2, %3" : "=r"(r) : "r"(a), "r"(b), "r"(c)); return r; }
#define pkhbt(a, b, s) ({ uint32_t r_; __asm__("pkhbt %0, %1, %2, lsl %3" : "=r"(r_) : "r"(a), "r"(b), "I"(s)); r_; })
#define pkhtb(a, b, s) ({ uint32_t r_; __asm__("pkhtb %0, %1, %2, asr %3" : "=r"(r_) : "r"(a), "r"(b), "I"(s)); r_; })
static inline uint32_t get_apsr(void) { uint32_t r; __asm__ volatile("mrs %0, APSR" : "=r"(r)); return r; }

#define N_RESULTS 256
volatile uint32_t results[N_RESULTS];
static unsigned result_idx;

static void put(uint32_t v) { results[result_idx++ % N_RESULTS] = v; }
static void putf(float f) { union { float f; uint32_t u; } x = { f }; put(x.u); }

static uint32_t rng_state = 0x12345678u;
static uint32_t rnd(void)
{
    uint32_t x = rng_state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    return rng_state = x;
}

/* ------------------------------------------------------------ integer */

static uint32_t crc32(const uint8_t *p, unsigned n)
{
    uint32_t crc = 0xFFFFFFFFu;
    while (n--) {
        crc ^= *p++;
        for (int k = 0; k < 8; k++)
            crc = (crc >> 1) ^ (0xEDB88320u & -(crc & 1));
    }
    return ~crc;
}

static void insertion_sort(int32_t *a, unsigned n)
{
    for (unsigned i = 1; i < n; i++) {
        int32_t v = a[i];
        unsigned j = i;
        while (j > 0 && a[j - 1] > v) {
            a[j] = a[j - 1];
            j--;
        }
        a[j] = v;
    }
}

static void quicksort(int16_t *a, int lo, int hi)
{
    if (lo >= hi)
        return;
    int16_t p = a[(lo + hi) / 2];
    int i = lo, j = hi;
    while (i <= j) {
        while (a[i] < p) i++;
        while (a[j] > p) j--;
        if (i <= j) {
            int16_t t = a[i]; a[i] = a[j]; a[j] = t;
            i++; j--;
        }
    }
    quicksort(a, lo, j);
    quicksort(a, i, hi);
}

static unsigned fib(unsigned n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }

static void test_integer(void)
{
    static uint8_t buf[256];
    for (unsigned i = 0; i < sizeof buf; i++)
        buf[i] = (uint8_t)rnd();
    put(crc32(buf, sizeof buf));

    int32_t a[24];
    for (unsigned i = 0; i < 24; i++)
        a[i] = (int32_t)rnd();
    insertion_sort(a, 24);
    for (unsigned i = 0; i < 24; i += 6)
        put((uint32_t)a[i]);

    int16_t h[40];
    for (unsigned i = 0; i < 40; i++)
        h[i] = (int16_t)rnd();
    quicksort(h, 0, 39);
    put((uint16_t)h[0] | ((uint32_t)(uint16_t)h[39] << 16));

    put(fib(12));

    for (int i = 0; i < 12; i++) {
        int32_t x = (int32_t)rnd(), y = (int32_t)(rnd() >> (i + 8)) | 1;
        uint32_t ux = rnd(), uy = (rnd() >> i) | 1;
        put((uint32_t)(x / y));
        put((uint32_t)(x % y));
        put(ux / uy);
        put(ux % uy);
        put((uint32_t)((int64_t)x * y >> 32));
        put((uint32_t)((uint64_t)ux * uy >> 32));
        uint64_t big = ((uint64_t)rnd() << 32) | rnd();
        put((uint32_t)(big / (uy | 0x100)));
        put((uint32_t)((int64_t)big >> (i + 3)));
        put((uint32_t)(big << (i * 5 % 64) >> 32));
        put((uint32_t)__builtin_clz(ux | 1) | (uint32_t)__builtin_ctz(uy) << 8 | (uint32_t)__builtin_popcount(ux) << 16);
        put(__builtin_bswap32(ux) ^ rbit(uy) ^ rev16(ux) ^ (uint32_t)revsh((int16_t)uy));
        put((ux << (i & 31)) | (ux >> ((32 - i) & 31)));
        put((uint32_t)(x >> (i + 1)) ^ (ux >> (i + 1)));
        put((uint32_t)(x < y) | (uint32_t)(ux < uy) << 1 | (uint32_t)(x == (int32_t)ux) << 2 | (uint32_t)(x >= 0) << 3);
    }
}

/* Bit-fields: BFI, UBFX, SBFX. */
struct packed {
    unsigned a : 3;
    signed b : 7;
    unsigned c : 12;
    signed d : 10;
};

static void test_bitfields(void)
{
    struct packed p = { 0 };
    for (int i = 0; i < 16; i++) {
        uint32_t r = rnd();
        p.a = r;
        p.b = (int)(r >> 3);
        p.c += r >> 10;
        p.d -= (int)(r >> 22);
        put(p.a + (uint32_t)p.b * 7u + p.c * 13u + (uint32_t)p.d * 17u);
    }
}

/* Dense switch → TBB/TBH. */
static uint32_t dispatch(unsigned op, uint32_t a, uint32_t b)
{
    switch (op) {
    case 0: return a + b;
    case 1: return a - b;
    case 2: return a * b;
    case 3: return a & b;
    case 4: return a | b;
    case 5: return a ^ b;
    case 6: return a << (b & 31);
    case 7: return a >> (b & 31);
    case 8: return (uint32_t)((int32_t)a >> (b & 31));
    case 9: return ~a;
    case 10: return a > b ? a : b;
    case 11: return a < b ? a : b;
    case 12: return a == b;
    case 13: return (a + b) >> 1;
    case 14: return a * 3 + b * 5;
    case 15: return a ^ (b << 7);
    case 16: return a - (b >> 3);
    case 17: return a | (b << 4);
    case 18: return (a << 3) - a;
    case 19: return a + 0x1234;
    default: return 0xDEADBEEF;
    }
}

static void test_switch(void)
{
    uint32_t acc = 0;
    for (unsigned i = 0; i < 64; i++)
        acc = dispatch(rnd() % 22, acc ^ rnd(), rnd());
    put(acc);
}

/* Block copies: LDM/STM, LDRD/STRD, byte loops. */
struct big { uint32_t w[9]; uint16_t h; uint8_t b[3]; };

static void copy_bytes(uint8_t *d, const uint8_t *s, unsigned n)
{
    while (n--)
        *d++ = *s++;
}

static void test_memory(void)
{
    struct big x, y;
    for (unsigned i = 0; i < 9; i++)
        x.w[i] = rnd();
    x.h = (uint16_t)rnd();
    x.b[0] = 1; x.b[1] = 2; x.b[2] = 3;
    y = x;
    y.w[3] ^= y.w[5];
    put(y.w[3] + y.h + y.b[2]);

    static uint8_t src[67], dst[67];
    for (unsigned i = 0; i < sizeof src; i++)
        src[i] = (uint8_t)(i * 7);
    copy_bytes(dst + 1, src + 3, 60); /* unaligned */
    uint32_t sum = 0;
    for (unsigned i = 0; i < sizeof dst; i++)
        sum = sum * 31 + dst[i];
    put(sum);

    /* unaligned word and halfword access */
    uint32_t u;
    __builtin_memcpy(&u, dst + 3, 4);
    put(u);
    put(*(volatile uint16_t *)(void *)(dst + 5));
}

/* ------------------------------------------------------------ DSP */

static void test_dsp(void)
{
    for (int i = 0; i < 16; i++) {
        uint32_t a = rnd(), b = rnd(), c = rnd();
        put(__ssat((int32_t)a >> 4, 16) ^ __usat((int32_t)b >> 8, 12));
        put((uint32_t)__qadd((int32_t)a, (int32_t)b) ^ (uint32_t)__qsub((int32_t)a, (int32_t)c));
        put(__sadd16(a, b) ^ __usub8(a, c));
        put(__sel(a, b)); /* depends on GE from the previous op */
        put(__uqadd8(a, b) ^ __qsub16(a, b) ^ __shadd8(a, b) ^ __uhsub16(a, c));
        put(__sasx(a, b) ^ __usax(b, c));
        put((uint32_t)__smlad(a, b, c) ^ (uint32_t)__smuad(a, c));
        put((uint32_t)__smusdx(a, b));
        put(__usad8(a, b) + __usada8(a, c, 7));
        put(__uxtab16(a, b) ^ __sxtb16(c));
        put((uint32_t)__smlabb((int32_t)a, (int32_t)b, (int32_t)c) ^ (uint32_t)smulwt((int32_t)a, (int32_t)b));
        put((uint32_t)smmla((int32_t)a, (int32_t)b, (int32_t)c));
        uint64_t acc = ((uint64_t)a << 32) | b;
        acc = __smlald(c, a, acc);
        put((uint32_t)acc ^ (uint32_t)(acc >> 32));
        put(__ssat16(a, 9) ^ __usat16(b, 7));
        put(pkhbt(a, b, 8) ^ pkhtb(a, c, 4));
        put(get_apsr() & 0xF80F0000u); /* Q and GE */
    }
}

/* ------------------------------------------------------------ float */

static float poly(float x)
{
    return ((0.25f * x - 1.5f) * x + 2.0f) * x - 0.125f;
}

static void test_float(void)
{
    float acc = 0.0f;
    for (int i = 0; i < 24; i++) {
        float x = (float)(int32_t)rnd() / 65536.0f;
        float y = (float)(rnd() & 0xFFFF) / 1024.0f + 0.5f;
        acc += poly(x) / y;
        putf(x * y);
        putf(x / y);
        putf(__builtin_sqrtf(__builtin_fabsf(x)));
        putf(__builtin_fmaf(x, y, acc));
        putf(-x * y + acc);
        put((uint32_t)(int32_t)(x * 3.0f));
        put((uint32_t)(y * 100.0f));
        put((x < y) | (x == y) << 1 | (x > acc) << 2);
        __fp16 h = (__fp16)x;
        putf((float)h);
    }
    putf(acc);

    /* specials: infinities, NaN, signed zero, denormals */
    volatile float zero = 0.0f, one = 1.0f, tiny = 1e-38f;
    putf(one / zero);
    putf(zero / zero);
    putf(-zero);
    putf(tiny * 1e-5f);
    putf(tiny / 3.0f);
    put((uint32_t)(int32_t)(one / zero));

    /* software double precision through libgcc */
    double d = 1.0;
    for (int i = 1; i < 8; i++)
        d = d * 1.5 + 1.0 / i;
    union { double d; uint64_t u; } du = { d };
    put((uint32_t)du.u);
    put((uint32_t)(du.u >> 32));
}

/* ------------------------------------------------------------ asm */

extern uint32_t asm_exclusive(uint32_t *p, uint32_t v);
extern uint32_t asm_it_blocks(uint32_t a, uint32_t b);
extern uint32_t asm_long_mul(uint32_t a, uint32_t b, uint32_t c, uint32_t d);
extern uint32_t asm_fixed_point(float f);
extern uint32_t asm_misc(uint32_t a, uint32_t b);

static void test_asm(void)
{
    static uint32_t word;
    for (int i = 0; i < 8; i++) {
        uint32_t a = rnd(), b = rnd(), c = rnd(), d = rnd();
        put(asm_exclusive(&word, a));
        put(asm_it_blocks(a, b));
        put(asm_long_mul(a, b, c, d));
        put(asm_fixed_point((float)(int32_t)a / 1e6f));
        put(asm_misc(a, b));
    }
    put(word);
}

void run_tests(void)
{
    test_integer();
    test_bitfields();
    test_switch();
    test_memory();
    test_dsp();
    test_float();
    test_asm();
}
