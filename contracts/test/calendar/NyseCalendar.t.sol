// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {NyseCalendar} from "../../src/libraries/NyseCalendar.sol";
import {Session} from "../../src/types/Types.sol";

contract NyseCalendarTest is Test {
    function test_regularSessionSummer() public pure {
        // 2026-09-25 (Fri) 14:00 UTC = 10:00 EDT
        assertEq(uint8(NyseCalendar.baseSession(1790344800)), uint8(Session.REGULAR));
    }

    function test_weekend() public pure {
        // 2026-09-26 (Sat) 15:00 UTC
        assertEq(uint8(NyseCalendar.baseSession(1790434800)), uint8(Session.WEEKEND));
    }

    function test_sundayEveningIsExtended() public pure {
        // 2026-09-27 (Sun) 20:30 EDT = 2026-09-28 00:30 UTC
        assertEq(uint8(NyseCalendar.baseSession(1790555400)), uint8(Session.EXTENDED));
    }

    function test_fridayCloseIsExpiry() public pure {
        // 2026-09-25 16:00 EDT = 20:00 UTC
        assertTrue(NyseCalendar.isWeeklyExpiry(1790366400));
        assertFalse(NyseCalendar.isWeeklyExpiry(1790366400 + 1));
        assertFalse(NyseCalendar.isWeeklyExpiry(1790366400 - 86400)); // Thursday close is not the weekly expiry
    }

    function test_goodFridayMovesExpiryToThursday() public pure {
        // 2026-04-02 (Thu) 16:00 EDT = 20:00 UTC; 2026-04-03 is a holiday
        assertTrue(NyseCalendar.isWeeklyExpiry(1775160000));
    }

    function test_blackFridayEarlyClose() public pure {
        // 2026-11-27 (Fri) 13:00 EST = 18:00 UTC
        assertTrue(NyseCalendar.isWeeklyExpiry(1795802400));
    }

    function test_dstBoundaries2026() public pure {
        assertFalse(NyseCalendar.isDst(1772953199)); // 2026-03-08 06:59:59 UTC
        assertTrue(NyseCalendar.isDst(1772953200)); // 2026-03-08 07:00:00 UTC
        assertTrue(NyseCalendar.isDst(1793512799)); // 2026-11-01 05:59:59 UTC
        assertFalse(NyseCalendar.isDst(1793512800)); // 2026-11-01 06:00:00 UTC
    }

    function test_nextWeeklyExpiry() public pure {
        assertEq(NyseCalendar.nextWeeklyExpiry(1790344800), 1790366400);
    }

    function testFuzz_expiryIsTradingDayClose(uint256 ts) public pure {
        ts = bound(ts, 1767225600, 1829606400); // 2026-01-01 .. 2027-12-24 (keeps the next expiry inside the 2027 table)
        uint256 e = NyseCalendar.nextWeeklyExpiry(ts);
        assertTrue(e > ts && NyseCalendar.isWeeklyExpiry(e));
        assertLe(e - ts, 8 days);
    }
}
