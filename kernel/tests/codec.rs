//! The deployed program's calldata decoder and return encoder against alloy's ABI coder
//! (the one the SDK router uses), on every vector, plus revert data and malformed calldata.

mod common;

use alloy_primitives::{I256, U256};
use alloy_sol_types::{SolCall, SolError};
use common::*;
use novation_kernel::codec;
use novation_kernel::margin::{KParamsR, KPositionR, KUnderlyingR};

/// contracts/src/interfaces/IRiskKernel.sol + types/Types.sol, declared independently of the kernel.
mod abi {
    alloy_sol_types::sol! {
        struct KParams { uint256 nowTs; int256 rate; uint256 diversificationCredit; uint256 shortOptionMinPct; }
        struct KUnderlying { uint256 spot; uint256 vol; uint256 shockRange; uint256 volUp; uint256 volDown; int256 tokenQty; }
        struct KPosition { uint256 u; bool isCall; uint256 expiry; uint256 strike; int256 qty; }
        struct KMarginOut {
            int256 mtm; uint256 lossIM; uint256 lossCorr; uint256 lossIndep; uint256 shortMin; uint256 worstScenario;
        }

        interface IRiskKernel {
            function margin(KParams calldata p, KUnderlying[] calldata us, KPosition[] calldata ps)
                external view returns (KMarginOut memory out, int256[] memory perUnderlyingWorst);
            function scenarioGrid(KParams calldata p, KUnderlying[] calldata us, KPosition[] calldata ps)
                external view returns (int256[] memory pnl);
            function bsQuote(uint256 spot, uint256 strike, uint256 tau, uint256 vol, int256 rate, bool isCall)
                external view returns (uint256 price, int256 delta, uint256 gamma, uint256 vega, int256 theta);
            function ewmaUpdate(uint256 prevR2, uint256 prevDt, uint256 lastPrice, uint256[] calldata prices,
                uint256[] calldata dts, uint256 lambda) external view returns (uint256 r2, uint256 dt);
        }

        error ExpOverflow();
        error LnNonPositive();
        error BadUnderlyingIndex();
        error BadShockRange();
        error LengthMismatch();
    }
}

use abi::IRiskKernel::{bsQuoteCall, ewmaUpdateCall, marginCall, scenarioGridCall};

fn run(data: &[u8]) -> codec::CallResult {
    let sel = u32::from_be_bytes(data[..4].try_into().unwrap());
    codec::call(sel, &data[4..]).expect("known selector")
}

fn p_abi(p: &KParamsR) -> abi::KParams {
    abi::KParams { nowTs: p.now, rate: p.rate, diversificationCredit: p.credit, shortOptionMinPct: p.short_min }
}

fn us_abi(us: &[KUnderlyingR]) -> Vec<abi::KUnderlying> {
    us.iter()
        .map(|u| abi::KUnderlying {
            spot: u.spot,
            vol: u.vol,
            shockRange: u.shock_range,
            volUp: u.vol_up,
            volDown: u.vol_down,
            tokenQty: u.token_qty,
        })
        .collect()
}

fn ps_abi(ps: &[KPositionR]) -> Vec<abi::KPosition> {
    ps.iter()
        .map(|p| abi::KPosition { u: p.u, isCall: p.is_call, expiry: p.expiry, strike: p.strike, qty: p.qty })
        .collect()
}

fn wad(x: u64) -> U256 {
    U256::from(x) * U256::from(10u64.pow(18))
}

fn panic_data(code: u8) -> Vec<u8> {
    let mut v = vec![0x4e, 0x48, 0x7b, 0x71];
    v.extend_from_slice(&U256::from(code).to_be_bytes::<32>());
    v
}

#[test]
fn selectors_match_solidity() {
    // `forge inspect IRiskKernel methodIdentifiers`
    assert_eq!(codec::MARGIN, 0xf4c104f5);
    assert_eq!(codec::SCENARIO_GRID, 0x8c10ae81);
    assert_eq!(codec::BS_QUOTE, 0x4cb48b10);
    assert_eq!(codec::EWMA_UPDATE, 0x2b6ccea9);
    assert_eq!(codec::MARGIN.to_be_bytes(), marginCall::SELECTOR);
    assert_eq!(codec::SCENARIO_GRID.to_be_bytes(), scenarioGridCall::SELECTOR);
    assert_eq!(codec::BS_QUOTE.to_be_bytes(), bsQuoteCall::SELECTOR);
    assert_eq!(codec::EWMA_UPDATE.to_be_bytes(), ewmaUpdateCall::SELECTOR);
    assert!(codec::call(0x12345678, &[]).is_none());
}

