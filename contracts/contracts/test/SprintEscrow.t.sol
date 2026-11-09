// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {SprintEscrow} from "../SprintEscrow.sol";
import {MockSQK, FeeToken, ReentrantToken, IEscrowHook} from "./Mocks.sol";

contract SprintEscrowTest is Test {
    SprintEscrow esc;
    MockSQK sqk;

    uint256 refKey = 0xA11CE;
    address referee;
    uint256 aKey = 0xA;
    uint256 bKey = 0xB;
    address alice;
    address bob;
    address owner = address(0x0123);
    address stranger = address(0xBAD);
    uint256 constant STAKE = 100 ether;
    bytes32 constant ID = keccak256("match-1");
    uint256 constant FEE_BPS = 500; // 5%, fixed in the contract
    uint256 constant FEE = (2 * STAKE * FEE_BPS) / 10_000;

    function setUp() public {
        vm.warp(1_800_000_000);
        referee = vm.addr(refKey);
        alice = vm.addr(aKey);
        bob = vm.addr(bKey);
        sqk = new MockSQK();
        esc = new SprintEscrow(IERC20(address(sqk)), referee, owner);
        for (uint256 i; i < 2; i++) {
            address p = i == 0 ? alice : bob;
            sqk.mint(p, 1000 ether);
            vm.prank(p);
            sqk.approve(address(esc), type(uint256).max);
        }
    }

    // ------------------------------------------------------------ helpers

    function ticket(bytes32 id, uint256 stake) internal view returns (SprintEscrow.Ticket memory) {
        return SprintEscrow.Ticket(id, alice, bob, stake, uint64(block.timestamp + 10 minutes));
    }

    /// The EIP-712 digest computed by hand, the way a wallet or viem's signTypedData would.
    function manualTicketDigest(address escrow, SprintEscrow.Ticket memory t) internal view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("SqueekSprintEscrow"),
                keccak256("1"),
                block.chainid,
                escrow
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Ticket(bytes32 matchId,address playerA,address playerB,uint256 stake,uint64 joinDeadline)"),
                t.matchId,
                t.playerA,
                t.playerB,
                t.stake,
                t.joinDeadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function manualResultDigest(address escrow, SprintEscrow.Result memory r) internal view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("SqueekSprintEscrow"),
                keccak256("1"),
                block.chainid,
                escrow
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(keccak256("Result(bytes32 matchId,uint8 outcome,bytes32 replayHash)"), r.matchId, uint8(r.outcome), r.replayHash)
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function signTicket(SprintEscrow.Ticket memory t) internal view returns (bytes memory) {
        return sign(refKey, manualTicketDigest(address(esc), t));
    }

    function signResult(SprintEscrow.Result memory r) internal view returns (bytes memory) {
        return sign(refKey, manualResultDigest(address(esc), r));
    }

    function result(bytes32 id, SprintEscrow.Outcome o) internal pure returns (SprintEscrow.Result memory) {
        return SprintEscrow.Result(id, o, keccak256("replay"));
    }

    function bothDeposit(SprintEscrow.Ticket memory t) internal {
        bytes memory sig = signTicket(t);
        vm.prank(t.playerA);
        esc.deposit(t, sig);
        vm.prank(t.playerB);
        esc.deposit(t, sig);
    }

    // ------------------------------------------------------------ digests match the standard

    function test_digestsMatchEip712() public view {
        SprintEscrow.Ticket memory t = ticket(ID, STAKE);
        assertEq(esc.ticketDigest(t), manualTicketDigest(address(esc), t));
        SprintEscrow.Result memory r = result(ID, SprintEscrow.Outcome.Draw);
        assertEq(esc.resultDigest(r), manualResultDigest(address(esc), r));
    }

    // ------------------------------------------------------------ happy paths

    function test_aWinsTakesBothStakes() public {
        bothDeposit(ticket(ID, STAKE));
        assertEq(uint8(esc.getMatch(ID).status), uint8(SprintEscrow.Status.Active));
        assertEq(sqk.balanceOf(address(esc)), 2 * STAKE);
        SprintEscrow.Result memory r = result(ID, SprintEscrow.Outcome.AWins);
        vm.prank(stranger); // anyone can submit; money still goes to the winner
        esc.settle(r, signResult(r));
        assertEq(sqk.balanceOf(alice), 1000 ether + STAKE - FEE);
        assertEq(sqk.balanceOf(bob), 1000 ether - STAKE);
        // Only the fee stays behind, booked as earned.
        assertEq(sqk.balanceOf(address(esc)), FEE);
        assertEq(esc.accruedFees(), FEE);
        assertEq(sqk.balanceOf(stranger), 0);
    }

    function test_bWins() public {
        bothDeposit(ticket(ID, STAKE));
        SprintEscrow.Result memory r = result(ID, SprintEscrow.Outcome.BWins);
        esc.settle(r, signResult(r));
        assertEq(sqk.balanceOf(bob), 1000 ether + STAKE - FEE);
        assertEq(sqk.balanceOf(alice), 1000 ether - STAKE);
    }

    function test_drawRefundsBoth() public {
        bothDeposit(ticket(ID, STAKE));
        SprintEscrow.Result memory r = result(ID, SprintEscrow.Outcome.Draw);
        esc.settle(r, signResult(r));
        assertEq(sqk.balanceOf(alice), 1000 ether);
        assertEq(sqk.balanceOf(bob), 1000 ether);
        assertEq(sqk.balanceOf(address(esc)), 0);
        assertEq(esc.accruedFees(), 0);
    }

    function test_depositWithPermit() public {
        uint256 cKey = 0xC;
        address carol = vm.addr(cKey);
        sqk.mint(carol, STAKE);
        SprintEscrow.Ticket memory t = SprintEscrow.Ticket(ID, carol, bob, STAKE, uint64(block.timestamp + 5 minutes));
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 permitHash = keccak256(
            abi.encodePacked(
                "\x19\x01",
                sqk.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                        carol,
                        address(esc),
                        STAKE,
                        sqk.nonces(carol),
                        deadline
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(cKey, permitHash);
        vm.prank(carol);
        esc.depositWithPermit(t, signTicket(t), deadline, v, r, s);
        assertEq(sqk.balanceOf(address(esc)), STAKE);
        assertTrue(esc.getMatch(ID).paidA);
    }

    // ------------------------------------------------------------ tickets

    function test_rejectsTicketNotSignedByReferee() public {
        SprintEscrow.Ticket memory t = ticket(ID, STAKE);
        bytes memory forged = sign(0xBEEF, manualTicketDigest(address(esc), t));
        vm.prank(alice);
        vm.expectRevert(SprintEscrow.BadSignature.selector);
        esc.deposit(t, forged);
    }

    function test_rejectsTamperedTicket() public {
        SprintEscrow.Ticket memory t = ticket(ID, STAKE);
        bytes memory sig = signTicket(t);
        t.stake = 1 ether; // player tries to pay less
        vm.prank(alice);
        vm.expectRevert(SprintEscrow.BadSignature.selector);
        esc.deposit(t, sig);
    }

    function test_onlyThePlayersCanDeposit() public {
        SprintEscrow.Ticket memory t = ticket(ID, STAKE);
        bytes memory sig = signTicket(t);
        sqk.mint(stranger, STAKE);
        vm.startPrank(stranger);
        sqk.approve(address(esc), STAKE);
        vm.expectRevert(SprintEscrow.NotAPlayer.selector);
        esc.deposit(t, sig);
        vm.stopPrank();
    }

    function test_cannotDepositTwice() public {
        SprintEscrow.Ticket memory t = ticket(ID, STAKE);
        bytes memory sig = signTicket(t);
        vm.startPrank(alice);
        esc.deposit(t, sig);
        vm.expectRevert(SprintEscrow.AlreadyDeposited.selector);
        esc.deposit(t, sig);
        vm.stopPrank();
    }

    function test_cannotDepositAfterJoinDeadline() public {
        SprintEscrow.Ticket memory t = ticket(ID, STAKE);
        bytes memory sig = signTicket(t);
        vm.warp(t.joinDeadline + 1);
        vm.prank(alice);
        vm.expectRevert(SprintEscrow.JoinClosed.selector);
        esc.deposit(t, sig);
    }

    function test_rejectsFarJoinDeadline() public {
        SprintEscrow.Ticket memory t = ticket(ID, STAKE);
        t.joinDeadline = uint64(block.timestamp + 2 hours);
        bytes memory sig = signTicket(t);
        vm.prank(alice);
        vm.expectRevert(SprintEscrow.BadTicket.selector);
        esc.deposit(t, sig);
    }

    function test_rejectsBadTicketShapes() public {
        SprintEscrow.Ticket memory t = ticket(ID, 0);
        bytes memory sig = signTicket(t);
        vm.prank(alice);
        vm.expectRevert(SprintEscrow.BadTicket.selector);
        esc.deposit(t, sig);

        t = SprintEscrow.Ticket(ID, alice, alice, STAKE, uint64(block.timestamp + 1 minutes));
        sig = signTicket(t);
        vm.prank(alice);
        vm.expectRevert(SprintEscrow.BadTicket.selector);
        esc.deposit(t, sig);

        t = ticket(ID, uint256(type(uint96).max) + 1);
        sig = signTicket(t);
        vm.prank(alice);
        vm.expectRevert(SprintEscrow.BadTicket.selector);
        esc.deposit(t, sig);
    }

    function test_sameIdDifferentTermsRejected() public {
        SprintEscrow.Ticket memory t1 = ticket(ID, STAKE);
        vm.prank(alice);
        esc.deposit(t1, signTicket(t1));
        SprintEscrow.Ticket memory t2 = ticket(ID, STAKE / 2);
        vm.prank(bob);
        vm.expectRevert(SprintEscrow.BadTicket.selector);
        esc.deposit(t2, signTicket(t2));
    }

    function test_signatureForAnotherEscrowFails() public {
        SprintEscrow other = new SprintEscrow(IERC20(address(sqk)), referee, owner);
        SprintEscrow.Ticket memory t = ticket(ID, STAKE);
        bytes memory sigForOther = sign(refKey, manualTicketDigest(address(other), t));
        vm.prank(alice);
        vm.expectRevert(SprintEscrow.BadSignature.selector);
        esc.deposit(t, sigForOther);
    }

    // ------------------------------------------------------------ results

    function test_cannotSettleBeforeBothDeposit() public {
        SprintEscrow.Ticket memory t = ticket(ID, STAKE);
        vm.prank(alice);
        esc.deposit(t, signTicket(t));
        SprintEscrow.Result memory r = result(ID, SprintEscrow.Outcome.AWins);
        bytes memory sig = signResult(r);
        vm.expectRevert(abi.encodeWithSelector(SprintEscrow.WrongStatus.selector, SprintEscrow.Status.Open));
        esc.settle(r, sig);
    }

    function test_cannotSettleTwice() public {
        bothDeposit(ticket(ID, STAKE));
        SprintEscrow.Result memory r = result(ID, SprintEscrow.Outcome.AWins);
        bytes memory sig = signResult(r);
        esc.settle(r, sig);
        vm.expectRevert(abi.encodeWithSelector(SprintEscrow.WrongStatus.selector, SprintEscrow.Status.Settled));
        esc.settle(r, sig);
    }

    function test_rejectsForgedOrSwappedResult() public {
        bothDeposit(ticket(ID, STAKE));
        SprintEscrow.Result memory r = result(ID, SprintEscrow.Outcome.AWins);
        // Signed by a player instead of the server.
        bytes memory bad = sign(bKey, manualResultDigest(address(esc), result(ID, SprintEscrow.Outcome.BWins)));
        vm.expectRevert(SprintEscrow.BadSignature.selector);
        esc.settle(result(ID, SprintEscrow.Outcome.BWins), bad);
        // The server's signature for "A wins" can't be reused for "B wins".
        bytes memory good = signResult(r);
        vm.expectRevert(SprintEscrow.BadSignature.selector);
        esc.settle(result(ID, SprintEscrow.Outcome.BWins), good);
        // Nor for another match.
        bytes32 id2 = keccak256("match-2");
        bothDeposit(ticket(id2, STAKE));
        vm.expectRevert(SprintEscrow.BadSignature.selector);
        esc.settle(result(id2, SprintEscrow.Outcome.AWins), good);
    }

    function test_rejectsNoneOutcome() public {
        bothDeposit(ticket(ID, STAKE));
        SprintEscrow.Result memory r = result(ID, SprintEscrow.Outcome.None);
        bytes memory sig = signResult(r);
        vm.expectRevert(SprintEscrow.BadOutcome.selector);
        esc.settle(r, sig);
    }

    // ------------------------------------------------------------ cancel and refund

    function test_cancelGivesBackTheOnlyDepositorAfterDeadline() public {
        SprintEscrow.Ticket memory t = ticket(ID, STAKE);
        vm.prank(alice);
        esc.deposit(t, signTicket(t));
        vm.expectRevert(SprintEscrow.JoinStillOpen.selector);
        esc.cancel(ID);
        vm.warp(t.joinDeadline + 1);
        vm.prank(stranger);
        esc.cancel(ID);
        assertEq(sqk.balanceOf(alice), 1000 ether);
        assertEq(sqk.balanceOf(stranger), 0);
        assertEq(uint8(esc.getMatch(ID).status), uint8(SprintEscrow.Status.Refunded));
        // Can't cancel again or deposit into it.
        vm.expectRevert(abi.encodeWithSelector(SprintEscrow.WrongStatus.selector, SprintEscrow.Status.Refunded));
        esc.cancel(ID);
    }

    function test_cancelBPaidOnly() public {
        SprintEscrow.Ticket memory t = ticket(ID, STAKE);
        vm.prank(bob);
        esc.deposit(t, signTicket(t));
        vm.warp(t.joinDeadline + 1);
        esc.cancel(ID);
        assertEq(sqk.balanceOf(bob), 1000 ether);
        assertEq(sqk.balanceOf(alice), 1000 ether);
    }

    function test_cannotCancelAnActiveMatch() public {
        SprintEscrow.Ticket memory t = ticket(ID, STAKE);
        bothDeposit(t);
        vm.warp(t.joinDeadline + 1);
        vm.expectRevert(abi.encodeWithSelector(SprintEscrow.WrongStatus.selector, SprintEscrow.Status.Active));
        esc.cancel(ID);
    }

    function test_refundAfterSettleWindowIfServerSilent() public {
        bothDeposit(ticket(ID, STAKE));
        vm.expectRevert(SprintEscrow.SettleWindowOpen.selector);
        esc.refund(ID);
        vm.warp(block.timestamp + esc.SETTLE_WINDOW() + 1);
        esc.refund(ID);
        assertEq(sqk.balanceOf(alice), 1000 ether);
        assertEq(sqk.balanceOf(bob), 1000 ether);
        // A late result can't pay out a second time.
        SprintEscrow.Result memory r = result(ID, SprintEscrow.Outcome.AWins);
        bytes memory sig = signResult(r);
        vm.expectRevert(abi.encodeWithSelector(SprintEscrow.WrongStatus.selector, SprintEscrow.Status.Refunded));
        esc.settle(r, sig);
    }

    function test_lateResultStillWinsIfNobodyRefunded() public {
        bothDeposit(ticket(ID, STAKE));
        vm.warp(block.timestamp + esc.SETTLE_WINDOW() + 1);
        SprintEscrow.Result memory r = result(ID, SprintEscrow.Outcome.BWins);
        esc.settle(r, signResult(r));
        assertEq(sqk.balanceOf(bob), 1000 ether + STAKE - FEE);
        vm.expectRevert(abi.encodeWithSelector(SprintEscrow.WrongStatus.selector, SprintEscrow.Status.Settled));
        esc.refund(ID);
    }

    // ------------------------------------------------------------ owner powers are narrow

    function test_pauseStopsOnlyNewDeposits() public {
        SprintEscrow.Ticket memory t = ticket(ID, STAKE);
        bothDeposit(t);
        bytes32 id2 = keccak256("match-2");
        SprintEscrow.Ticket memory t2 = ticket(id2, STAKE);
        vm.prank(alice);
        esc.deposit(t2, signTicket(t2));

        vm.prank(owner);
        esc.pause();
        vm.prank(bob);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        esc.deposit(t2, signTicket(t2));

        // Settling, cancelling and refunding still work while paused.
        SprintEscrow.Result memory r = result(ID, SprintEscrow.Outcome.AWins);
        esc.settle(r, signResult(r));
        vm.warp(t2.joinDeadline + 1);
        esc.cancel(id2);
        assertEq(sqk.balanceOf(address(esc)), esc.accruedFees());
    }

    function test_onlyOwnerAdmin() public {
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        esc.setReferee(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        esc.pause();
        vm.stopPrank();
        vm.prank(owner);
        vm.expectRevert(SprintEscrow.CannotRenounce.selector);
        esc.renounceOwnership();
    }

    function test_ownershipTransferNeedsAcceptance() public {
        vm.prank(owner);
        esc.transferOwnership(alice);
        assertEq(esc.owner(), owner);
        vm.prank(alice);
        esc.acceptOwnership();
        assertEq(esc.owner(), alice);
    }

    function test_rotatedRefereeInvalidatesOldSignatures() public {
        bothDeposit(ticket(ID, STAKE));
        SprintEscrow.Result memory r = result(ID, SprintEscrow.Outcome.AWins);
        bytes memory oldSig = signResult(r);
        uint256 newKey = 0xFACE;
        vm.prank(owner);
        esc.setReferee(vm.addr(newKey));
        vm.expectRevert(SprintEscrow.BadSignature.selector);
        esc.settle(r, oldSig);
        esc.settle(r, sign(newKey, manualResultDigest(address(esc), r)));
        assertEq(sqk.balanceOf(alice), 1000 ether + STAKE - FEE);
    }

    function test_constructorRejectsZero() public {
        vm.expectRevert(SprintEscrow.ZeroAddress.selector);
        new SprintEscrow(IERC20(address(0)), referee, owner);
        vm.expectRevert(SprintEscrow.ZeroAddress.selector);
        new SprintEscrow(IERC20(address(sqk)), address(0), owner);
    }

    // ------------------------------------------------------------ hostile tokens

    function test_feeOnTransferTokenRefused() public {
        FeeToken fee = new FeeToken();
        SprintEscrow e2 = new SprintEscrow(IERC20(address(fee)), referee, owner);
        fee.mint(alice, STAKE);
        vm.prank(alice);
        fee.approve(address(e2), STAKE);
        SprintEscrow.Ticket memory t = ticket(ID, STAKE);
        bytes memory sig = sign(refKey, manualTicketDigest(address(e2), t));
        vm.prank(alice);
        vm.expectRevert(SprintEscrow.TransferMismatch.selector);
        e2.deposit(t, sig);
    }

    function test_reentryDuringPayoutIsBlocked() public {
        ReentrantToken re = new ReentrantToken();
        SprintEscrow e2 = new SprintEscrow(IERC20(address(re)), referee, owner);
        for (uint256 i; i < 2; i++) {
            address p = i == 0 ? alice : bob;
            re.mint(p, STAKE);
            vm.prank(p);
            re.approve(address(e2), STAKE);
        }
        SprintEscrow.Ticket memory t = ticket(ID, STAKE);
        bytes memory sig = sign(refKey, manualTicketDigest(address(e2), t));
        vm.prank(alice);
        e2.deposit(t, sig);
        vm.prank(bob);
        e2.deposit(t, sig);
        vm.warp(block.timestamp + e2.SETTLE_WINDOW() + 1);
        re.arm(IEscrowHook(address(e2)), ID);
        e2.refund(ID);
        assertFalse(re.reentered());
        assertEq(re.balanceOf(alice), STAKE);
        assertEq(re.balanceOf(bob), STAKE);
        assertEq(re.balanceOf(address(e2)), 0);
    }

    // ------------------------------------------------------------ fuzz: money is always conserved

    function testFuzz_settlementConservesMoney(uint96 stake, uint8 rawOutcome) public {
        stake = uint96(bound(stake, 1, 1000 ether));
        SprintEscrow.Outcome o = SprintEscrow.Outcome(bound(rawOutcome, 1, 3));
        bothDeposit(ticket(ID, stake));
        SprintEscrow.Result memory r = result(ID, o);
        esc.settle(r, signResult(r));
        uint256 fee = o == SprintEscrow.Outcome.Draw ? 0 : (2 * uint256(stake) * 5) / 100;
        // Every token is with a player or booked as fee; the fee is exactly 5% of the pot (rounded down).
        assertEq(sqk.balanceOf(alice) + sqk.balanceOf(bob) + esc.accruedFees(), 2000 ether);
        assertEq(sqk.balanceOf(address(esc)), esc.accruedFees());
        assertEq(esc.accruedFees(), fee);
        if (o == SprintEscrow.Outcome.AWins) assertEq(sqk.balanceOf(alice), 1000 ether + stake - fee);
        if (o == SprintEscrow.Outcome.BWins) assertEq(sqk.balanceOf(bob), 1000 ether + stake - fee);
        if (o == SprintEscrow.Outcome.Draw) assertEq(sqk.balanceOf(alice), 1000 ether);
    }

    function testFuzz_manyMatchesNeverMixFunds(uint8 n, uint256 seed) public {
        n = uint8(bound(n, 1, 12));
        uint256 locked;
        for (uint256 i; i < n; i++) {
            bytes32 id = keccak256(abi.encode(i));
            uint256 stake = bound(uint256(keccak256(abi.encode(seed, i))), 1, 50 ether);
            bothDeposit(ticket(id, stake));
            locked += 2 * stake;
        }
        assertEq(sqk.balanceOf(address(esc)), locked);
        for (uint256 i; i < n; i++) {
            bytes32 id = keccak256(abi.encode(i));
            SprintEscrow.Result memory r = result(id, SprintEscrow.Outcome(1 + (uint256(keccak256(abi.encode(seed, i, "o"))) % 3)));
            esc.settle(r, signResult(r));
        }
        assertEq(sqk.balanceOf(address(esc)), esc.accruedFees());
        assertEq(sqk.balanceOf(alice) + sqk.balanceOf(bob) + esc.accruedFees(), 2000 ether);
    }

    // ------------------------------------------------------------ fees

    function test_feeIsFixedFivePercent() public {
        assertEq(esc.FEE_BPS(), 500);
        // 100 + 100 SQK pot: the winner gets 190, 10 is the fee.
        bothDeposit(ticket(ID, STAKE));
        SprintEscrow.Result memory r = result(ID, SprintEscrow.Outcome.BWins);
        esc.settle(r, signResult(r));
        assertEq(sqk.balanceOf(bob), 1000 ether - STAKE + 190 ether);
        assertEq(esc.accruedFees(), 10 ether);
    }

    function test_ownerCanWithdrawOnlyEarnedFees() public {
        // One settled match (fee earned) and one still running (stakes locked).
        bothDeposit(ticket(ID, STAKE));
        SprintEscrow.Result memory r = result(ID, SprintEscrow.Outcome.AWins);
        esc.settle(r, signResult(r));
        bytes32 id2 = keccak256("match-2");
        bothDeposit(ticket(id2, STAKE));
        assertEq(sqk.balanceOf(address(esc)), FEE + 2 * STAKE);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        esc.withdrawFees(stranger, 1);

        // Asking for even one unit more than the fees fails: running stakes are untouchable.
        vm.prank(owner);
        vm.expectRevert(SprintEscrow.TooMuch.selector);
        esc.withdrawFees(owner, FEE + 1);

        vm.prank(owner);
        esc.withdrawFees(owner, FEE);
        assertEq(sqk.balanceOf(owner), FEE);
        assertEq(esc.accruedFees(), 0);

        // The running match still pays out in full.
        SprintEscrow.Result memory r2 = result(id2, SprintEscrow.Outcome.Draw);
        esc.settle(r2, signResult(r2));
        assertEq(sqk.balanceOf(address(esc)), 0);
    }
}
