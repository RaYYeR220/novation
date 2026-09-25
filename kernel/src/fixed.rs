//! WAD (1e18) fixed-point math, bit-exact with `FixedPointMath.sol`.
//!
//! Two numeric backends implement [`Num`] with identical results:
//! * `I256`: Solidity 0.8 semantics (checked arithmetic, `/` truncating toward
//!   zero, unchecked `int256(uint256)` casts). This is the reference path.
//! * `i128`: the fast path. Products are split into base-1e9 digits so every
//!   partial product fits in a u64, and 128/64 quotients use a two-step long
//!   division, because wasm32 has no 64x64->128 multiply and i128 `*`/`/` are
//!   software routines. Any value that leaves the range it handles exactly
//!   makes it return an error, and the caller redoes the call on `I256`.
//!
//! The exp/ln/cdf series only ever see small operands, so both backends share
//! the same i64 code for them.

use alloy_primitives::{I256, U256};

pub type R<T> = Result<T, KernelError>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KernelError {
    ExpOverflow,
    LnNonPositive,
    BadUnderlyingIndex,
    BadShockRange,
    LengthMismatch,
    /// Solidity `Panic(0x11)`: checked arithmetic overflow.
    Overflow,
    /// Solidity `Panic(0x12)`: division by zero.
    DivByZero,
}

use KernelError::{DivByZero, Overflow};

pub const WAD: i128 = 1_000_000_000_000_000_000;
pub const LN2: i128 = 693_147_180_559_945_309; // floor(ln2 * 1e18)
pub const SQRT2: i128 = 1_414_213_562_373_095_048; // floor(sqrt2 * 1e18)
pub const INV_SQRT_2PI: i128 = 398_942_280_401_432_678; // round(1/sqrt(2pi) * 1e18)
// Abramowitz-Stegun 26.2.17
pub const AS_P: i128 = 231_641_900_000_000_000;
pub const AS_B1: i128 = 319_381_530_000_000_000;
pub const AS_B2: i128 = -356_563_782_000_000_000;
pub const AS_B3: i128 = 1_781_477_937_000_000_000;
pub const AS_B4: i128 = -1_821_255_978_000_000_000;
pub const AS_B5: i128 = 1_330_274_429_000_000_000;
pub const YEAR: u64 = 31_536_000;

const HALF_LN2: i128 = LN2 / 2;
const E9: u64 = 1_000_000_000;
const E18: u64 = 1_000_000_000_000_000_000;
const W: i64 = E18 as i64;
const M32: u64 = 0xFFFF_FFFF;
// 1e36 = E36_HI * 2^64 + E36_LO
const E36_HI: u64 = 54_210_108_624_275_221;
const E36_LO: u64 = 12_919_594_847_110_692_864;
/// Magnitudes below 2^90 split into three base-1e9 digits (top digit < 1.24e9).
const D3_LIMIT: u128 = 1 << 90;

// ---------------------------------------------------------------------------
// u64 building blocks
// ---------------------------------------------------------------------------

/// 64x64 -> 128 as (hi, lo), from 32-bit halves.
#[inline(always)]
fn mul64(a: u64, b: u64) -> (u64, u64) {
    let (a0, a1) = (a & M32, a >> 32);
    let (b0, b1) = (b & M32, b >> 32);
    let p00 = a0 * b0;
    let p01 = a0 * b1;
    let p10 = a1 * b0;
    let p11 = a1 * b1;
    let mid = (p00 >> 32) + (p01 & M32) + (p10 & M32);
    (p11 + (p01 >> 32) + (p10 >> 32) + (mid >> 32), (p00 & M32) | (mid << 32))
}

/// floor((u1 * 2^64 + u0) / v) for u1 < v (long division with 32-bit digits).
#[inline(never)]
fn divlu(u1: u64, u0: u64, v: u64) -> u64 {
    let s = v.leading_zeros();
    let v = v << s;
    let vn1 = v >> 32;
    let vn0 = v & M32;
    let un32 = if s == 0 { u1 } else { (u1 << s) | (u0 >> (64 - s)) };
    let un10 = u0 << s;
    let un1 = un10 >> 32;
    let un0 = un10 & M32;
    let mut q1 = un32 / vn1;
    let mut rhat = un32 - q1 * vn1;
    while q1 > M32 || q1 * vn0 > ((rhat << 32) | un1) {
        q1 -= 1;
        rhat += vn1;
        if rhat > M32 {
            break;
        }
    }
    let un21 = (un32 << 32).wrapping_add(un1).wrapping_sub(q1.wrapping_mul(v));
    let mut q0 = un21 / vn1;
    let mut rhat = un21 - q0 * vn1;
    while q0 > M32 || q0 * vn0 > ((rhat << 32) | un0) {
        q0 -= 1;
        rhat += vn1;
        if rhat > M32 {
            break;
        }
    }
    (q1 << 32) | q0
}

