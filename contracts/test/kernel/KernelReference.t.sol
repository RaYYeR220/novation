// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {KernelReference} from "../../src/kernel/KernelReference.sol";
import {KParams, KUnderlying, KPosition, KMarginOut, SCENARIOS} from "../../src/types/Types.sol";

contract KernelReferenceTest is Test {
    KernelReference k;

    function setUp() public {
        k = new KernelReference();
    }

    // ---- fixed behavioral tests ----

    function _book1(uint256 shock, int256 tokenQty, int256 callQty)
        internal
        pure
        returns (KParams memory p, KUnderlying[] memory us, KPosition[] memory ps)
    {
        p = KParams({nowTs: 1_790_000_000, rate: 0, diversificationCredit: 0.3e18, shortOptionMinPct: 0.01e18});
        us = new KUnderlying[](1);
        us[0] = KUnderlying({spot: 180e18, vol: 0.5e18, shockRange: shock, volUp: 0.4e18, volDown: 0.3e18, tokenQty: tokenQty});
        ps = new KPosition[](callQty == 0 ? 0 : 1);
        if (callQty != 0) ps[0] = KPosition({u: 0, isCall: true, expiry: 1_790_000_000 + 7 days, strike: 198e18, qty: callQty});
    }

    function test_baseScenarioIsZero() public view {
        (KParams memory p, KUnderlying[] memory us, KPosition[] memory ps) = _book1(0.15e18, 10e18, -10e18);
        assertEq(k.scenarioGrid(p, us, ps)[19], 0);
    }

    function test_coveredCallOffsetsStock() public view {
        (KParams memory p, KUnderlying[] memory us, KPosition[] memory ps) = _book1(0.15e18, 10e18, -10e18);
        (KMarginOut memory covered,) = k.margin(p, us, ps);
        (p, us, ps) = _book1(0.15e18, 10e18, 0);
        (KMarginOut memory tokensOnly,) = k.margin(p, us, ps);
        (p, us, ps) = _book1(0.15e18, 0, -10e18);
        (KMarginOut memory naked,) = k.margin(p, us, ps);

        // The short call trims the stock's own worst-case scenario loss: lossCorr is the
        // scenario-derived worst-case loss (pre-floor), and comparing it isolates that offset.
        // lossIM additionally adds shortMin -- a flat per-short-option floor (shortOptionMinPct)
        // that tokensOnly never carries (no short option) and that isn't reduced by the stock
        // hedge, so lossIM(covered) vs lossIM(tokensOnly) would compare across that floor rather
        // than testing hedge quality: covered.lossIM (283.16e18) > tokensOnly.lossIM (270e18)
        // purely because of the +18e18 shortMin add-on, even though covered.lossCorr (265.16e18)
        // < tokensOnly.lossCorr (270e18) shows the hedge working as intended.
        assertLt(covered.lossCorr, tokensOnly.lossCorr);

        // Portfolio offset: the combined book's full margin requirement (floor included) is less
        // than the sum of the two legs' standalone requirements.
        assertLt(covered.lossIM, tokensOnly.lossIM + naked.lossIM);
    }

    function test_weekendMultiplierWidensLoss() public view {
        (KParams memory p, KUnderlying[] memory us, KPosition[] memory ps) = _book1(0.15e18, 0, -10e18);
        (KMarginOut memory weekday,) = k.margin(p, us, ps);
        (p, us, ps) = _book1(0.2625e18, 0, -10e18); // 0.15 * 1.75
        (KMarginOut memory weekend,) = k.margin(p, us, ps);
        assertGt(weekend.lossIM, weekday.lossIM);
    }

    function test_emptyBookIsZero() public view {
        KUnderlying[] memory us = new KUnderlying[](0);
        KPosition[] memory ps = new KPosition[](0);
        (KMarginOut memory o,) = k.margin(KParams(1, 0, 0.3e18, 0.01e18), us, ps);
        assertEq(o.lossIM, 0);
        assertEq(o.mtm, 0);
    }

    function test_shortMinFloor() public view {
        (KParams memory p, KUnderlying[] memory us,) = _book1(0.1e18, 0, 0);
        KPosition[] memory ps = new KPosition[](1);
        ps[0] = KPosition({u: 0, isCall: false, expiry: p.nowTs + 7 days, strike: 60e18, qty: -10e18}); // deep OTM put
        (KMarginOut memory o,) = k.margin(p, us, ps);
        assertGe(o.lossIM, 18e18); // 10 * 180 * 1%
    }

    function test_badIndexReverts() public {
        (KParams memory p, KUnderlying[] memory us,) = _book1(0.1e18, 0, 0);
        KPosition[] memory ps = new KPosition[](1);
        ps[0] = KPosition({u: 1, isCall: true, expiry: p.nowTs + 1 days, strike: 180e18, qty: 1e18});
        vm.expectRevert(KernelReference.BadUnderlyingIndex.selector);
        k.margin(p, us, ps);
    }

    // ---- exact-equality vector tests ----

    function test_vectors_books() public view {
        string memory json = vm.readFile("test/vectors/kernel.json");

        string[] memory n_us_s = vm.parseJsonStringArray(json, ".books.n_us");
        string[] memory n_ps_s = vm.parseJsonStringArray(json, ".books.n_ps");
        string[] memory p_nowTs_s = vm.parseJsonStringArray(json, ".books.p_nowTs");
        string[] memory p_rate_s = vm.parseJsonStringArray(json, ".books.p_rate");
        string[] memory p_credit_s = vm.parseJsonStringArray(json, ".books.p_credit");
        string[] memory p_shortMin_s = vm.parseJsonStringArray(json, ".books.p_shortMin");

        string[] memory us_spot_s = vm.parseJsonStringArray(json, ".books.us_spot");
        string[] memory us_vol_s = vm.parseJsonStringArray(json, ".books.us_vol");
        string[] memory us_shock_s = vm.parseJsonStringArray(json, ".books.us_shockRange");
        string[] memory us_volUp_s = vm.parseJsonStringArray(json, ".books.us_volUp");
        string[] memory us_volDown_s = vm.parseJsonStringArray(json, ".books.us_volDown");
        string[] memory us_tokenQty_s = vm.parseJsonStringArray(json, ".books.us_tokenQty");

        string[] memory ps_u_s = vm.parseJsonStringArray(json, ".books.ps_u");
        bool[] memory ps_isCall = vm.parseJsonBoolArray(json, ".books.ps_isCall");
        string[] memory ps_expiry_s = vm.parseJsonStringArray(json, ".books.ps_expiry");
        string[] memory ps_strike_s = vm.parseJsonStringArray(json, ".books.ps_strike");
        string[] memory ps_qty_s = vm.parseJsonStringArray(json, ".books.ps_qty");

        string[] memory out_mtm_s = vm.parseJsonStringArray(json, ".books.out_mtm");
        string[] memory out_lossIM_s = vm.parseJsonStringArray(json, ".books.out_lossIM");
        string[] memory out_lossCorr_s = vm.parseJsonStringArray(json, ".books.out_lossCorr");
        string[] memory out_lossIndep_s = vm.parseJsonStringArray(json, ".books.out_lossIndep");
        string[] memory out_shortMin_s = vm.parseJsonStringArray(json, ".books.out_shortMin");
        string[] memory out_worst_s = vm.parseJsonStringArray(json, ".books.out_worstScenario");
        string[] memory out_puw_s = vm.parseJsonStringArray(json, ".books.out_perUnderlyingWorst");
        string[] memory out_sg_s = vm.parseJsonStringArray(json, ".books.out_scenarioGrid");

        uint256 nBooks = n_us_s.length;
        assertGt(nBooks, 0);

        uint256 usOff;
        uint256 psOff;
        uint256 puwOff;
        uint256 sgOff;

        for (uint256 bi = 0; bi < nBooks; bi++) {
            uint256 nu = vm.parseUint(n_us_s[bi]);
            uint256 npn = vm.parseUint(n_ps_s[bi]);

            KParams memory p = KParams({
                nowTs: vm.parseUint(p_nowTs_s[bi]),
                rate: vm.parseInt(p_rate_s[bi]),
                diversificationCredit: vm.parseUint(p_credit_s[bi]),
                shortOptionMinPct: vm.parseUint(p_shortMin_s[bi])
            });

            KUnderlying[] memory us = new KUnderlying[](nu);
            for (uint256 j = 0; j < nu; j++) {
                uint256 idx = usOff + j;
                us[j] = KUnderlying({
                    spot: vm.parseUint(us_spot_s[idx]),
                    vol: vm.parseUint(us_vol_s[idx]),
                    shockRange: vm.parseUint(us_shock_s[idx]),
                    volUp: vm.parseUint(us_volUp_s[idx]),
                    volDown: vm.parseUint(us_volDown_s[idx]),
                    tokenQty: vm.parseInt(us_tokenQty_s[idx])
                });
            }

            KPosition[] memory ps = new KPosition[](npn);
            for (uint256 j = 0; j < npn; j++) {
                uint256 idx = psOff + j;
                ps[j] = KPosition({
                    u: vm.parseUint(ps_u_s[idx]),
                    isCall: ps_isCall[idx],
                    expiry: vm.parseUint(ps_expiry_s[idx]),
                    strike: vm.parseUint(ps_strike_s[idx]),
                    qty: vm.parseInt(ps_qty_s[idx])
                });
            }

            (KMarginOut memory out, int256[] memory puw) = k.margin(p, us, ps);

            assertEq(out.mtm, vm.parseInt(out_mtm_s[bi]), "mtm mismatch");
            assertEq(out.lossIM, vm.parseUint(out_lossIM_s[bi]), "lossIM mismatch");
            assertEq(out.lossCorr, vm.parseUint(out_lossCorr_s[bi]), "lossCorr mismatch");
            assertEq(out.lossIndep, vm.parseUint(out_lossIndep_s[bi]), "lossIndep mismatch");
            assertEq(out.shortMin, vm.parseUint(out_shortMin_s[bi]), "shortMin mismatch");
            assertEq(out.worstScenario, vm.parseUint(out_worst_s[bi]), "worstScenario mismatch");

            assertEq(puw.length, nu);
            for (uint256 j = 0; j < nu; j++) {
                assertEq(puw[j], vm.parseInt(out_puw_s[puwOff + j]), "perUnderlyingWorst mismatch");
            }

            int256[] memory sg = k.scenarioGrid(p, us, ps);
            assertEq(sg.length, SCENARIOS);
            for (uint256 s = 0; s < SCENARIOS; s++) {
                assertEq(sg[s], vm.parseInt(out_sg_s[sgOff + s]), "scenarioGrid mismatch");
            }

            usOff += nu;
            psOff += npn;
            puwOff += nu;
            sgOff += SCENARIOS;
        }
    }

    function test_vectors_ewmaUpdate() public view {
        string memory json = vm.readFile("test/vectors/kernel.json");

        string[] memory n_s = vm.parseJsonStringArray(json, ".ewma.n");
        string[] memory prevR2_s = vm.parseJsonStringArray(json, ".ewma.prevR2");
        string[] memory prevDt_s = vm.parseJsonStringArray(json, ".ewma.prevDt");
        string[] memory lastPrice_s = vm.parseJsonStringArray(json, ".ewma.lastPrice");
        string[] memory lambda_s = vm.parseJsonStringArray(json, ".ewma.lambda");
        string[] memory prices_s = vm.parseJsonStringArray(json, ".ewma.prices");
        string[] memory dts_s = vm.parseJsonStringArray(json, ".ewma.dts");
        string[] memory out_r2_s = vm.parseJsonStringArray(json, ".ewma.out_r2");
        string[] memory out_dt_s = vm.parseJsonStringArray(json, ".ewma.out_dt");

        uint256 nCases = n_s.length;
        assertGt(nCases, 0);
        uint256 off;

        for (uint256 ci = 0; ci < nCases; ci++) {
            uint256 n = vm.parseUint(n_s[ci]);
            uint256[] memory prices = new uint256[](n);
            uint256[] memory dts = new uint256[](n);
            for (uint256 j = 0; j < n; j++) {
                prices[j] = vm.parseUint(prices_s[off + j]);
                dts[j] = vm.parseUint(dts_s[off + j]);
            }

            (uint256 r2, uint256 dt) = k.ewmaUpdate(
                vm.parseUint(prevR2_s[ci]), vm.parseUint(prevDt_s[ci]), vm.parseUint(lastPrice_s[ci]), prices, dts, vm.parseUint(lambda_s[ci])
            );

            assertEq(r2, vm.parseUint(out_r2_s[ci]), "r2 mismatch");
            assertEq(dt, vm.parseUint(out_dt_s[ci]), "dt mismatch");

            off += n;
        }
    }

    function test_vectors_bsQuote() public view {
        string memory json = vm.readFile("test/vectors/kernel.json");

        string[] memory spot_s = vm.parseJsonStringArray(json, ".bsQuote.spot");
        string[] memory strike_s = vm.parseJsonStringArray(json, ".bsQuote.strike");
        string[] memory tau_s = vm.parseJsonStringArray(json, ".bsQuote.tau");
        string[] memory vol_s = vm.parseJsonStringArray(json, ".bsQuote.vol");
        string[] memory rate_s = vm.parseJsonStringArray(json, ".bsQuote.rate");
        bool[] memory isCall = vm.parseJsonBoolArray(json, ".bsQuote.isCall");
        string[] memory price_s = vm.parseJsonStringArray(json, ".bsQuote.price");
        string[] memory delta_s = vm.parseJsonStringArray(json, ".bsQuote.delta");
        string[] memory gamma_s = vm.parseJsonStringArray(json, ".bsQuote.gamma");
        string[] memory vega_s = vm.parseJsonStringArray(json, ".bsQuote.vega");
        string[] memory theta_s = vm.parseJsonStringArray(json, ".bsQuote.theta");

        uint256 n = spot_s.length;
        assertGt(n, 0);

        for (uint256 i = 0; i < n; i++) {
            (uint256 price, int256 delta, uint256 gamma, uint256 vega, int256 theta) = k.bsQuote(
                vm.parseUint(spot_s[i]), vm.parseUint(strike_s[i]), vm.parseUint(tau_s[i]), vm.parseUint(vol_s[i]), vm.parseInt(rate_s[i]), isCall[i]
            );

            assertEq(price, vm.parseUint(price_s[i]), "price mismatch");
            assertEq(delta, vm.parseInt(delta_s[i]), "delta mismatch");
            assertEq(gamma, vm.parseUint(gamma_s[i]), "gamma mismatch");
            assertEq(vega, vm.parseUint(vega_s[i]), "vega mismatch");
            assertEq(theta, vm.parseInt(theta_s[i]), "theta mismatch");
        }
    }
}
