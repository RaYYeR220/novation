//! Scenario-grid portfolio margin, a port of `KernelReference._grid / margin / scenarioGrid`.
//!
//! pnl is laid out [u * 39 + v * 13 + j]; scenario s = v * 13 + j; price move m_j = (j - 6) * R / 6.

use alloc::vec;
use alloc::vec::Vec;

use alloy_primitives::{I256, U256};

use crate::bs::{discount, drift, price_ln};
use crate::fixed::{dispatch, i256, ln_i, mul_wad, mul_wad_up, KernelError, Num, R, WAD};

pub const PRICE_POINTS: usize = 13;
pub const VOL_POINTS: usize = 3;
pub const SCENARIOS: usize = 39;

/// `KParams`
#[derive(Clone, Debug)]
pub struct KParamsR {
    pub now: U256,
    pub rate: I256,
    pub credit: U256,
    pub short_min: U256,
}

/// `KUnderlying`
#[derive(Clone, Debug)]
pub struct KUnderlyingR {
    pub spot: U256,
    pub vol: U256,
    pub shock_range: U256,
    pub vol_up: U256,
    pub vol_down: U256,
    pub token_qty: I256,
}

/// `KPosition`
#[derive(Clone, Debug)]
pub struct KPositionR {
    pub u: U256,
    pub is_call: bool,
    pub expiry: U256,
    pub strike: U256,
    pub qty: I256,
}

/// `KMarginOut`
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KMarginOutR {
    pub mtm: I256,
    pub loss_im: U256,
    pub loss_corr: U256,
    pub loss_indep: U256,
    pub short_min: U256,
    pub worst_scenario: U256,
}

struct Grid<N> {
    pnl: Vec<N>,
    mtm: N,
    short_min: U256,
}

const MAX_SHOCK: U256 = U256::from_limbs([900_000_000_000_000_000, 0, 0, 0]);
const WAD_U: U256 = U256::from_limbs([WAD as u64, 0, 0, 0]);

#[inline(always)]
fn add_at<N: Num>(pnl: &mut [N], i: usize, d: N) -> R<()> {
    pnl[i] = pnl[i].add(d)?;
    Ok(())
}

/// Adds `d` to the three vol slices of price point j (Solidity adds the same term for s and s + 13k).
#[inline(always)]
fn add_price_point<N: Num>(pnl: &mut [N], base: usize, j: usize, d: N) -> R<()> {
    add_at(pnl, base + j, d)?;
    add_at(pnl, base + PRICE_POINTS + j, d)?;
    add_at(pnl, base + 2 * PRICE_POINTS + j, d)
}