/// floor(a * b / 1e18) for a, b < 2^63 with a result below 2^63; b given as base-1e9 digits.
#[inline(always)]
fn umul_s(a: u64, b1: u64, b0: u64) -> u64 {
    let (a1, a0) = (a / E9, a % E9);
    a1 * b1 + (a1 * b0 + a0 * b1 + a0 * b0 / E9) / E9
}

/// trunc(a * b / 1e18) with |a|, |b|, |result| < 2^63; |b| given as digits, `bneg` its sign.
#[inline(always)]
fn m64p(a: i64, b1: u64, b0: u64, bneg: bool) -> i64 {
    let q = umul_s(a.unsigned_abs(), b1, b0) as i64;
    if (a < 0) != bneg {
        -q
    } else {
        q
    }
}

#[inline(always)]
fn m64(a: i64, b: i64) -> i64 {
    let ub = b.unsigned_abs();
    m64p(a, ub / E9, ub % E9, b < 0)
}

/// floor(a * b / 1e18) for a, b < 2^63, any result size.
#[inline(always)]
fn umul_small(a: u64, b: u64) -> u128 {
    let (a1, a0) = (a / E9, a % E9);
    let (b1, b0) = (b / E9, b % E9);
    let lo = (a1 * b0 + a0 * b1 + a0 * b0 / E9) / E9;
    let (h, l) = mul64(a1, b1);
    (((h as u128) << 64) | l as u128) + lo as u128
}

/// Base-1e9 digits of x < 2^90: x = d2 * 1e18 + d1 * 1e9 + d0.
#[derive(Clone, Copy)]
pub struct D3 {
    d2: u64,
    d1: u64,
    d0: u64,
}

const D3_ZERO: D3 = D3 { d2: 0, d1: 0, d0: 0 };

#[inline(always)]
fn d3(x: u128) -> D3 {
    let (q, d0) = if x >> 64 == 0 {
        let x = x as u64;
        (x / E9, x % E9)
    } else {
        // x < 2^90: divide by 1e9 over 32-bit chunks (top chunk < 2^58)
        let cur = (((x >> 64) as u64) << 32) | ((x >> 32) as u64 & M32);
        let q1 = cur / E9;
        let cur = ((cur % E9) << 32) | (x as u64 & M32);
        ((q1 << 32) | (cur / E9), cur % E9)
    };
    D3 { d2: q / E9, d1: q % E9, d0 }
}

/// floor(x * y / 1e18) for x, y < 2^90 (3x3 schoolbook, every partial product < 2^64).
#[inline(never)]
fn mul_d3_d3(x: &D3, y: &D3) -> u128 {
    let p1 = x.d1 * y.d0 + x.d0 * y.d1;
    let p2 = x.d2 * y.d0 + x.d1 * y.d1 + x.d0 * y.d2;
    let p3 = x.d2 * y.d1 + x.d1 * y.d2;
    let p4 = x.d2 * y.d2;
    let low = (p1 + x.d0 * y.d0 / E9) / E9;
    let (h3, l3) = mul64(p3, E9);
    let (h4, l4) = mul64(p4, E18);
    let t3 = ((h3 as u128) << 64) | l3 as u128;
    let t4 = ((h4 as u128) << 64) | l4 as u128;
    t4 + t3 + p2 as u128 + low as u128
}

/// floor(x * m / 1e18) for x < 2^90 (as digits) and m < 2^63.
#[inline(never)]
fn mul_d3_small(x: &D3, m: u64) -> u128 {
    let (m1, m0) = (m / E9, m % E9);
    let low = (x.d1 * m0 + x.d0 * m1 + x.d0 * m0 / E9) / E9;
    let mid = x.d2 * m0 + x.d1 * m1;
    let (h, l) = mul64(x.d2 * m1, E9);
    (((h as u128) << 64) | l as u128) + mid as u128 + low as u128
}

#[inline(always)]
fn signed(q: u128, neg: bool) -> i128 {
    if neg {
        -(q as i128)
    } else {
        q as i128
    }
}

// ---------------------------------------------------------------------------
// I256 helpers
// ---------------------------------------------------------------------------

/// Sign-extends an i128 into an I256.
#[inline]
pub fn i256(x: i128) -> I256 {
    let u = x as u128;
    let ext = if x < 0 { u64::MAX } else { 0 };
    I256::from_raw(U256::from_limbs([u as u64, (u >> 64) as u64, ext, ext]))
}

/// The I256 value as an i128, if it fits.
#[inline]
pub fn to_i128(x: I256) -> Option<i128> {
    let l = x.into_raw().into_limbs();
    let v = ((l[0] as u128) | ((l[1] as u128) << 64)) as i128;
    let ext = if v < 0 { u64::MAX } else { 0 };
    if l[2] == ext && l[3] == ext {
        Some(v)
    } else {
        None
    }
}

