//! Calldata decoding and return-data encoding for the `IRiskKernel` ABI.
//!
//! The deployed program routes calls through [`call`] instead of the SDK's generic
//! decoder, which is several KB of wasm for these struct arrays. Decoding applies the
//! checks Solidity's decoder makes for these calldata parameters: the head fits,
//! offsets and lengths are below 2^64, arrays end inside the calldata and bool words
//! are 0 or 1. A malformed call reverts with empty data, as in Solidity.
//! Tests check both directions against alloy's encoder, which the SDK path uses.

use alloc::vec::Vec;

use alloy_primitives::{I256, U256};
use alloy_sol_types::{sol, Panic};
use stylus_sdk::prelude::*;

use crate::fixed::KernelError;
use crate::margin::{KParamsR, KPositionR, KUnderlyingR, SCENARIOS};
use crate::{bs, margin, vol};

sol! {
    #[derive(AbiType)]
    struct KParams {
        uint256 nowTs;
        int256 rate;
        uint256 diversificationCredit;
        uint256 shortOptionMinPct;
    }

    #[derive(AbiType)]
    struct KUnderlying {
        uint256 spot;
        uint256 vol;
        uint256 shockRange;
        uint256 volUp;
        uint256 volDown;
        int256 tokenQty;
    }

    #[derive(AbiType)]
    struct KPosition {
        uint256 u;
        bool isCall;
        uint256 expiry;
        uint256 strike;
        int256 qty;
    }

    #[derive(AbiType)]
    struct KMarginOut {
        int256 mtm;
        uint256 lossIM;
        uint256 lossCorr;
        uint256 lossIndep;
        uint256 shortMin;
        uint256 worstScenario;
    }

    error ExpOverflow();
    error LnNonPositive();
    error BadUnderlyingIndex();
    error BadShockRange();
    error LengthMismatch();
}

/// Revert data: the custom errors of FixedPointMath / KernelReference, or Solidity's Panic(uint256).
#[derive(SolidityError)]
pub enum KernelRevert {
    ExpOverflow(ExpOverflow),
    LnNonPositive(LnNonPositive),
    BadUnderlyingIndex(BadUnderlyingIndex),
    BadShockRange(BadShockRange),
    LengthMismatch(LengthMismatch),
    Panic(Panic),
}

impl From<KernelError> for KernelRevert {
    #[inline(never)]
    fn from(e: KernelError) -> Self {
        match e {
            KernelError::ExpOverflow => Self::ExpOverflow(ExpOverflow {}),
            KernelError::LnNonPositive => Self::LnNonPositive(LnNonPositive {}),
            KernelError::BadUnderlyingIndex => Self::BadUnderlyingIndex(BadUnderlyingIndex {}),
            KernelError::BadShockRange => Self::BadShockRange(BadShockRange {}),
            KernelError::LengthMismatch => Self::LengthMismatch(LengthMismatch {}),
            KernelError::Overflow => Self::Panic(Panic { code: U256::from(0x11u8) }),
            KernelError::DivByZero => Self::Panic(Panic { code: U256::from(0x12u8) }),
        }
    }
}

macro_rules! selector {
    ($($t:tt)*) => {
        u32::from_be_bytes(stylus_sdk::function_selector!($($t)*))
    };
}

/// Selectors, computed from the same ABI types the SDK would use.
pub const MARGIN: u32 = selector!("margin", KParams, Vec<KUnderlying>, Vec<KPosition>);
pub const SCENARIO_GRID: u32 = selector!("scenarioGrid", KParams, Vec<KUnderlying>, Vec<KPosition>);
pub const BS_QUOTE: u32 = selector!("bsQuote", U256, U256, U256, U256, I256, bool);
pub const EWMA_UPDATE: u32 = selector!("ewmaUpdate", U256, U256, U256, Vec<U256>, Vec<U256>, U256);

pub type CallResult = Result<Vec<u8>, Vec<u8>>;

/// Word `i` of the arguments, which the caller has bounds-checked.
fn word(args: &[u8], at: usize) -> U256 {
    let mut limbs = [0u64; 4];
    for (i, limb) in limbs.iter_mut().enumerate() {
        let o = at + 24 - 8 * i;
        *limb = u64::from_be_bytes(args[o..o + 8].try_into().unwrap());
    }
    U256::from_limbs(limbs)
}

fn int(args: &[u8], at: usize) -> I256 {
    I256::from_raw(word(args, at))
}

/// A word that must be below 2^64 (offsets, lengths).
fn small(args: &[u8], at: usize) -> Option<u64> {
    let w = word(args, at);
    let l = w.as_limbs();
    if l[1] | l[2] | l[3] == 0 {
        Some(l[0])
    } else {
        None
    }
}

fn boolean(args: &[u8], at: usize) -> Option<bool> {
    let w = word(args, at);
    if w > U256::from(1u8) {
        None
    } else {
        Some(!w.is_zero())
    }
}

/// The dynamic array whose offset is at head word `head_at`: (first element position, length).
fn array(args: &[u8], head_at: usize, elem_size: u64) -> Option<(usize, usize)> {
    let end = args.len() as u64;
    let pos = small(args, head_at)?;
    if pos + 31 >= end {
        return None;
    }
    let len = small(args, pos as usize)?;
    let start = pos + 32;
    if start as u128 + len as u128 * elem_size as u128 > end as u128 {
        return None;
    }
    Some((start as usize, len as usize))
}

type GridArgs = (KParamsR, Vec<KUnderlyingR>, Vec<KPositionR>);

