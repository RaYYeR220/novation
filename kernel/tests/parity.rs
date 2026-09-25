//! Exact parity with the Solidity reference on the shared vectors
//! (`contracts/test/vectors/{math,kernel}.json`, written by `tools/ref/gen_vectors.py`).
//!
//! Every case is checked three ways: the public entry point (fast path with
//! fallback), the reference `I256` backend alone, and the fast `i128` backend
//! alone. The fast backend must not fall back on any of these vectors.

mod common;

use alloy_primitives::I256;
use common::*;
use novation_kernel::{bs, fixed, margin, vol};

#[test]
fn math_vectors_exact() {
    let v = load("math.json");

    let (xs, ys) = (ints(&v, "expWad", "x"), ints(&v, "expWad", "y"));
    for (i, (x, y)) in xs.iter().zip(&ys).enumerate() {
        assert_eq!(fixed::exp_wad(*x).unwrap(), *y, "expWad #{i} x={x}");
        if let Some(yi) = fixed::exp_i(fixed::to_i128(*x).unwrap()) {
            assert_eq!(fixed::i256(yi), *y, "exp_i #{i} x={x}");
        }
    }

    let (xs, ys) = (ints(&v, "lnWad", "x"), ints(&v, "lnWad", "y"));
    for (i, (x, y)) in xs.iter().zip(&ys).enumerate() {
        assert_eq!(fixed::ln_wad(*x).unwrap(), *y, "lnWad #{i} x={x}");
        if let Some(xi) = fixed::to_i128(*x) {
            assert_eq!(fixed::i256(fixed::ln_i(xi).unwrap()), *y, "ln_i #{i} x={x}");
        }
    }

    let (xs, ys) = (uints(&v, "sqrtWad", "x"), uints(&v, "sqrtWad", "y"));
    for (i, (x, y)) in xs.iter().zip(&ys).enumerate() {
        assert_eq!(fixed::sqrt_wad(*x).unwrap(), *y, "sqrtWad #{i} x={x}");
    }

    let (xs, ys) = (ints(&v, "normCdf", "x"), ints(&v, "normCdf", "y"));
    for (i, (x, y)) in xs.iter().zip(&ys).enumerate() {
        assert_eq!(fixed::norm_cdf(*x), *y, "normCdf #{i} x={x}");
        assert_eq!(fixed::i256(fixed::ncdf_i(fixed::to_i128(*x).unwrap())), *y, "ncdf_i #{i} x={x}");
    }

    let (a, b, y) = (uints(&v, "mulWadUp", "a"), uints(&v, "mulWadUp", "b"), uints(&v, "mulWadUp", "y"));
    for i in 0..y.len() {
        assert_eq!(fixed::mul_wad_up(a[i], b[i]).unwrap(), y[i], "mulWadUp #{i}");
    }
    let (a, b, y) = (uints(&v, "divWadUp", "a"), uints(&v, "divWadUp", "b"), uints(&v, "divWadUp", "y"));
    for i in 0..y.len() {
        assert_eq!(fixed::div_wad_up(a[i], b[i]).unwrap(), y[i], "divWadUp #{i}");
    }

    let s = uints(&v, "price", "S");
    let k = uints(&v, "price", "K");
    let tau = uints(&v, "price", "tau");
    let vol = uints(&v, "price", "vol");
    let rate = ints(&v, "price", "rate");
    let call = bools(&v, "price", "isCall");
    let y = uints(&v, "price", "y");
    for i in 0..y.len() {
        let a = (s[i], k[i], tau[i], vol[i], rate[i], call[i]);
        assert_eq!(bs::price(a.0, a.1, a.2, a.3, a.4, a.5).unwrap(), y[i], "price #{i}");
        assert_eq!(bs::price_with::<I256>(a.0, a.1, a.2, a.3, a.4, a.5).unwrap(), y[i], "price ref #{i}");
        assert_eq!(bs::price_with::<i128>(a.0, a.1, a.2, a.3, a.4, a.5).unwrap(), y[i], "price fast #{i}");
    }

    println!(
        "math parity: expWad {} lnWad {} sqrtWad {} normCdf {} mulWadUp {} divWadUp {} price {}",
        ints(&v, "expWad", "x").len(),
        ints(&v, "lnWad", "x").len(),
        uints(&v, "sqrtWad", "x").len(),
        ints(&v, "normCdf", "x").len(),
        uints(&v, "mulWadUp", "a").len(),
        uints(&v, "divWadUp", "a").len(),
        y.len()
    );
}

#[test]
fn kernel_vectors_exact() {
    let v = load("kernel.json");

    let bks = books(&v);
    let mut max_n = 0;
    for (b, bk) in bks.iter().enumerate() {
        max_n = max_n.max(bk.ps.len());
        let want = (bk.out.clone(), bk.worst.clone());
        let got = margin::margin(&bk.p, &bk.us, &bk.ps).unwrap_or_else(|e| panic!("margin book #{b}: {e:?}"));
        assert_eq!(got, want, "margin book #{b} ({} us, {} ps)", bk.us.len(), bk.ps.len());
        let got = margin::margin_with::<I256>(&bk.p, &bk.us, &bk.ps).unwrap();
        assert_eq!(got, want, "margin ref book #{b}");
        let got = margin::margin_with::<i128>(&bk.p, &bk.us, &bk.ps)
            .unwrap_or_else(|e| panic!("margin fast book #{b} fell back: {e:?}"));
        assert_eq!(got, want, "margin fast book #{b}");

        assert_eq!(margin::scenario_grid(&bk.p, &bk.us, &bk.ps).unwrap(), bk.grid, "scenarioGrid book #{b}");
        assert_eq!(margin::scenario_grid_with::<I256>(&bk.p, &bk.us, &bk.ps).unwrap(), bk.grid, "grid ref #{b}");
        assert_eq!(margin::scenario_grid_with::<i128>(&bk.p, &bk.us, &bk.ps).unwrap(), bk.grid, "grid fast #{b}");
    }

    let cases = ewma_cases(&v);
    for (c, e) in cases.iter().enumerate() {
        let got = vol::ewma_update(e.r2, e.dt, e.last, &e.prices, &e.dts, e.lambda).unwrap();
        assert_eq!(got, e.out, "ewma #{c}");
        let got = vol::ewma_with::<I256>(e.r2, e.dt, e.last, &e.prices, &e.dts, e.lambda).unwrap();
        assert_eq!(got, e.out, "ewma ref #{c}");
        let got = vol::ewma_with::<i128>(e.r2, e.dt, e.last, &e.prices, &e.dts, e.lambda).unwrap();
        assert_eq!(got, e.out, "ewma fast #{c}");
    }

    let quotes = quote_cases(&v);
    for (i, q) in quotes.iter().enumerate() {
        let a = q.args;
        assert_eq!(bs::quote(a.0, a.1, a.2, a.3, a.4, a.5).unwrap(), q.out, "bsQuote #{i}");
        assert_eq!(bs::quote_with::<I256>(a.0, a.1, a.2, a.3, a.4, a.5).unwrap(), q.out, "bsQuote ref #{i}");
        assert_eq!(bs::quote_with::<i128>(a.0, a.1, a.2, a.3, a.4, a.5).unwrap(), q.out, "bsQuote fast #{i}");
    }

    println!(
        "kernel parity: {} books (margin + perUnderlyingWorst + scenarioGrid, max {} positions), {} ewma cases, {} bsQuote cases",
        bks.len(),
        max_n,
        cases.len(),
        quotes.len()
    );
}
