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

    function test_tradableSecondsSkipsWeekend() public pure {
        uint256 fri1940 = 1790379600; // 2026-09-25 19:40 EDT
        uint256 sun2000 = 1790553600; // 2026-09-27 20:00 EDT, the window reopens
        uint256 big = 30 days;
        assertEq(NyseCalendar.tradableSeconds(fri1940, sun2000, big), 20 minutes);
        assertEq(NyseCalendar.tradableSeconds(fri1940, sun2000 + 300, big), 25 minutes);
        assertEq(NyseCalendar.tradableSeconds(1790424000, sun2000, big), 0); // from Saturday noon
        assertEq(NyseCalendar.tradableSeconds(sun2000 - 1, sun2000 + 1, big), 1);
        assertEq(NyseCalendar.tradableSeconds(fri1940, fri1940, big), 0);
        assertEq(NyseCalendar.tradableSeconds(sun2000, fri1940, big), 0);
        // the cap stops the walk
        assertEq(NyseCalendar.tradableSeconds(fri1940, sun2000 + 1 days, 1800), 1800);
        assertEq(NyseCalendar.tradableSeconds(fri1940 - 3 days, fri1940, 1800), 1800);
        // a whole trading week: Sunday 20:00 to Friday 20:00
        assertEq(NyseCalendar.tradableSeconds(sun2000 - 7 days, sun2000, big), 5 days);
    }

    function test_tradableSecondsHolidayAndDst() public pure {
        // Thanksgiving 2026: the window closes Wednesday 20:00 EST and reopens Thursday 20:00 EST
        uint256 wed1900 = 1795651200; // 2026-11-25 19:00 EST
        uint256 thu2000 = 1795741200; // 2026-11-26 20:00 EST
        assertEq(NyseCalendar.tradableSeconds(wed1900, thu2000 + 600, 30 days), 1 hours + 10 minutes);
        assertEq(uint8(NyseCalendar.baseSession(thu2000 - 1)), uint8(Session.HOLIDAY));
        assertEq(uint8(NyseCalendar.baseSession(thu2000)), uint8(Session.EXTENDED));
        // the clocks fall back on 2026-11-01: Friday 20:00 EDT to Sunday 20:00 EST is closed
        uint256 fri1900 = 1793401200; // 2026-10-30 19:00 EDT
        uint256 sun2000 = 1793581200; // 2026-11-01 20:00 EST
        assertEq(NyseCalendar.tradableSeconds(fri1900, sun2000 + 1800, 30 days), 1 hours + 30 minutes);
        assertEq(uint8(NyseCalendar.baseSession(sun2000 - 1)), uint8(Session.WEEKEND));
        assertEq(uint8(NyseCalendar.baseSession(sun2000)), uint8(Session.EXTENDED));
    }

    /// tradableSeconds agrees with baseSession, second by second, sampled across a year.
    function testFuzz_tradableSecondsMatchesSessions(uint256 from, uint256 len) public pure {
        from = bound(from, 1767225600, 1829606400); // 2026-01-01 .. 2027-12-24
        len = bound(len, 1, 4 days);
        uint256 step = 15 minutes;
        uint256 expect;
        // count whole steps aligned on the grid, so each step is uniformly open or closed (all
        // window edges fall on a full hour)
        uint256 a = from - from % step;
        uint256 b = a + (len - len % step) + step;
        for (uint256 t = a; t < b; t += step) {
            Session s = NyseCalendar.baseSession(t);
            if (s == Session.REGULAR || s == Session.EXTENDED) expect += step;
        }
        assertEq(NyseCalendar.tradableSeconds(a, b, 30 days), expect);
    }

    function testFuzz_expiryIsTradingDayClose(uint256 ts) public pure {
        ts = bound(ts, 1767225600, 1829606400); // 2026-01-01 .. 2027-12-24 (keeps the next expiry inside the 2027 table)
        uint256 e = NyseCalendar.nextWeeklyExpiry(ts);
        assertTrue(e > ts && NyseCalendar.isWeeklyExpiry(e));
        assertLe(e - ts, 8 days);
    }
}
