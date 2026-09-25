//! Black-Scholes, a line-by-line port of `BlackScholes.sol` over either backend.

use alloy_primitives::{I256, U256};

use crate::fixed::{dispatch, i256, Num, R, WAD};

/// Below this sigma*sqrt(T) the option is valued at forward intrinsic.
pub const MIN_SST: i128 = 1_000_000;

/// `priceLn(Sx, lnx, sst, drift, Kd, isCall)`, with Sx and Kd also given as prepared multiplicands.
#[inline(never)]
#[allow(clippy::too_many_arguments)]
pub fn price_ln<N: Num>(
    sx: N,
    sx_p: &N::Pre,
    lnx: N,
    sst: N,
    drift: N,
    kd: N,
    kd_p: &N::Pre,
    is_call: bool,
) -> R<N> {
    if sst < N::lit(MIN_SST) {
        let v = if is_call { sx.sub(kd)? } else { kd.sub(sx)? };
        return Ok(if v > N::ZERO { v } else { N::ZERO });
    }
    let d1 = lnx.add(drift)?.div_wad(sst)?;
    let d2 = d1.sub(sst)?;
    let v = if is_call {
        d1.norm_cdf().mul_pre(sx_p)?.sub(d2.norm_cdf().mul_pre(kd_p)?)?
    } else {
        d2.neg()?.norm_cdf().mul_pre(kd_p)?.sub(d1.neg()?.norm_cdf().mul_pre(sx_p)?)?
    };
    Ok(if v < N::ZERO { N::ZERO } else { v })
}

/// `discount(rate, T)`: WAD if rate == 0, else expWad(-mulWad(rate, T)).
#[inline(never)]
pub fn discount<N: Num>(rate: N, t: N) -> R<N> {
    if rate == N::ZERO {
        Ok(N::WAD)
    } else {
        rate.mul_wad(t)?.neg()?.exp_wad()
    }
}

/// `mulWad(rate + mulWad(sig, sig) / 2, T)`.
#[inline(never)]
pub fn drift<N: Num>(rate: N, sig: N, t: N) -> R<N> {
    rate.add(sig.mul_wad(sig)?.half())?.mul_wad(t)
}

/// `BlackScholes.price` on one backend.
pub fn price_with<N: Num>(s: U256, k: U256, tau: U256, vol: U256, rate: I256, is_call: bool) -> R<U256> {
    let s = N::from_u256(s)?;
    let k = N::from_u256(k)?;
    if tau.is_zero() {
        let iv = if is_call { s.sub(k)? } else { k.sub(s)? };
        return Ok(if iv > N::ZERO { iv.to_i256().into_raw() } else { U256::ZERO });
    }
    let rate = N::from_i256(rate)?;
    let t = N::year_frac(tau)?;
    let sqrt_t = t.sqrt_wad()?;
    let sig = N::from_u256(vol)?;
    let sst = sig.mul_wad(sqrt_t)?;
    let drift = drift(rate, sig, t)?;
    let kd = k.mul_wad(discount(rate, t)?)?;
    let lnx = s.div_wad(k)?.ln_wad()?;
    Ok(price_ln(s, &s.pre(), lnx, sst, drift, kd, &kd.pre(), is_call)?.to_i256().into_raw())
}

/// (price, delta, gamma, vega, theta)
pub type Quote = (U256, I256, U256, U256, I256);

/// `bsQuote` = `BlackScholes.price` then `BlackScholes.greeks`, on one backend.
///
/// greeks recomputes T, sqrtT, sst, drift, Kd and d1 from the same inputs with the same
/// operations as price; price already succeeded with them, so they are computed once.
pub fn quote_with<N: Num>(s: U256, k: U256, tau: U256, vol: U256, rate: I256, is_call: bool) -> R<Quote> {
    let s = N::from_u256(s)?;
    let k = N::from_u256(k)?;
    // greeks when tau == 0 or sst < MIN_SST: delta = +/-1 if in the money else 0, other greeks 0
    let degenerate = |price: U256| -> R<Quote> {
        let itm = if is_call { s > k } else { k > s };
        let delta = if !itm {
            0
        } else if is_call {
            WAD
        } else {
            -WAD
        };
        Ok((price, i256(delta), U256::ZERO, U256::ZERO, I256::ZERO))
    };
    if tau.is_zero() {
        // price: intrinsic; greeks: T = sqrtT = sst = 0, nothing can revert
        let iv = if is_call { s.sub(k)? } else { k.sub(s)? };
        return degenerate(if iv > N::ZERO { iv.to_i256().into_raw() } else { U256::ZERO });
    }
    let rate = N::from_i256(rate)?;
    let t = N::year_frac(tau)?;
    let sqrt_t = t.sqrt_wad()?;
    let sig = N::from_u256(vol)?;
    let sst = sig.mul_wad(sqrt_t)?;
    let drift = drift(rate, sig, t)?;
    let kd = k.mul_wad(discount(rate, t)?)?;
    let lnx = s.div_wad(k)?.ln_wad()?;
    let price = price_ln(s, &s.pre(), lnx, sst, drift, kd, &kd.pre(), is_call)?.to_i256().into_raw();
    if sst < N::lit(MIN_SST) {
        return degenerate(price);
    }
    let d1 = lnx.add(drift)?.div_wad(sst)?;
    let d2 = d1.sub(sst)?;
    let pdf1 = d1.norm_pdf()?;
    let delta = if is_call { d1.norm_cdf() } else { d1.norm_cdf().sub(N::WAD)? };
    let gamma = pdf1.div_wad(s.mul_wad(sst)?)?;
    let s_pdf = s.mul_wad(pdf1)?;
    let vega = s_pdf.mul_wad(sqrt_t)?;
    let decay = s_pdf.mul_wad(sig)?.div_wad(sqrt_t.add(sqrt_t)?)?.neg()?;
    let r_kd = rate.mul_wad(kd)?;
    let theta = if is_call {
        decay.sub(r_kd.mul_wad(d2.norm_cdf())?)?
    } else {
        decay.add(r_kd.mul_wad(d2.neg()?.norm_cdf())?)?
    };
    Ok((price, delta.to_i256(), gamma.to_i256().into_raw(), vega.to_i256().into_raw(), theta.to_i256()))
}

/// `BlackScholes.price(S, K, tau, vol, rate, isCall)`.
pub fn price(s: U256, k: U256, tau: U256, vol: U256, rate: I256, is_call: bool) -> R<U256> {
    dispatch(
        || price_with::<i128>(s, k, tau, vol, rate, is_call),
        || price_with::<I256>(s, k, tau, vol, rate, is_call),
    )
}

/// `KernelReference.bsQuote(spot, strike, tau, vol, rate, isCall)`.
pub fn quote(s: U256, k: U256, tau: U256, vol: U256, rate: I256, is_call: bool) -> R<Quote> {
    dispatch(
        || quote_with::<i128>(s, k, tau, vol, rate, is_call),
        || quote_with::<I256>(s, k, tau, vol, rate, is_call),
    )
}