/// `(KParams, KUnderlying[], KPosition[])`
pub fn decode_grid(args: &[u8]) -> Option<GridArgs> {
    if args.len() < 192 {
        return None;
    }
    let p = KParamsR { now: word(args, 0), rate: int(args, 32), credit: word(args, 64), short_min: word(args, 96) };
    let (us_at, nu) = array(args, 128, 192)?;
    let (ps_at, np) = array(args, 160, 160)?;
    let mut us = Vec::with_capacity(nu);
    for i in 0..nu {
        let a = us_at + 192 * i;
        us.push(KUnderlyingR {
            spot: word(args, a),
            vol: word(args, a + 32),
            shock_range: word(args, a + 64),
            vol_up: word(args, a + 96),
            vol_down: word(args, a + 128),
            token_qty: int(args, a + 160),
        });
    }
    let mut ps = Vec::with_capacity(np);
    for i in 0..np {
        let a = ps_at + 160 * i;
        ps.push(KPositionR {
            u: word(args, a),
            is_call: boolean(args, a + 32)?,
            expiry: word(args, a + 64),
            strike: word(args, a + 96),
            qty: int(args, a + 128),
        });
    }
    Some((p, us, ps))
}

/// `(uint256, uint256, uint256, uint256[], uint256[], uint256)`
pub fn decode_ewma(args: &[u8]) -> Option<(U256, U256, U256, Vec<U256>, Vec<U256>, U256)> {
    if args.len() < 192 {
        return None;
    }
    let (pa, np) = array(args, 96, 32)?;
    let (da, nd) = array(args, 128, 32)?;
    let prices = (0..np).map(|i| word(args, pa + 32 * i)).collect();
    let dts = (0..nd).map(|i| word(args, da + 32 * i)).collect();
    Some((word(args, 0), word(args, 32), word(args, 64), prices, dts, word(args, 160)))
}

/// `(uint256, uint256, uint256, uint256, int256, bool)`
pub fn decode_bs_quote(args: &[u8]) -> Option<(U256, U256, U256, U256, I256, bool)> {
    if args.len() < 192 {
        return None;
    }
    Some((word(args, 0), word(args, 32), word(args, 64), word(args, 96), int(args, 128), boolean(args, 160)?))
}

fn put(out: &mut Vec<u8>, w: U256) {
    out.extend_from_slice(&w.to_be_bytes::<32>());
}

fn put_i(out: &mut Vec<u8>, w: I256) {
    put(out, w.into_raw());
}

fn revert(e: KernelError) -> Vec<u8> {
    KernelRevert::from(e).into()
}

/// Encodes an `int256[]` whose offset word comes right after `head_words` head words.
fn put_int_array(out: &mut Vec<u8>, head_words: usize, xs: &[I256]) {
    put(out, U256::from(32 * (head_words + 1)));
    put(out, U256::from(xs.len()));
    for x in xs {
        put_i(out, *x);
    }
}

fn margin_call(args: &[u8]) -> CallResult {
    let (p, us, ps) = decode_grid(args).ok_or_else(Vec::new)?;
    let (o, worst) = margin::margin(&p, &us, &ps).map_err(revert)?;
    let mut out = Vec::with_capacity(32 * (8 + worst.len()));
    put_i(&mut out, o.mtm);
    put(&mut out, o.loss_im);
    put(&mut out, o.loss_corr);
    put(&mut out, o.loss_indep);
    put(&mut out, o.short_min);
    put(&mut out, o.worst_scenario);
    put_int_array(&mut out, 6, &worst);
    Ok(out)
}

fn scenario_grid_call(args: &[u8]) -> CallResult {
    let (p, us, ps) = decode_grid(args).ok_or_else(Vec::new)?;
    let pnl = margin::scenario_grid(&p, &us, &ps).map_err(revert)?;
    let mut out = Vec::with_capacity(32 * (2 + SCENARIOS));
    put_int_array(&mut out, 0, &pnl);
    Ok(out)
}

fn bs_quote_call(args: &[u8]) -> CallResult {
    let (s, k, tau, v, r, c) = decode_bs_quote(args).ok_or_else(Vec::new)?;
    let (price, delta, gamma, vega, theta) = bs::quote(s, k, tau, v, r, c).map_err(revert)?;
    let mut out = Vec::with_capacity(32 * 5);
    put(&mut out, price);
    put_i(&mut out, delta);
    put(&mut out, gamma);
    put(&mut out, vega);
    put_i(&mut out, theta);
    Ok(out)
}

fn ewma_call(args: &[u8]) -> CallResult {
    let (r2, dt, last, prices, dts, lambda) = decode_ewma(args).ok_or_else(Vec::new)?;
    let (a, b) = vol::ewma_update(r2, dt, last, &prices, &dts, lambda).map_err(revert)?;
    let mut out = Vec::with_capacity(64);
    put(&mut out, a);
    put(&mut out, b);
    Ok(out)
}

/// Whether `selector` is one of the `IRiskKernel` functions.
pub fn known(selector: u32) -> bool {
    matches!(selector, MARGIN | SCENARIO_GRID | BS_QUOTE | EWMA_UPDATE)
}

/// Runs an `IRiskKernel` call: `args` is the calldata after the selector.
/// Returns None for an unknown selector.
pub fn call(selector: u32, args: &[u8]) -> Option<CallResult> {
    Some(match selector {
        MARGIN => margin_call(args),
        SCENARIO_GRID => scenario_grid_call(args),
        BS_QUOTE => bs_quote_call(args),
        EWMA_UPDATE => ewma_call(args),
        _ => return None,
    })
}