/// The U256 value as a u128, if it fits.
#[inline]
pub fn to_u128(x: U256) -> Option<u128> {
    let l = x.as_limbs();
    if l[2] == 0 && l[3] == 0 {
        Some((l[0] as u128) | ((l[1] as u128) << 64))
    } else {
        None
    }
}

const WAD_U: U256 = U256::from_limbs([E18, 0, 0, 0]);
const WAD_I: I256 = I256::from_raw(WAD_U);
const ONE: U256 = U256::from_limbs([1, 0, 0, 0]);

// ---------------------------------------------------------------------------
// 256-bit division for the reference path (compact rather than fast)
// ---------------------------------------------------------------------------

/// n / d for 0 < d < 2^64: limb-by-limb long division.
#[inline(never)]
fn udiv_u64(n: U256, d: u64) -> U256 {
    let l = n.as_limbs();
    let mut q = [0u64; 4];
    let mut r = 0u64;
    let mut i = 4;
    while i > 0 {
        i -= 1;
        q[i] = divlu(r, l[i], d);
        r = l[i].wrapping_sub(q[i].wrapping_mul(d));
    }
    U256::from_limbs(q)
}

/// n / d for d != 0, floor.
#[inline(never)]
fn udiv(n: U256, d: U256) -> U256 {
    let dl = d.as_limbs();
    if dl[1] == 0 && dl[2] == 0 && dl[3] == 0 {
        return udiv_u64(n, dl[0]);
    }
    // shift-subtract from the top bit of n; `carry` is the bit shifted out of r
    let mut q = U256::ZERO;
    let mut r = U256::ZERO;
    let mut i = n.bit_len();
    while i > 0 {
        i -= 1;
        let carry = r.bit(255);
        r <<= 1usize;
        if n.bit(i) {
            r |= ONE;
        }
        if carry || r >= d {
            r = r.wrapping_sub(d);
            q.set_bit(i, true);
        }
    }
    q
}

/// a / b for int256 (Solidity `/`: truncates toward zero, reverts on b == 0 and MIN / -1).
fn sdiv(a: I256, b: I256) -> R<I256> {
    if b.is_zero() {
        return Err(DivByZero);
    }
    if a == I256::MIN && b == I256::MINUS_ONE {
        return Err(Overflow);
    }
    let q = I256::from_raw(udiv(a.unsigned_abs(), b.unsigned_abs()));
    Ok(if a.is_negative() != b.is_negative() { q.wrapping_neg() } else { q })
}

/// p / WAD, truncating toward zero.
fn div_by_wad(p: I256) -> I256 {
    let q = I256::from_raw(udiv_u64(p.unsigned_abs(), E18));
    if p.is_negative() {
        q.wrapping_neg()
    } else {
        q
    }
}

// ---------------------------------------------------------------------------
// expWad / lnWad / normCdf series (shared by both backends)
// ---------------------------------------------------------------------------

/// expWad for x in [-41e18, 130e18]: returns (t, k), result = t << k (k >= 0) or t >> -k.
fn exp_core(x: i128) -> (i64, i32) {
    // k = (x + LN2/2) / LN2 for x >= 0, (x - LN2/2) / LN2 otherwise, truncating toward zero
    let n = if x >= 0 { x + HALF_LN2 } else { x - HALF_LN2 };
    let un = n.unsigned_abs(); // < 2^67
    let kq = if un >> 64 == 0 {
        un as u64 / LN2 as u64
    } else {
        divlu((un >> 64) as u64, un as u64, LN2 as u64)
    };
    let k = if n < 0 { -(kq as i64) } else { kq as i64 };
    // r = x - k * LN2 fits in i64 (|r| <= LN2/2 + 1), so computing it mod 2^64 is exact
    let r = (x as i64).wrapping_sub(k.wrapping_mul(LN2 as i64));
    let ur = r.unsigned_abs();
    let (r1, r0, rneg) = (ur / E9, ur % E9, r < 0);
    // t = WAD + mulWad(r, t) / n for n = 12..1; t stays in (0.7e18, 1.5e18)
    let mut t = W;
    let mut n = 12i64;
    while n >= 1 {
        t = W + m64p(t, r1, r0, rneg) / n;
        n -= 1;
    }
    (t, k as i32)
}

/// lnWad once x is normalized to m * 2^k with m in [WAD, 2 * WAD).
fn ln_core(m: i64, k: i32) -> i128 {
    let (m, k) = if m > SQRT2 as i64 { (m / 2, k + 1) } else { (m, k) };
    // z = divWad(m - WAD, m + WAD)
    let num = m - W;
    let (hi, lo) = mul64(num.unsigned_abs(), E18);
    let zq = divlu(hi, lo, (m + W) as u64) as i64;
    let z = if num < 0 { -zq } else { zq };
    let z2 = m64(z, z);
    let mut s = W / 19;
    let mut n = 17i64;
    while n >= 1 {
        s = W / n + m64(z2, s);
        n -= 2;
    }
    k as i128 * LN2 + 2 * m64(z, s) as i128
}

