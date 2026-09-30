//! Novation risk kernel: portfolio margin, scenario grid, Black-Scholes quotes and
//! EWMA volatility for the options clearinghouse, as a Stylus program.
//!
//! Every function returns exactly the integers of `KernelReference.sol` for the same
//! inputs (same algorithms, same order of operations, truncation toward zero,
//! checked arithmetic) and reverts with the same errors.
#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]

extern crate alloc;

pub mod bs;
pub mod codec;
pub mod fixed;
pub mod margin;
pub mod vol;

#[cfg(any(target_arch = "wasm32", feature = "export-abi"))]
pub use contract::RiskKernel;

/// The `IRiskKernel` program.
///
/// The deployed build routes selectors through [`codec`] (a compact decoder for these
/// fixed argument shapes). The `export-abi` build uses the SDK's `#[public]` router over
/// the same functions, which is what prints the Solidity interface.
#[cfg(any(target_arch = "wasm32", feature = "export-abi"))]
#[allow(non_snake_case)]
mod contract {
    use stylus_sdk::prelude::*;

    #[storage]
    #[entrypoint]
    pub struct RiskKernel;

    #[cfg(not(feature = "export-abi"))]
    impl stylus_sdk::abi::Router<RiskKernel> for RiskKernel {
        type Storage = RiskKernel;

        fn route(storage: &mut RiskKernel, selector: u32, input: &[u8]) -> Option<stylus_sdk::ArbResult> {
            use stylus_sdk::stylus_core::ValueDenier;
            if !crate::codec::known(selector) {
                return None;
            }
            // every IRiskKernel function is non-payable
            if let Err(e) = storage.deny_value("") {
                return Some(Err(e));
            }
            crate::codec::call(selector, input)
        }

        fn receive(_storage: &mut RiskKernel) -> Option<Result<(), alloc::vec::Vec<u8>>> {
            None
        }

        fn fallback(_storage: &mut RiskKernel, _calldata: &[u8]) -> Option<stylus_sdk::ArbResult> {
            None
        }

        fn constructor(_storage: &mut RiskKernel, _calldata: &[u8]) -> Option<stylus_sdk::ArbResult> {
            None
        }
    }

    #[cfg(feature = "export-abi")]
    mod sdk_router {
        use alloc::vec::Vec;

        use alloy_primitives::{I256, U256};
        use stylus_sdk::prelude::*;

        use super::RiskKernel;
        use crate::codec::{KMarginOut, KParams, KPosition, KUnderlying, KernelRevert};
        use crate::margin::{KParamsR, KPositionR, KUnderlyingR};
        use crate::{bs, margin, vol as ewma};

        fn params(p: KParams) -> KParamsR {
            KParamsR { now: p.nowTs, rate: p.rate, credit: p.diversificationCredit, short_min: p.shortOptionMinPct }
        }

        fn underlyings(us: Vec<KUnderlying>) -> Vec<KUnderlyingR> {
            us.into_iter()
                .map(|u| KUnderlyingR {
                    spot: u.spot,
                    vol: u.vol,
                    shock_range: u.shockRange,
                    vol_up: u.volUp,
                    vol_down: u.volDown,
                    token_qty: u.tokenQty,
                })
                .collect()
        }

        fn positions(ps: Vec<KPosition>) -> Vec<KPositionR> {
            ps.into_iter()
                .map(|p| KPositionR { u: p.u, is_call: p.isCall, expiry: p.expiry, strike: p.strike, qty: p.qty })
                .collect()
        }

        #[public]
        impl RiskKernel {
            pub fn margin(
                &self,
                p: KParams,
                us: Vec<KUnderlying>,
                ps: Vec<KPosition>,
            ) -> Result<(KMarginOut, Vec<I256>), KernelRevert> {
                let (o, worst) = margin::margin(&params(p), &underlyings(us), &positions(ps))?;
                let out = KMarginOut {
                    mtm: o.mtm,
                    lossIM: o.loss_im,
                    lossCorr: o.loss_corr,
                    lossIndep: o.loss_indep,
                    shortMin: o.short_min,
                    worstScenario: o.worst_scenario,
                };
                Ok((out, worst))
            }

            pub fn scenario_grid(
                &self,
                p: KParams,
                us: Vec<KUnderlying>,
                ps: Vec<KPosition>,
            ) -> Result<Vec<I256>, KernelRevert> {
                Ok(margin::scenario_grid(&params(p), &underlyings(us), &positions(ps))?)
            }

            pub fn bs_quote(
                &self,
                spot: U256,
                strike: U256,
                tau: U256,
                vol: U256,
                rate: I256,
                isCall: bool,
            ) -> Result<(U256, I256, U256, U256, I256), KernelRevert> {
                Ok(bs::quote(spot, strike, tau, vol, rate, isCall)?)
            }

            pub fn ewma_update(
                &self,
                prevR2: U256,
                prevDt: U256,
                lastPrice: U256,
                prices: Vec<U256>,
                dts: Vec<U256>,
                lambda: U256,
            ) -> Result<(U256, U256), KernelRevert> {
                Ok(ewma::ewma_update(prevR2, prevDt, lastPrice, &prices, &dts, lambda)?)
            }
        }
    }
}
