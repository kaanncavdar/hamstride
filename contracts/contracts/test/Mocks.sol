// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// Stands in for $SQK: plain OpenZeppelin ERC20 with permit, like the real token.
contract MockSQK is ERC20, ERC20Permit {
    constructor() ERC20("Squeek", "SQK") ERC20Permit("Squeek") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Keeps 1% of every transfer: the escrow must refuse it.
contract FeeToken is ERC20 {
    constructor() ERC20("Fee", "FEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0xdead), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

interface IEscrowHook {
    function refund(bytes32 matchId) external;
    function cancel(bytes32 matchId) external;
}

/// Calls back into the escrow while it is paying out, to prove re-entry is blocked.
contract ReentrantToken is ERC20 {
    IEscrowHook public target;
    bytes32 public matchId;
    bool public armed;
    bool public reentered;

    constructor() ERC20("Re", "RE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(IEscrowHook t, bytes32 id) external {
        target = t;
        matchId = id;
        armed = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed && from == address(target)) {
            armed = false;
            try target.refund(matchId) {
                reentered = true;
            } catch {}
            try target.cancel(matchId) {
                reentered = true;
            } catch {}
        }
    }
}