const TWO_WAD_U: u128 = 2 * WAD as u128;

/// The (m, k) that lnWad's two normalization loops reach for 0 < x < 2^128.
#[inline(never)]
fn ln_norm(x: u128) -> (i64, i32) {
    let b = 128 - x.leading_zeros() as i32;
    if x >= TWO_WAD_U {
        // smallest k >= 1 with x >> k < 2 * WAD
        let mut k = if b - 61 > 1 { b - 61 } else { 1 };
        if (x >> k) >= TWO_WAD_U {
            k += 1;
        }
        ((x >> k) as i64, k)
    } else if x < WAD as u128 {
        // smallest j >= 1 with x << j >= WAD
        let mut j = 60 - b;
        if j < 1 || (x << j) < WAD as u128 {
            j += 1;
        }
        ((x << j) as i64, -j)
    } else {
        (x as i64, 0)
    }
}

/// tail(ax) = mulWad(normPdf(ax), poly(t)) for 0 <= ax < 8e18; normCdf = WAD - tail or tail.
#[inline(never)]
fn ncdf_tail(ax: u64) -> i64 {
    const P1: u64 = AS_P as u64 / E9;
    const P0: u64 = AS_P as u64 % E9;
    // t = divWad(WAD, WAD + mulWad(AS_P, ax))
    let t = divlu(E36_HI, E36_LO, E18 + umul_s(ax, P1, P0));
    let (t1, t0) = (t / E9, t % E9);
    let mut poly = AS_B5 as i64;
    poly = AS_B4 as i64 + m64p(poly, t1, t0, false);
    poly = AS_B3 as i64 + m64p(poly, t1, t0, false);
    poly = AS_B2 as i64 + m64p(poly, t1, t0, false);
    poly = AS_B1 as i64 + m64p(poly, t1, t0, false);
    poly = m64p(poly, t1, t0, false);
    // normPdf(ax) = mulWad(INV_SQRT_2PI, expWad(-mulWad(ax, ax) / 2)); the exp argument is in [-32e18, 0]
    let sq = umul_small(ax, ax);
    let (e, k) = exp_core(-((sq >> 1) as i128));
    let e = if k > -63 { e >> -k } else { 0 };
    let phi = m64(e, INV_SQRT_2PI as i64);
    m64(phi, poly)
}

/// normCdf on an i128 argument (never reverts).
#[inline(never)]
pub fn ncdf_i(x: i128) -> i128 {
    if x >= 8 * WAD {
        WAD
    } else if x <= -8 * WAD {
        0
    } else {
        let tail = ncdf_tail(x.unsigned_abs() as u64) as i128;
        if x >= 0 {
            WAD - tail
        } else {
            tail
        }
    }
}

// ---------------------------------------------------------------------------
// Reference API on I256 / U256 (FixedPointMath.sol)
// ---------------------------------------------------------------------------

pub fn mul_wad(a: I256, b: I256) -> R<I256> {
    Ok(div_by_wad(a.checked_mul(b).ok_or(Overflow)?))
}

pub fn div_wad(a: I256, b: I256) -> R<I256> {
    sdiv(a.checked_mul(WAD_I).ok_or(Overflow)?, b)
}

pub fn mul_wad_up(a: U256, b: U256) -> R<U256> {
    let p = a.checked_mul(b).ok_or(Overflow)?;
    Ok(if p.is_zero() { p } else { udiv_u64(p - ONE, E18) + ONE })
}

pub fn div_wad_up(a: U256, b: U256) -> R<U256> {
    let p = a.checked_mul(WAD_U).ok_or(Overflow)?;
    if p.is_zero() {
        return Ok(p);
    }
    if b.is_zero() {
        return Err(DivByZero);
    }
    Ok(udiv(p - ONE, b) + ONE)
}

/// e^x for WAD x. x = k*ln2 + r with |r| <= ln2/2; Horner Taylor to degree 12.
pub fn exp_wad(x: I256) -> R<I256> {
    if x < i256(-41 * WAD) {
        return Ok(I256::ZERO);
    }
    if x > i256(130 * WAD) {
        return Err(KernelError::ExpOverflow);
    }
    let (t, k) = exp_core(to_i128(x).unwrap_or(0));
    // t < 2^61 and k <= 188, so `t << k` never drops bits (Solidity's shift is unchecked)
    Ok(if k >= 0 {
        I256::from_raw(U256::from(t as u64) << k as usize)
    } else if k > -63 {
        i256((t >> -k) as i128)
    } else {
        I256::ZERO
    })
}

