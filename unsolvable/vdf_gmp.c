/* vdf_gmp.c — GMP helper for the Wesolowski VDF in vdf.js.
 *
 * Usage:
 *   vdf-gmp square <xHex> <nHex> <T>          -> y = x^(2^T) mod N   (hex, stdout)
 *   vdf-gmp proof  <xHex> <nHex> <T> <lHex>   -> pi = x^floor(2^T/l) mod N
 *
 * The proof loop uses the incremental quotient-tracking recurrence:
 *   r_i = 2^i mod l, pi_i = x^floor(2^i/l) mod N
 *   pi_{i+1} = pi_i^2 * x^b mod N, where b = 1 iff 2*r_i >= l, r_{i+1} = 2*r_i - b*l
 * so the proof costs one squaring per step, no million-bit exponentiation.
 *
 * Build: gcc -O3 -I/usr/include/x86_64-linux-gnu -o vdf-gmp vdf_gmp.c -lgmp
 */
#include <gmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void die(const char *msg) {
    fprintf(stderr, "vdf-gmp: %s\n", msg);
    exit(1);
}

int main(int argc, char **argv) {
    if (argc < 5) die("usage: vdf-gmp square <xHex> <nHex> <T> | proof <xHex> <nHex> <T> <lHex>");
    int is_proof = 0;
    if (strcmp(argv[1], "square") == 0) is_proof = 0;
    else if (strcmp(argv[1], "proof") == 0) is_proof = 1;
    else die("first arg must be 'square' or 'proof'");
    if (is_proof && argc < 6) die("proof mode needs <lHex>");

    mpz_t x, N, l, y, pi, r, tmp, two_r;
    mpz_inits(x, N, l, y, pi, r, tmp, two_r, NULL);

    if (mpz_set_str(x, argv[2], 16) != 0) die("bad x hex");
    if (mpz_set_str(N, argv[3], 16) != 0) die("bad N hex");
    char *end = NULL;
    unsigned long long T = strtoull(argv[4], &end, 10);
    if (end == argv[4] || *end != '\0') die("bad T");
    if (mpz_sgn(N) <= 0) die("N must be positive");
    mpz_mod(x, x, N);

    if (!is_proof) {
        /* y = x^(2^T) mod N : T sequential squarings */
        mpz_set(y, x);
        for (unsigned long long i = 0; i < T; i++) {
            mpz_mul(tmp, y, y);
            mpz_mod(y, tmp, N);
        }
        char *s = mpz_get_str(NULL, 16, y);
        printf("%s\n", s);
        free(s);
    } else {
        if (mpz_set_str(l, argv[5], 16) != 0) die("bad l hex");
        if (mpz_sgn(l) <= 0) die("l must be positive");
        mpz_set_ui(pi, 1);
        mpz_set_ui(r, 1);
        mpz_mod(r, r, l);
        for (unsigned long long i = 0; i < T; i++) {
            mpz_mul_ui(two_r, r, 2);
            int b = (mpz_cmp(two_r, l) >= 0);
            if (b) mpz_sub(r, two_r, l);
            else mpz_set(r, two_r);
            mpz_mul(tmp, pi, pi);
            mpz_mod(pi, tmp, N);
            if (b) {
                mpz_mul(tmp, pi, x);
                mpz_mod(pi, tmp, N);
            }
        }
        char *s = mpz_get_str(NULL, 16, pi);
        printf("%s\n", s);
        free(s);
    }
    mpz_clears(x, N, l, y, pi, r, tmp, two_r, NULL);
    return 0;
}
