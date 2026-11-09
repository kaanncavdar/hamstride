// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title Squeek Sprint stake escrow
 * @notice Holds the stakes of a 1v1 Squeek Sprint race and pays them out by the game server's
 *         signed result.
 *
 * How a staked race works:
 *  1. The game server pairs two players and signs a Ticket: match id, both addresses, the stake
 *     each puts in, and a join deadline.
 *  2. Each player deposits their stake with that ticket. When both have, the match is Active and
 *     the race can start.
 *  3. After the race the server signs a Result: player A wins, player B wins, or a draw. Anyone can
 *     submit it; normally the winner does, with the signed result the game hands them. The winner
 *     gets both stakes minus a fixed 5% house fee; a draw refunds both in full, with no fee.
 *
 * Safety rules, enforced here:
 *  - Stakes only ever go to the two players of a match. The only money the owner can withdraw is
 *    the fees already earned from settled wins (accruedFees), never anyone's stake.
 *  - The fee is fixed at 5% of the pot (FEE_BPS) forever: nobody, not the owner and not the server,
 *    can change it. Draws, cancels and refunds never pay a fee.
 *  - If the other player never deposits, after the join deadline your stake can be taken back
 *    (cancel).
 *  - If no result arrives within SETTLE_WINDOW of the match going Active (for example the server
 *    is down), either player can refund both stakes.
 *  - Each match settles once. Signatures are bound to this contract and chain (EIP-712).
 *  - The owner can only rotate the server's signing key and pause NEW deposits. Cancels, results
 *    and refunds keep working while paused, so funds are never locked by a pause.
 *
 * Trust: players trust the server to report the true winner; the server replays every race from
 * the raw inputs and includes that replay's hash in the signed result (replayHash), which is
 * published so anyone can check it. A dishonest server could only choose which of the two players
 * wins; it can't take the money.
 *
 * Tokens sent to this contract directly (not through deposit) can't be recovered.
 */