/// ln(x) for WAD x > 0.
pub fn ln_wad(x: I256) -> R<I256> {
    if x <= I256::ZERO {
        return Err(KernelError::LnNonPositive);
    }
    let u = x.into_raw();
    let (m, k) = match to_u128(u) {
        Some(v) => ln_norm(v),
        None => {
            // x >= 2^128: k = bitlen - 61 or one more
            let mut k = u.bit_len() as i32 - 61;
            if (u >> k as usize) >= U256::from(TWO_WAD_U) {
                k += 1;
            }
            ((u >> k as usize).as_limbs()[0] as i64, k)
        }
    };
    Ok(i256(ln_core(m, k)))
}

/// floor(sqrt(x * 1e18)), exact.
pub fn sqrt_wad(x: U256) -> R<U256> {
    let n = x.checked_mul(WAD_U).ok_or(Overflow)?;
    Ok(isqrt_u256(n))
}

/// floor(sqrt(n)): the fixed point Solidity's `_isqrt` loop reaches, via Newton from
/// 2^ceil(bits/2) instead of from n (same result, far fewer steps).
fn isqrt_u256(n: U256) -> U256 {
    if let Some(v) = to_u128(n) {
        return U256::from(isqrt_u128(v));
    }
    let mut r = ONE << ((n.bit_len() + 1) / 2);
    loop {
        let y = (udiv(n, r) + r) >> 1;
        if y >= r {
            return r;
        }
        r = y;
    }
}

pub fn norm_pdf(x: I256) -> R<I256> {
    Num::norm_pdf(x)
}

/// Standard normal CDF, A&S 26.2.17 (|err| < 7.5e-8). Never reverts.
pub fn norm_cdf(x: I256) -> I256 {
    if x >= i256(8 * WAD) {
        return WAD_I;
    }
    if x <= i256(-8 * WAD) {
        return I256::ZERO;
    }
    i256(ncdf_i(to_i128(x).unwrap_or(0)))
}

/// int256((tau * 1e18) / YEAR) with uint256 checked multiplication.
pub fn year_frac(tau: U256) -> R<I256> {
    let p = tau.checked_mul(WAD_U).ok_or(Overflow)?;
    Ok(I256::from_raw(udiv_u64(p, YEAR)))
}

// ---------------------------------------------------------------------------
// Fast i128 helpers
// ---------------------------------------------------------------------------

/// trunc(a * b / 1e18); None if the result does not fit in i128.
#[inline(never)]
pub fn wmul_i(a: i128, b: i128) -> Option<i128> {
    let (ua, ub) = (a.unsigned_abs(), b.unsigned_abs());
    let q = if (ua | ub) >> 63 == 0 {
        umul_small(ua as u64, ub as u64)
    } else if ua < D3_LIMIT && ub < D3_LIMIT {
        mul_d3_d3(&d3(ua), &d3(ub))
    } else {
        // |a|, |b| < 2^127 so the 256-bit product cannot overflow
        return to_i128(div_by_wad(i256(a).wrapping_mul(i256(b))));
    };
    Some(signed(q, (a < 0) != (b < 0)))
}

/// trunc(a * 1e18 / b); None if b == 0 or the result does not fit in i128.
#[inline(never)]
pub fn wdiv_i(a: i128, b: i128) -> Option<i128> {
    if b == 0 {
        return None;
    }
    let (ua, ub) = (a.unsigned_abs(), b.unsigned_abs());
    if (ua | ub) >> 64 == 0 {
        let (hi, lo) = mul64(ua as u64, E18);
        if hi < ub as u64 {
            return Some(signed(divlu(hi, lo, ub as u64) as u128, (a < 0) != (b < 0)));
        }
    }
    div_wad(i256(a), i256(b)).ok().and_then(to_i128)
}

pub fn exp_i(x: i128) -> Option<i128> {
    if x < -41 * WAD {
        return Some(0);
    }
    if x > 130 * WAD {
        return None;
    }
    let (t, k) = exp_core(x);
    if k >= 0 {
        // t < 2^61
        if k > 65 {
            None
        } else {
            Some((t as i128) << k)
        }
    } else if k > -63 {
        Some((t >> -k) as i128)
    } else {
        Some(0)
    }
}

pub fn ln_i(x: i128) -> Option<i128> {
    if x <= 0 {
        return None;
    }
    let (m, k) = ln_norm(x as u128);
    Some(ln_core(m, k))
}

/// floor(sqrt(n)) for n < 2^128 (Newton from above; same result as `_isqrt`).
fn isqrt_u128(n: u128) -> u128 {
    if n == 0 {
        return 0;
    }
    let b = 128 - n.leading_zeros();
    let mut r: u128 = 1 << ((b + 1) / 2);
    loop {
        let y = (n / r + r) >> 1;
        if y >= r {
            return r;
        }
        r = y;
    }
}