fn grid<N: Num>(p: &KParamsR, us: &[KUnderlyingR], ps: &[KPositionR]) -> R<Grid<N>> {
    let nu = us.len();
    let mut pnl = vec![N::ZERO; nu * SCENARIOS];
    let mut sj = vec![N::ZERO; nu * PRICE_POINTS];
    let mut sj_pre = vec![N::ZERO.pre(); nu * PRICE_POINTS];
    let mut ln_sh = vec![N::ZERO; nu * PRICE_POINTS];
    let mut vols = vec![N::ZERO; nu * VOL_POINTS];
    let mut mtm = N::ZERO;
    for (u, un) in us.iter().enumerate() {
        if un.shock_range > MAX_SHOCK || un.vol_down >= WAD_U {
            return Err(KernelError::BadShockRange);
        }
        let s = N::from_u256(un.spot)?;
        let r = un.shock_range.as_limbs()[0] as i64;
        for j in 0..PRICE_POINTS {
            let m = ((j as i64 - 6) * r) / 6;
            let x = s.mul_wad(N::lit(WAD + m as i128))?;
            let i = u * PRICE_POINTS + j;
            sj[i] = x;
            sj_pre[i] = x.pre();
            // WAD + m >= 0.1e18, so lnWad cannot revert
            ln_sh[i] = N::lit(ln_i(WAD + m as i128).unwrap_or(0));
        }
        let v = N::from_u256(un.vol)?;
        vols[u * VOL_POINTS] = v.mul_wad(N::lit(WAD - un.vol_down.as_limbs()[0] as i128))?;
        vols[u * VOL_POINTS + 1] = v;
        vols[u * VOL_POINTS + 2] = v.mul_wad(N::WAD.add(N::from_u256(un.vol_up)?)?)?;
        let tq = N::from_i256(un.token_qty)?;
        mtm = mtm.add(tq.mul_wad(s)?)?;
        for j in 0..PRICE_POINTS {
            let d = tq.mul_wad(sj[u * PRICE_POINTS + j].sub(s)?)?;
            add_price_point(&mut pnl, u * SCENARIOS, j, d)?;
        }
    }

    let rate = N::from_i256(p.rate)?;
    let mut short_min = U256::ZERO;
    for pos in ps {
        if pos.u >= U256::from(nu) {
            return Err(KernelError::BadUnderlyingIndex);
        }
        let u = pos.u.as_limbs()[0] as usize;
        let spot = us[u].spot;
        let s = N::from_u256(spot)?;
        let k = N::from_u256(pos.strike)?;
        let qty = N::from_i256(pos.qty)?;
        if pos.qty < I256::ZERO {
            let neg = pos.qty.checked_neg().ok_or(KernelError::Overflow)?.into_raw();
            let add = mul_wad_up(neg, mul_wad_up(spot, p.short_min)?)?;
            short_min = short_min.checked_add(add).ok_or(KernelError::Overflow)?;
        }
        let tau = if pos.expiry > p.now { pos.expiry - p.now } else { U256::ZERO };
        let sx = &sj[u * PRICE_POINTS..(u + 1) * PRICE_POINTS];
        let sx_p = &sj_pre[u * PRICE_POINTS..(u + 1) * PRICE_POINTS];
        let base = u * SCENARIOS;
        if tau.is_zero() {
            let mut mark_i = if pos.is_call { s.sub(k)? } else { k.sub(s)? };
            if mark_i < N::ZERO {
                mark_i = N::ZERO;
            }
            mtm = mtm.add(qty.mul_wad(mark_i)?)?;
            for j in 0..PRICE_POINTS {
                let mut iv = if pos.is_call { sx[j].sub(k)? } else { k.sub(sx[j])? };
                if iv < N::ZERO {
                    iv = N::ZERO;
                }
                let d = qty.mul_wad(iv.sub(mark_i)?)?;
                add_price_point(&mut pnl, base, j, d)?;
            }
            continue;
        }
        let t = N::year_frac(tau)?;
        let sqrt_t = t.sqrt_wad()?;
        let ln_sk = s.div_wad(k)?.ln_wad()?;
        let kd = k.mul_wad(discount(rate, t)?)?;
        let kd_p = kd.pre();
        let q_p = qty.pre();
        // Per-position operands, hoisted: lnSK + lnSh[j] per price point, sst and drift per vol.
        // Every step here can only fail with Panic(0x11), so computing them up front
        // cannot change which error a reverting book reports.
        let mut lnx = [N::ZERO; PRICE_POINTS];
        for j in 0..PRICE_POINTS {
            lnx[j] = ln_sk.add(ln_sh[u * PRICE_POINTS + j])?;
        }
        let mut sst = [N::ZERO; VOL_POINTS];
        let mut dr = [N::ZERO; VOL_POINTS];
        for vi in 0..VOL_POINTS {
            let sig = vols[u * VOL_POINTS + vi];
            sst[vi] = sig.mul_wad(sqrt_t)?;
            dr[vi] = drift(rate, sig, t)?;
        }
        let mark = price_ln(sx[6], &sx_p[6], lnx[6], sst[1], dr[1], kd, &kd_p, pos.is_call)?;
        mtm = mtm.add(qty.mul_wad(mark)?)?;
        for vi in 0..VOL_POINTS {
            for j in 0..PRICE_POINTS {
                // the base scenario reprices to exactly `mark` and adds mulWad(qty, 0) = 0
                if vi == 1 && j == 6 {
                    continue;
                }
                let px = price_ln(sx[j], &sx_p[j], lnx[j], sst[vi], dr[vi], kd, &kd_p, pos.is_call)?;
                let d = px.sub(mark)?.mul_pre(&q_p)?;
                add_at(&mut pnl, base + vi * PRICE_POINTS + j, d)?;
            }
        }
    }
    Ok(Grid { pnl, mtm, short_min })
}

