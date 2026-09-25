//! The Solidity interface the SDK exports for the program, checked against
//! `abi/IRiskKernel.exported.sol`. Run with `cargo test --features export-abi --test export_abi`;
//! set `UPDATE_ABI=1` to rewrite the file.
#![cfg(feature = "export-abi")]

use core::fmt;

use novation_kernel::codec::{KMarginOut, KParams, KPosition, KUnderlying};
use novation_kernel::RiskKernel;
use stylus_sdk::abi::export::internal::InnerTypes;
use stylus_sdk::abi::GenerateAbi;

struct Abi;

impl fmt::Display for Abi {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        RiskKernel::fmt_abi(f)
    }
}

/// The struct definitions the interface refers to (the SDK prints none of them for these signatures).
fn structs() -> String {
    let mut out = String::new();
    let all = [KParams::inner_types(), KUnderlying::inner_types(), KPosition::inner_types(), KMarginOut::inner_types()];
    for types in all {
        for t in types {
            out.push_str(&t.name.replace('{', " { ").replace(';', "; ").replace("  ", " "));
            out.push('\n');
        }
    }
    out
}

#[test]
fn exported_abi_matches_file() {
    let text = format!(
        "// SPDX-License-Identifier: MIT\n\
         // Interface exported from the Stylus risk kernel (`cargo test --features export-abi --test export_abi`).\n\
         // It must keep the selectors of contracts/src/interfaces/IRiskKernel.sol.\n\
         pragma solidity 0.8.30;\n\n{}\n{}",
        structs(),
        Abi
    );
    let path = format!("{}/abi/IRiskKernel.exported.sol", env!("CARGO_MANIFEST_DIR"));
    if std::env::var("UPDATE_ABI").is_ok() {
        std::fs::write(&path, &text).unwrap();
    }
    println!("{text}");
    let committed = std::fs::read_to_string(&path).unwrap_or_default().replace("\r\n", "\n");
    assert_eq!(committed, text, "exported ABI changed; rerun with UPDATE_ABI=1 and review the diff");
}