// ---------------------------------------------------------------------------
// Numeric backends
// ---------------------------------------------------------------------------

/// Runs the fast backend and, on any error, redoes the call on the reference backend
/// (which then yields either the exact result or Solidity's exact revert).
#[inline(always)]
pub fn dispatch<T>(fast: impl FnOnce() -> R<T>, reference: impl FnOnce() -> R<T>) -> R<T> {
    match fast() {
        Ok(v) => Ok(v),
        Err(_) => reference(),
    }
}

/// Signed WAD arithmetic with Solidity semantics. Every operation either returns
/// the exact int256 result or an error; the `i128` backend may also return an
/// error where Solidity would not (out of its range), never the other way round.
pub trait Num: Copy + PartialOrd {
    /// A multiplicand prepared once for repeated `mul_pre` calls.
    type Pre: Copy;
    const ZERO: Self;
    const WAD: Self;

    /// `int256(x)`: two's-complement reinterpretation.
    fn from_u256(x: U256) -> R<Self>;
    fn from_i256(x: I256) -> R<Self>;
    /// A value known to fit in i128.
    fn lit(x: i128) -> Self;
    fn to_i256(self) -> I256;

    fn add(self, b: Self) -> R<Self>;
    fn sub(self, b: Self) -> R<Self>;
    fn neg(self) -> R<Self>;
    /// `self / 2`, truncating.
    fn half(self) -> Self;

    fn mul_wad(self, b: Self) -> R<Self>;
    fn div_wad(self, b: Self) -> R<Self>;
    fn exp_wad(self) -> R<Self>;
    fn ln_wad(self) -> R<Self>;
    fn norm_cdf(self) -> Self;
    /// `int256(sqrtWad(uint256(self)))` for self >= 0.
    fn sqrt_wad(self) -> R<Self>;
    /// `int256((tau * 1e18) / YEAR)`.
    fn year_frac(tau: U256) -> R<Self>;

    fn pre(self) -> Self::Pre;
    /// `mulWad(self, p)`.
    fn mul_pre(self, p: &Self::Pre) -> R<Self>;

    fn norm_pdf(self) -> R<Self> {
        Self::lit(INV_SQRT_2PI).mul_wad(self.mul_wad(self)?.neg()?.half().exp_wad()?)
    }
}

impl Num for I256 {
    type Pre = I256;
    const ZERO: Self = I256::ZERO;
    const WAD: Self = WAD_I;

    #[inline]
    fn from_u256(x: U256) -> R<Self> {
        Ok(I256::from_raw(x))
    }
    #[inline]
    fn from_i256(x: I256) -> R<Self> {
        Ok(x)
    }
    #[inline]
    fn lit(x: i128) -> Self {
        i256(x)
    }
    #[inline]
    fn to_i256(self) -> I256 {
        self
    }
    fn add(self, b: Self) -> R<Self> {
        self.checked_add(b).ok_or(Overflow)
    }
    fn sub(self, b: Self) -> R<Self> {
        self.checked_sub(b).ok_or(Overflow)
    }
    fn neg(self) -> R<Self> {
        self.checked_neg().ok_or(Overflow)
    }
    fn half(self) -> Self {
        let q = I256::from_raw(self.unsigned_abs() >> 1);
        if self.is_negative() {
            q.wrapping_neg()
        } else {
            q
        }
    }
    fn mul_wad(self, b: Self) -> R<Self> {
        mul_wad(self, b)
    }
    fn div_wad(self, b: Self) -> R<Self> {
        div_wad(self, b)
    }
    fn exp_wad(self) -> R<Self> {
        exp_wad(self)
    }
    fn ln_wad(self) -> R<Self> {
        ln_wad(self)
    }
    fn norm_cdf(self) -> Self {
        norm_cdf(self)
    }
    fn sqrt_wad(self) -> R<Self> {
        Ok(I256::from_raw(sqrt_wad(self.into_raw())?))
    }
    fn year_frac(tau: U256) -> R<Self> {
        year_frac(tau)
    }
    #[inline]
    fn pre(self) -> I256 {
        self
    }
    fn mul_pre(self, p: &I256) -> R<Self> {
        mul_wad(self, *p)
    }
}

/// An i128 multiplicand with its base-1e9 digits.
#[derive(Clone, Copy)]
pub struct PreI {
    v: i128,
    d: D3,
    ok: bool,
}

#[inline(always)]
fn fast<T>(x: Option<T>) -> R<T> {
    x.ok_or(Overflow)
}

impl Num for i128 {
    type Pre = PreI;
    const ZERO: Self = 0;
    const WAD: Self = WAD;