/// `margin` on one backend.
pub fn margin_with<N: Num>(p: &KParamsR, us: &[KUnderlyingR], ps: &[KPositionR]) -> R<(KMarginOutR, Vec<I256>)> {
    let g = grid::<N>(p, us, ps)?;
    let nu = us.len();
    let mut min_sum = N::ZERO;
    let mut worst = 0usize;
    if nu > 0 {
        // Solidity starts from type(int256).max; taking scenario 0 first is equivalent
        for s in 0..SCENARIOS {
            let mut sum = N::ZERO;
            for u in 0..nu {
                sum = sum.add(g.pnl[u * SCENARIOS + s])?;
            }
            if s == 0 || sum < min_sum {
                min_sum = sum;
                worst = s;
            }
        }
    }
    let mut per_underlying_worst = Vec::with_capacity(nu);
    let mut loss_indep = U256::ZERO;
    for u in 0..nu {
        let row = &g.pnl[u * SCENARIOS..(u + 1) * SCENARIOS];
        let mut mn = row[0];
        for &x in &row[1..] {
            if x < mn {
                mn = x;
            }
        }
        per_underlying_worst.push(mn.to_i256());
        if mn < N::ZERO {
            loss_indep = loss_indep.checked_add(mn.neg()?.to_i256().into_raw()).ok_or(KernelError::Overflow)?;
        }
    }
    let loss_corr = if min_sum < N::ZERO { min_sum.neg()?.to_i256().into_raw() } else { U256::ZERO };
    let keep = i256(WAD).checked_sub(I256::from_raw(p.credit)).ok_or(KernelError::Overflow)?;
    let indep_adj = mul_wad(I256::from_raw(loss_indep), keep)?.into_raw();
    let base = if loss_corr > indep_adj { loss_corr } else { indep_adj };
    let out = KMarginOutR {
        mtm: g.mtm.to_i256(),
        loss_im: base.checked_add(g.short_min).ok_or(KernelError::Overflow)?,
        loss_corr,
        loss_indep,
        short_min: g.short_min,
        worst_scenario: U256::from(worst),
    };
    Ok((out, per_underlying_worst))
}

/// `scenarioGrid` on one backend.
pub fn scenario_grid_with<N: Num>(p: &KParamsR, us: &[KUnderlyingR], ps: &[KPositionR]) -> R<Vec<I256>> {
    let g = grid::<N>(p, us, ps)?;
    let mut out = Vec::with_capacity(SCENARIOS);
    for s in 0..SCENARIOS {
        let mut acc = N::ZERO;
        for u in 0..us.len() {
            acc = acc.add(g.pnl[u * SCENARIOS + s])?;
        }
        out.push(acc.to_i256());
    }
    Ok(out)
}

/// `KernelReference.margin`: (out, perUnderlyingWorst).
pub fn margin(p: &KParamsR, us: &[KUnderlyingR], ps: &[KPositionR]) -> R<(KMarginOutR, Vec<I256>)> {
    dispatch(|| margin_with::<i128>(p, us, ps), || margin_with::<I256>(p, us, ps))
}

/// `KernelReference.scenarioGrid`: correlated portfolio PnL per scenario (length 39).
pub fn scenario_grid(p: &KParamsR, us: &[KUnderlyingR], ps: &[KPositionR]) -> R<Vec<I256>> {
    dispatch(|| scenario_grid_with::<i128>(p, us, ps), || scenario_grid_with::<I256>(p, us, ps))
}
