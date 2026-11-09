// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title Hamstride Test SQK
/// @notice A worthless stand-in for $SQK, only for trying races for SQK on Sepolia before you hold
/// real SQK. Same shape as the real token (OpenZeppelin ERC20 + permit). Anyone can drip 1000.
contract TestSQK is ERC20, ERC20Permit {
    uint256 public constant DRIP = 1000 ether;

    constructor() ERC20("Hamstride Test SQK", "tSQK") ERC20Permit("Hamstride Test SQK") {}

    /// @notice Gives the caller 1000 test SQK.
    function drip() external {
        _mint(msg.sender, DRIP);
    }
}