    #[inline]
    fn from_u256(x: U256) -> R<Self> {
        match to_u128(x) {
            Some(v) if v >> 127 == 0 => Ok(v as i128),
            _ => Err(Overflow),
        }
    }
    #[inline]
    fn from_i256(x: I256) -> R<Self> {
        fast(to_i128(x))
    }
    #[inline(always)]
    fn lit(x: i128) -> Self {
        x
    }
    #[inline]
    fn to_i256(self) -> I256 {
        i256(self)
    }
    #[inline(always)]
    fn add(self, b: Self) -> R<Self> {
        fast(self.checked_add(b))
    }
    #[inline(always)]
    fn sub(self, b: Self) -> R<Self> {
        fast(self.checked_sub(b))
    }
    #[inline(always)]
    fn neg(self) -> R<Self> {
        fast(self.checked_neg())
    }
    #[inline(always)]
    fn half(self) -> Self {
        self / 2
    }
    #[inline(always)]
    fn mul_wad(self, b: Self) -> R<Self> {
        fast(wmul_i(self, b))
    }
    #[inline(always)]
    fn div_wad(self, b: Self) -> R<Self> {
        fast(wdiv_i(self, b))
    }
    #[inline(always)]
    fn exp_wad(self) -> R<Self> {
        fast(exp_i(self))
    }
    #[inline(always)]
    fn ln_wad(self) -> R<Self> {
        fast(ln_i(self))
    }
    #[inline(always)]
    fn norm_cdf(self) -> Self {
        ncdf_i(self)
    }
    fn sqrt_wad(self) -> R<Self> {
        let u = self as u128;
        if self < 0 || u >> 64 != 0 {
            return Err(Overflow);
        }
        let (hi, lo) = mul64(u as u64, E18);
        Ok(isqrt_u128(((hi as u128) << 64) | lo as u128) as i128)
    }
    fn year_frac(tau: U256) -> R<Self> {
        let t = match to_u128(tau) {
            Some(t) if t >> 64 == 0 => t as u64,
            _ => return Err(Overflow),
        };
        let (hi, lo) = mul64(t, E18);
        if hi >= YEAR {
            return Err(Overflow);
        }
        Ok(divlu(hi, lo, YEAR) as i128)
    }
    #[inline(always)]
    fn pre(self) -> PreI {
        let u = self.unsigned_abs();
        let ok = u < D3_LIMIT;
        PreI { v: self, d: if ok { d3(u) } else { D3_ZERO }, ok }
    }
    #[inline(always)]
    fn mul_pre(self, p: &PreI) -> R<Self> {
        let ua = self.unsigned_abs();
        let q = if !p.ok {
            return self.mul_wad(p.v);
        } else if ua >> 63 == 0 {
            mul_d3_small(&p.d, ua as u64)
        } else if ua < D3_LIMIT {
            mul_d3_d3(&d3(ua), &p.d)
        } else {
            return self.mul_wad(p.v);
        };
        Ok(signed(q, (self < 0) != (p.v < 0)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lit(x: i128) -> I256 {
        i256(x)
    }

    #[test]
    fn i256_division_truncates_toward_zero() {
        assert_eq!(lit(-7) / lit(2), lit(-3));
        assert_eq!(lit(7) / lit(-2), lit(-3));
        assert_eq!(lit(-7).checked_div(lit(2)), Some(lit(-3)));
        assert_eq!(I256::MIN.checked_div(lit(-1)), None);
        assert_eq!(lit(5).checked_div(I256::ZERO), None);
        assert_eq!(lit(-7).half(), lit(-3));
        assert_eq!((-7i128).half(), -3);
    }

    #[test]
    fn i256_checked_ops_match_int256() {
        assert_eq!(I256::MAX.checked_add(lit(1)), None);
        assert_eq!(I256::MIN.checked_sub(lit(1)), None);
        assert_eq!(I256::MIN.checked_neg(), None);
        assert_eq!(I256::MIN.checked_mul(lit(-1)), None);
        assert_eq!(I256::MIN.checked_mul(lit(1)), Some(I256::MIN));
        assert_eq!(lit(-3).checked_mul(lit(4)), Some(lit(-12)));
        let big = I256::from_raw(U256::from(1u8) << 128);
        assert_eq!(big.checked_mul(big), None);
    }

    #[test]
    fn constants() {
        assert_eq!(((E36_HI as u128) << 64) | E36_LO as u128, 10u128.pow(36));
        assert_eq!(HALF_LN2, 346_573_590_279_972_654);
    }

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn u128(&mut self) -> u128 {
            let v = ((self.next() as u128) << 64) | self.next() as u128;
            v >> (self.next() % 128)
        }
        fn i128(&mut self) -> i128 {
            let v = (self.u128() >> 1) as i128;
            if self.next() & 1 == 1 {
                -v
            } else {
                v
            }
        }
    }

    #[test]
    fn fast_mul_div_match_reference() {
        let mut r = Rng(0x9E37_79B9_7F4A_7C15);
        for _ in 0..200_000 {
            let (a, b) = (r.i128(), r.i128());
            let want = mul_wad(lit(a), lit(b)).ok().and_then(to_i128);
            assert_eq!(wmul_i(a, b), want, "wmul {a} {b}");
            let want = div_wad(lit(a), lit(b)).ok().and_then(to_i128);
            assert_eq!(wdiv_i(a, b), want, "wdiv {a} {b}");
            let p = b.pre();
            assert_eq!(a.mul_pre(&p).ok(), wmul_i(a, b), "mul_pre {a} {b}");
        }
    }

    fn ln_loops(x: u128) -> (i64, i32) {
        let mut k = 0i32;
        let mut m = x;
        while m >= TWO_WAD_U {
            k += 1;
            m = x >> k;
        }
        while m < WAD as u128 {
            k -= 1;
            m = x << -k;
        }
        (m as i64, k)
    }

    #[test]
    fn ln_normalization_matches_loops() {
        let mut r = Rng(12345);
        for i in 0..128 {
            for d in [0u128, 1, 2, 3] {
                let x = (1u128 << i).wrapping_add(d).wrapping_sub(1);
                if x > 0 {
                    assert_eq!(ln_norm(x), ln_loops(x), "{x}");
                }
            }
        }
        for x in [WAD as u128 - 1, WAD as u128, TWO_WAD_U - 1, TWO_WAD_U, u128::MAX] {
            assert_eq!(ln_norm(x), ln_loops(x), "{x}");
        }
        for _ in 0..100_000 {
            let x = r.u128();
            if x > 0 {
                assert_eq!(ln_norm(x), ln_loops(x), "{x}");
            }
        }
    }

    /// Solidity's `_isqrt`, literally.
    fn isqrt_solidity(n: U256) -> U256 {
        if n.is_zero() {
            return n;
        }
        let mut r = n;
        let mut y = (n + ONE) / U256::from(2u8);
        while y < r {
            r = y;
            y = (n / y + y) / U256::from(2u8);
        }
        r
    }

    fn u256(r: &mut Rng) -> U256 {
        let v = U256::from_limbs([r.next(), r.next(), r.next(), r.next()]);
        v >> (r.next() % 256) as usize
    }

    #[test]
    fn isqrt_matches_solidity_loop() {
        let mut r = Rng(777);
        for _ in 0..3_000 {
            let n = u256(&mut r) & !ONE;
            assert_eq!(isqrt_u256(n), isqrt_solidity(n), "{n}");
            let m = r.u128();
            assert_eq!(U256::from(isqrt_u128(m)), isqrt_solidity(U256::from(m)), "{m}");
        }
        for n in [0u128, 1, 2, 3, 4, 15, 16, 17, u128::MAX, u128::MAX - 1, 1 << 127] {
            assert_eq!(U256::from(isqrt_u128(n)), isqrt_solidity(U256::from(n)), "{n}");
        }
        // n = x * 1e18 is even, so the n = 2^256 - 1 case (where n + 1 would revert) never occurs
        for n in [U256::MAX - ONE, (U256::MAX >> 1usize) + ONE, ONE << 255usize, (ONE << 128usize) - ONE, ONE << 128usize] {
            assert_eq!(isqrt_u256(n), isqrt_solidity(n), "{n}");
        }
    }

    #[test]
    fn division_matches_ruint() {
        let mut r = Rng(31337);
        for _ in 0..20_000 {
            let n = u256(&mut r);
            let d = u256(&mut r);
            if !d.is_zero() {
                assert_eq!(udiv(n, d), n / d, "{n} / {d}");
            }
            let a = I256::from_raw(u256(&mut r));
            let b = I256::from_raw(u256(&mut r));
            assert_eq!(sdiv(a, b).ok(), a.checked_div(b), "{a} / {b}");
            assert_eq!(div_by_wad(a), a / WAD_I, "{a} / WAD");
            assert_eq!(a.half(), a / lit(2), "{a} / 2");
        }
        assert_eq!(sdiv(I256::MIN, I256::MINUS_ONE), Err(Overflow));
        assert_eq!(sdiv(I256::MIN, lit(1)), Ok(I256::MIN));
        assert_eq!(sdiv(lit(1), I256::ZERO), Err(DivByZero));
        assert_eq!(I256::MIN.half(), I256::MIN / lit(2));
    }

    #[test]
    fn fast_exp_ln_match_reference() {
        let mut r = Rng(42);
        for _ in 0..50_000 {
            let x = (r.next() as i128 % (180 * WAD)) - 45 * WAD;
            assert_eq!(exp_i(x), exp_wad(lit(x)).ok().and_then(to_i128), "exp {x}");
            let y = r.u128() >> 1;
            let y = y as i128;
            assert_eq!(ln_i(y), ln_wad(lit(y)).ok().and_then(to_i128), "ln {y}");
        }
    }
}