#[test]
fn codec_matches_alloy_on_vectors() {
    let v = load("kernel.json");
    let bks = books(&v);
    for (b, bk) in bks.iter().enumerate() {
        let data = marginCall { p: p_abi(&bk.p), us: us_abi(&bk.us), ps: ps_abi(&bk.ps) }.abi_encode();
        let o = &bk.out;
        let out = abi::KMarginOut {
            mtm: o.mtm,
            lossIM: o.loss_im,
            lossCorr: o.loss_corr,
            lossIndep: o.loss_indep,
            shortMin: o.short_min,
            worstScenario: o.worst_scenario,
        };
        let want = marginCall::abi_encode_returns(&abi::IRiskKernel::marginReturn {
            out,
            perUnderlyingWorst: bk.worst.clone(),
        });
        assert_eq!(run(&data), Ok(want), "margin book #{b}");

        let data = scenarioGridCall { p: p_abi(&bk.p), us: us_abi(&bk.us), ps: ps_abi(&bk.ps) }.abi_encode();
        assert_eq!(run(&data), Ok(scenarioGridCall::abi_encode_returns(&bk.grid)), "scenarioGrid book #{b}");
    }

    let cases = ewma_cases(&v);
    for (c, e) in cases.iter().enumerate() {
        let data = ewmaUpdateCall {
            prevR2: e.r2,
            prevDt: e.dt,
            lastPrice: e.last,
            prices: e.prices.clone(),
            dts: e.dts.clone(),
            lambda: e.lambda,
        }
        .abi_encode();
        let want = ewmaUpdateCall::abi_encode_returns(&abi::IRiskKernel::ewmaUpdateReturn { r2: e.out.0, dt: e.out.1 });
        assert_eq!(run(&data), Ok(want), "ewma #{c}");
    }

    let quotes = quote_cases(&v);
    for (i, q) in quotes.iter().enumerate() {
        let a = q.args;
        let data =
            bsQuoteCall { spot: a.0, strike: a.1, tau: a.2, vol: a.3, rate: a.4, isCall: a.5 }.abi_encode();
        let o = q.out;
        let want = bsQuoteCall::abi_encode_returns(&abi::IRiskKernel::bsQuoteReturn {
            price: o.0,
            delta: o.1,
            gamma: o.2,
            vega: o.3,
            theta: o.4,
        });
        assert_eq!(run(&data), Ok(want), "bsQuote #{i}");
    }
    println!("codec: {} books x2, {} ewma, {} bsQuote calls byte-identical to alloy", bks.len(), cases.len(), quotes.len());
}

fn one_book() -> (abi::KParams, Vec<abi::KUnderlying>, Vec<abi::KPosition>) {
    let p = abi::KParams {
        nowTs: U256::from(1_790_000_000u64),
        rate: I256::try_from(40_000_000_000_000_000i128).unwrap(),
        diversificationCredit: U256::from(300_000_000_000_000_000u64),
        shortOptionMinPct: U256::from(10_000_000_000_000_000u64),
    };
    let us = vec![abi::KUnderlying {
        spot: wad(100),
        vol: U256::from(500_000_000_000_000_000u64),
        shockRange: U256::from(200_000_000_000_000_000u64),
        volUp: U256::from(400_000_000_000_000_000u64),
        volDown: U256::from(300_000_000_000_000_000u64),
        tokenQty: I256::ZERO,
    }];
    let ps = vec![abi::KPosition {
        u: U256::ZERO,
        isCall: true,
        expiry: U256::from(1_790_000_000u64 + 7 * 86400),
        strike: wad(105),
        qty: I256::try_from(-3_000_000_000_000_000_000i128).unwrap(),
    }];
    (p, us, ps)
}

