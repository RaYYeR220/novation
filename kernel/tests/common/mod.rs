//! Readers for the shared vectors (`contracts/test/vectors/{math,kernel}.json`, written by
//! `tools/ref/gen_vectors.py`; every integer is a decimal string).
#![allow(dead_code)]

use alloy_primitives::{I256, U256};
use novation_kernel::margin::{KMarginOutR, KParamsR, KPositionR, KUnderlyingR};
use serde_json::Value;

pub fn load(name: &str) -> Value {
    let path = format!("{}/../contracts/test/vectors/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))).unwrap()
}

pub fn strs<'a>(v: &'a Value, section: &str, field: &str) -> Vec<&'a str> {
    v[section][field]
        .as_array()
        .unwrap_or_else(|| panic!("missing {section}.{field}"))
        .iter()
        .map(|x| x.as_str().unwrap())
        .collect()
}

pub fn ints(v: &Value, section: &str, field: &str) -> Vec<I256> {
    strs(v, section, field).iter().map(|s| I256::from_dec_str(s).unwrap()).collect()
}

pub fn uints(v: &Value, section: &str, field: &str) -> Vec<U256> {
    strs(v, section, field).iter().map(|s| U256::from_str_radix(s, 10).unwrap()).collect()
}

pub fn bools(v: &Value, section: &str, field: &str) -> Vec<bool> {
    v[section][field].as_array().unwrap().iter().map(|x| x.as_bool().unwrap()).collect()
}

pub fn usizes(v: &Value, section: &str, field: &str) -> Vec<usize> {
    strs(v, section, field).iter().map(|s| s.parse().unwrap()).collect()
}

pub struct Book {
    pub p: KParamsR,
    pub us: Vec<KUnderlyingR>,
    pub ps: Vec<KPositionR>,
    pub out: KMarginOutR,
    pub worst: Vec<I256>,
    pub grid: Vec<I256>,
}

pub fn books(v: &Value) -> Vec<Book> {
    let n_us = usizes(v, "books", "n_us");
    let n_ps = usizes(v, "books", "n_ps");
    let (now, rate) = (uints(v, "books", "p_nowTs"), ints(v, "books", "p_rate"));
    let (credit, short_min) = (uints(v, "books", "p_credit"), uints(v, "books", "p_shortMin"));
    let spot = uints(v, "books", "us_spot");
    let uvol = uints(v, "books", "us_vol");
    let shock = uints(v, "books", "us_shockRange");
    let vol_up = uints(v, "books", "us_volUp");
    let vol_down = uints(v, "books", "us_volDown");
    let token_qty = ints(v, "books", "us_tokenQty");
    let pu = uints(v, "books", "ps_u");
    let pcall = bools(v, "books", "ps_isCall");
    let pexp = uints(v, "books", "ps_expiry");
    let pstrike = uints(v, "books", "ps_strike");
    let pqty = ints(v, "books", "ps_qty");
    let o_mtm = ints(v, "books", "out_mtm");
    let o_im = uints(v, "books", "out_lossIM");
    let o_corr = uints(v, "books", "out_lossCorr");
    let o_indep = uints(v, "books", "out_lossIndep");
    let o_short = uints(v, "books", "out_shortMin");
    let o_worst = uints(v, "books", "out_worstScenario");
    let o_puw = ints(v, "books", "out_perUnderlyingWorst");
    let o_grid = ints(v, "books", "out_scenarioGrid");

    let (mut ou, mut op) = (0, 0);
    let mut res = Vec::new();
    for b in 0..n_us.len() {
        let us = (ou..ou + n_us[b])
            .map(|i| KUnderlyingR {
                spot: spot[i],
                vol: uvol[i],
                shock_range: shock[i],
                vol_up: vol_up[i],
                vol_down: vol_down[i],
                token_qty: token_qty[i],
            })
            .collect();
        let ps = (op..op + n_ps[b])
            .map(|i| KPositionR { u: pu[i], is_call: pcall[i], expiry: pexp[i], strike: pstrike[i], qty: pqty[i] })
            .collect();
        res.push(Book {
            p: KParamsR { now: now[b], rate: rate[b], credit: credit[b], short_min: short_min[b] },
            us,
            ps,
            out: KMarginOutR {
                mtm: o_mtm[b],
                loss_im: o_im[b],
                loss_corr: o_corr[b],
                loss_indep: o_indep[b],
                short_min: o_short[b],
                worst_scenario: o_worst[b],
            },
            worst: o_puw[ou..ou + n_us[b]].to_vec(),
            grid: o_grid[b * 39..(b + 1) * 39].to_vec(),
        });
        ou += n_us[b];
        op += n_ps[b];
    }
    assert_eq!(ou, spot.len(), "underlying arrays not fully consumed");
    assert_eq!(op, pu.len(), "position arrays not fully consumed");
    assert_eq!(o_grid.len(), n_us.len() * 39);
    res
}

pub struct Ewma {
    pub r2: U256,
    pub dt: U256,
    pub last: U256,
    pub prices: Vec<U256>,
    pub dts: Vec<U256>,
    pub lambda: U256,
    pub out: (U256, U256),
}

pub fn ewma_cases(v: &Value) -> Vec<Ewma> {
    let n = usizes(v, "ewma", "n");
    let (r2, dt0) = (uints(v, "ewma", "prevR2"), uints(v, "ewma", "prevDt"));
    let (last, lam) = (uints(v, "ewma", "lastPrice"), uints(v, "ewma", "lambda"));
    let (prices, dts) = (uints(v, "ewma", "prices"), uints(v, "ewma", "dts"));
    let (o_r2, o_dt) = (uints(v, "ewma", "out_r2"), uints(v, "ewma", "out_dt"));
    let mut off = 0;
    let mut res = Vec::new();
    for c in 0..n.len() {
        res.push(Ewma {
            r2: r2[c],
            dt: dt0[c],
            last: last[c],
            prices: prices[off..off + n[c]].to_vec(),
            dts: dts[off..off + n[c]].to_vec(),
            lambda: lam[c],
            out: (o_r2[c], o_dt[c]),
        });
        off += n[c];
    }
    assert_eq!(off, prices.len(), "ewma arrays not fully consumed");
    res
}

pub struct QuoteCase {
    pub args: (U256, U256, U256, U256, I256, bool),
    pub out: (U256, I256, U256, U256, I256),
}

pub fn quote_cases(v: &Value) -> Vec<QuoteCase> {
    let s = uints(v, "bsQuote", "spot");
    let k = uints(v, "bsQuote", "strike");
    let tau = uints(v, "bsQuote", "tau");
    let vl = uints(v, "bsQuote", "vol");
    let rate = ints(v, "bsQuote", "rate");
    let call = bools(v, "bsQuote", "isCall");
    let (price, delta, gamma) = (uints(v, "bsQuote", "price"), ints(v, "bsQuote", "delta"), uints(v, "bsQuote", "gamma"));
    let (vega, theta) = (uints(v, "bsQuote", "vega"), ints(v, "bsQuote", "theta"));
    (0..s.len())
        .map(|i| QuoteCase {
            args: (s[i], k[i], tau[i], vl[i], rate[i], call[i]),
            out: (price[i], delta[i], gamma[i], vega[i], theta[i]),
        })
        .collect()
}
