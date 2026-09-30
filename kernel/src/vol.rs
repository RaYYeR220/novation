//! EWMA volatility estimator, a port of `KernelReference.ewmaUpdate`.
//!
//! r2 <- l*r2 + (1-l)*ln(p_i/p_{i-1})^2 ; dt <- l*dt + (1-l)*dt_i(years). A zero dt only advances the last price.

use alloy_primitives::{I256, U256};

use crate::fixed::{dispatch, KernelError, Num, R};

/// `ewmaUpdate` on one backend (after the length check).
pub fn ewma_with<N: Num>(
    prev_r2: U256,
    prev_dt: U256,
    last_price: U256,
    prices: &[U256],
    dts: &[U256],
    lambda: U256,
) -> R<(U256, U256)> {
    let mut a = N::from_u256(prev_r2)?;
    let mut b = N::from_u256(prev_dt)?;
    let mut last = N::from_u256(last_price)?;
    let l = N::from_u256(lambda)?;
    for (px, dt) in prices.iter().zip(dts) {
        let px = N::from_u256(*px)?;
        if dt.is_zero() {
            last = px;
            continue;
        }
        let r = px.div_wad(last)?.ln_wad()?;
        let dt_y = N::year_frac(*dt)?;
        a = l.mul_wad(a)?.add(N::WAD.sub(l)?.mul_wad(r.mul_wad(r)?)?)?;
        b = l.mul_wad(b)?.add(N::WAD.sub(l)?.mul_wad(dt_y)?)?;
        last = px;
    }
    Ok((a.to_i256().into_raw(), b.to_i256().into_raw()))
}

/// `KernelReference.ewmaUpdate`: (r2, dt).
pub fn ewma_update(
    prev_r2: U256,
    prev_dt: U256,
    last_price: U256,
    prices: &[U256],
    dts: &[U256],
    lambda: U256,
) -> R<(U256, U256)> {
    if prices.len() != dts.len() {
        return Err(KernelError::LengthMismatch);
    }
    dispatch(
        || ewma_with::<i128>(prev_r2, prev_dt, last_price, prices, dts, lambda),
        || ewma_with::<I256>(prev_r2, prev_dt, last_price, prices, dts, lambda),
    )
}