#[test]
fn revert_data_matches_solidity_errors() {
    let (p, us, ps) = one_book();
    assert!(run(&marginCall { p: p.clone(), us: us.clone(), ps: ps.clone() }.abi_encode()).is_ok());

    let mut bad = us.clone();
    bad[0].shockRange = U256::from(900_000_000_000_000_001u64);
    let data = marginCall { p: p.clone(), us: bad, ps: ps.clone() }.abi_encode();
    assert_eq!(run(&data), Err(abi::BadShockRange {}.abi_encode()));

    let mut bad = us.clone();
    bad[0].volDown = wad(1);
    let data = scenarioGridCall { p: p.clone(), us: bad, ps: ps.clone() }.abi_encode();
    assert_eq!(run(&data), Err(abi::BadShockRange {}.abi_encode()));

    let mut bad = ps.clone();
    bad[0].u = U256::from(1u8);
    let data = marginCall { p: p.clone(), us: us.clone(), ps: bad }.abi_encode();
    assert_eq!(run(&data), Err(abi::BadUnderlyingIndex {}.abi_encode()));

    // strike 0: divWad(S, 0) is a division by zero
    let mut bad = ps.clone();
    bad[0].strike = U256::ZERO;
    let data = marginCall { p: p.clone(), us: us.clone(), ps: bad }.abi_encode();
    assert_eq!(run(&data), Err(panic_data(0x12)));

    // spot 0: lnWad(divWad(0, K)) = lnWad(0)
    let mut bad = us.clone();
    bad[0].spot = U256::ZERO;
    let data = marginCall { p: p.clone(), us: bad, ps: ps.clone() }.abi_encode();
    assert_eq!(run(&data), Err(abi::LnNonPositive {}.abi_encode()));

    // rate -1000: expWad(-mulWad(rate, T)) with T = 7 days > 130
    let mut bad = p.clone();
    bad.rate = I256::try_from(-100_000_000_000_000_000_000_000i128).unwrap();
    let data = marginCall { p: bad, us: us.clone(), ps: ps.clone() }.abi_encode();
    assert_eq!(run(&data), Err(abi::ExpOverflow {}.abi_encode()));

    // qty = type(int256).min: -qty overflows
    let mut bad = ps.clone();
    bad[0].qty = I256::MIN;
    let data = marginCall { p: p.clone(), us: us.clone(), ps: bad }.abi_encode();
    assert_eq!(run(&data), Err(panic_data(0x11)));

    let data = ewmaUpdateCall {
        prevR2: U256::ZERO,
        prevDt: U256::ZERO,
        lastPrice: wad(100),
        prices: vec![wad(101), wad(102)],
        dts: vec![U256::from(60u8)],
        lambda: U256::from(940_000_000_000_000_000u64),
    }
    .abi_encode();
    assert_eq!(run(&data), Err(abi::LengthMismatch {}.abi_encode()));

    // bsQuote with strike 0 at tau > 0: divWad(s, 0)
    let data = bsQuoteCall {
        spot: wad(100),
        strike: U256::ZERO,
        tau: U256::from(86400u32),
        vol: U256::from(500_000_000_000_000_000u64),
        rate: I256::ZERO,
        isCall: true,
    }
    .abi_encode();
    assert_eq!(run(&data), Err(panic_data(0x12)));
}

#[test]
fn malformed_calldata_reverts_empty() {
    let (p, us, ps) = one_book();
    let good = marginCall { p, us, ps }.abi_encode();
    assert!(run(&good).is_ok());

    // head shorter than 6 words
    assert_eq!(run(&good[..4 + 191]), Err(vec![]));
    // array running past the end of calldata
    assert_eq!(run(&good[..good.len() - 1]), Err(vec![]));
    // bool word that is neither 0 nor 1 (position's isCall is the 2nd word of its tuple)
    let mut bad = good.clone();
    let n = bad.len();
    bad[n - 3 * 32 - 1] = 2;
    assert_eq!(run(&bad), Err(vec![]));
    // offset >= 2^64
    let mut bad = good.clone();
    bad[4 + 128 + 23] = 1;
    assert_eq!(run(&bad), Err(vec![]));
    // length >= 2^64
    let mut bad = good.clone();
    let us_off = 4 + u64::from_be_bytes(good[4 + 128 + 24..4 + 160].try_into().unwrap()) as usize;
    bad[us_off + 23] = 1;
    assert_eq!(run(&bad), Err(vec![]));

    let q = bsQuoteCall {
        spot: wad(100),
        strike: wad(100),
        tau: U256::from(86400u32),
        vol: U256::from(500_000_000_000_000_000u64),
        rate: I256::ZERO,
        isCall: false,
    }
    .abi_encode();
    assert!(run(&q).is_ok());
    let mut bad = q.clone();
    bad[4 + 5 * 32 + 31] = 2;
    assert_eq!(run(&bad), Err(vec![]));
    assert_eq!(run(&q[..4 + 160]), Err(vec![]));
}