contract SprintEscrow is EIP712, ReentrancyGuard, Ownable2Step, Pausable {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Open, // one or no player has deposited yet
        Active, // both deposited; waiting for the result
        Settled,
        Refunded
    }

    enum Outcome {
        None,
        AWins,
        BWins,
        Draw
    }

    struct Ticket {
        bytes32 matchId;
        address playerA;
        address playerB;
        uint256 stake; // per player, in token base units
        uint64 joinDeadline; // unix seconds; both deposits must land by then
    }

    struct Result {
        bytes32 matchId;
        Outcome outcome;
        bytes32 replayHash; // hash of the server's replay of the race, for public checking
    }

    struct Match {
        address playerA;
        address playerB;
        uint96 stake;
        uint64 joinDeadline;
        uint64 settleDeadline; // set when the match goes Active
        bool paidA;
        bool paidB;
        Status status;
    }

    bytes32 public constant TICKET_TYPEHASH =
        keccak256("Ticket(bytes32 matchId,address playerA,address playerB,uint256 stake,uint64 joinDeadline)");
    bytes32 public constant RESULT_TYPEHASH = keccak256("Result(bytes32 matchId,uint8 outcome,bytes32 replayHash)");

    /// House fee on a win: 5% of the pot (both stakes), fixed forever. 100 = 1%.
    uint256 public constant FEE_BPS = 500;
    /// A ticket can't ask players to wait longer than this to start.
    uint64 public constant MAX_JOIN_WINDOW = 1 hours;
    /// After both deposits, the result must be claimed within this time; after it, anyone can refund
    /// both. Long enough for a winner who closed the tab to come back and claim.
    uint64 public constant SETTLE_WINDOW = 3 days;

    IERC20 public immutable token;
    address public referee;
    /// Fees earned from settled wins and not yet withdrawn. The owner can withdraw only this.
    uint256 public accruedFees;

    mapping(bytes32 matchId => Match) private _matches;

    event RefereeChanged(address indexed previous, address indexed current);
    event Deposited(bytes32 indexed matchId, address indexed player, uint256 stake);
    event MatchActive(bytes32 indexed matchId, uint64 settleDeadline);
    event Settled(bytes32 indexed matchId, Outcome outcome, bytes32 replayHash, uint256 fee);
    event FeesWithdrawn(address indexed to, uint256 amount);
    event Cancelled(bytes32 indexed matchId, address indexed refundedTo, uint256 amount);
    event Refunded(bytes32 indexed matchId);

    error ZeroAddress();
    error BadTicket();
    error BadSignature();
    error NotAPlayer();
    error AlreadyDeposited();
    error JoinClosed();
    error JoinStillOpen();
    error WrongStatus(Status status);
    error BadOutcome();
    error SettleWindowOpen();
    error TransferMismatch();
    error CannotRenounce();
    error TooMuch();

    constructor(IERC20 token_, address referee_, address owner_) EIP712("SqueekSprintEscrow", "1") Ownable(owner_) {
        if (address(token_) == address(0) || referee_ == address(0)) revert ZeroAddress();
        token = token_;
        referee = referee_;
        emit RefereeChanged(address(0), referee_);
    }

    // ---------------------------------------------------------------- players

    /// @notice Put in your stake for a match. Approve this contract for `t.stake` first.
    function deposit(Ticket calldata t, bytes calldata refereeSig) external nonReentrant whenNotPaused {
        _deposit(t, refereeSig);
    }

    /// @notice Same as deposit, with an EIP-2612 permit instead of a separate approve.
    /// @dev The permit is tried and ignored if it fails (for example if someone front-ran it); the
    ///      transfer then needs an existing allowance.
    function depositWithPermit(
        Ticket calldata t,
        bytes calldata refereeSig,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant whenNotPaused {
        try IERC20Permit(address(token)).permit(msg.sender, address(this), t.stake, permitDeadline, v, r, s) {} catch {}
        _deposit(t, refereeSig);
    }

    /// @notice After the join deadline, if the match never went Active, give back whoever paid.
    ///         Anyone may call it; the money only goes to the player who deposited.
    function cancel(bytes32 matchId) external nonReentrant {
        Match storage m = _matches[matchId];
        if (m.status != Status.Open) revert WrongStatus(m.status);
        if (block.timestamp <= m.joinDeadline) revert JoinStillOpen();
        m.status = Status.Refunded;
        // Only one side can have paid, or the match would be Active.
        address to = m.paidA ? m.playerA : m.playerB;
        uint256 amount = m.stake;
        if (m.paidA || m.paidB) {
            m.paidA = false;
            m.paidB = false;
            token.safeTransfer(to, amount);
            emit Cancelled(matchId, to, amount);
        } else {
            emit Cancelled(matchId, address(0), 0);
        }
    }

    /// @notice Pay out a match with the server's signed result. Anyone may submit it.
    function settle(Result calldata res, bytes calldata refereeSig) external nonReentrant {
        Match storage m = _matches[res.matchId];
        if (m.status != Status.Active) revert WrongStatus(m.status);
        if (res.outcome == Outcome.None || uint8(res.outcome) > uint8(Outcome.Draw)) revert BadOutcome();
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(RESULT_TYPEHASH, res.matchId, uint8(res.outcome), res.replayHash))
        );
        if (ECDSA.recover(digest, refereeSig) != referee) revert BadSignature();

        m.status = Status.Settled;
        uint256 stake = m.stake;
        if (res.outcome == Outcome.Draw) {
            emit Settled(res.matchId, res.outcome, res.replayHash, 0);
            token.safeTransfer(m.playerA, stake);
            token.safeTransfer(m.playerB, stake);
        } else {
            uint256 pot = stake * 2;
            uint256 fee = (pot * FEE_BPS) / 10_000;
            accruedFees += fee;
            emit Settled(res.matchId, res.outcome, res.replayHash, fee);
            token.safeTransfer(res.outcome == Outcome.AWins ? m.playerA : m.playerB, pot - fee);
        }
    }

    /// @notice If an Active match got no result within SETTLE_WINDOW, give both players their
    ///         stakes back. Anyone may call it.
    function refund(bytes32 matchId) external nonReentrant {
        Match storage m = _matches[matchId];
        if (m.status != Status.Active) revert WrongStatus(m.status);
        if (block.timestamp <= m.settleDeadline) revert SettleWindowOpen();
        m.status = Status.Refunded;
        uint256 stake = m.stake;
        emit Refunded(matchId);
        token.safeTransfer(m.playerA, stake);
        token.safeTransfer(m.playerB, stake);
    }

    // ---------------------------------------------------------------- owner

    /// @notice Rotate the server's signing key (for example if it leaked). Pending tickets and
    ///         results signed with the old key stop working; Active matches then refund after
    ///         SETTLE_WINDOW.
    function setReferee(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit RefereeChanged(referee, next);
        referee = next;
    }

    /// @notice Withdraw earned fees. Can never touch stakes: only up to accruedFees.
    function withdrawFees(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount > accruedFees) revert TooMuch();
        accruedFees -= amount;
        emit FeesWithdrawn(to, amount);
        token.safeTransfer(to, amount);
    }

    /// @notice Stop new deposits. Cancels, results and refunds still work.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @dev Giving up ownership would make it impossible to rotate a leaked server key.
    function renounceOwnership() public view override onlyOwner {
        revert CannotRenounce();
    }

    // ---------------------------------------------------------------- views

    function getMatch(bytes32 matchId) external view returns (Match memory) {
        return _matches[matchId];
    }

    function ticketDigest(Ticket calldata t) external view returns (bytes32) {
        return _ticketDigest(t);
    }

    function resultDigest(Result calldata res) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(RESULT_TYPEHASH, res.matchId, uint8(res.outcome), res.replayHash)));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ---------------------------------------------------------------- internals

    function _ticketDigest(Ticket calldata t) private view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(TICKET_TYPEHASH, t.matchId, t.playerA, t.playerB, t.stake, t.joinDeadline))
        );
    }

    function _deposit(Ticket calldata t, bytes calldata refereeSig) private {
        if (
            t.playerA == address(0) || t.playerB == address(0) || t.playerA == t.playerB || t.stake == 0
                || t.stake > type(uint96).max
        ) revert BadTicket();
        if (block.timestamp > t.joinDeadline) revert JoinClosed();
        if (t.joinDeadline > block.timestamp + MAX_JOIN_WINDOW) revert BadTicket();
        if (ECDSA.recover(_ticketDigest(t), refereeSig) != referee) revert BadSignature();

        bool isA = msg.sender == t.playerA;
        if (!isA && msg.sender != t.playerB) revert NotAPlayer();

        Match storage m = _matches[t.matchId];
        if (m.status == Status.None) {
            m.playerA = t.playerA;
            m.playerB = t.playerB;
            m.stake = uint96(t.stake);
            m.joinDeadline = t.joinDeadline;
            m.status = Status.Open;
        } else if (m.status != Status.Open) {
            revert WrongStatus(m.status);
        } else if (
            m.playerA != t.playerA || m.playerB != t.playerB || m.stake != t.stake
                || m.joinDeadline != t.joinDeadline
        ) {
            // Same match id, different terms: never mix two tickets in one match.
            revert BadTicket();
        }

        if (isA ? m.paidA : m.paidB) revert AlreadyDeposited();
        if (isA) m.paidA = true;
        else m.paidB = true;

        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), t.stake);
        if (token.balanceOf(address(this)) - before != t.stake) revert TransferMismatch();
        emit Deposited(t.matchId, msg.sender, t.stake);

        if (m.paidA && m.paidB) {
            m.status = Status.Active;
            m.settleDeadline = uint64(block.timestamp) + SETTLE_WINDOW;
            emit MatchActive(t.matchId, m.settleDeadline);
        }
    }
}
