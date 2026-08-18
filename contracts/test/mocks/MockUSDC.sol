// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IERC20 } from "../../src/interfaces/IERC20.sol";

contract MockUSDC is IERC20 {
    error Blocklisted();
    error InsufficientBalance();
    error InsufficientAllowance();

    string public constant name = "Mock USDC";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

    mapping(address account => uint256 amount) public balanceOf;
    mapping(address tokenOwner => mapping(address spender => uint256 amount)) public allowance;
    mapping(address account => bool blocked) public blocklisted;
    uint16 public transferFeeBps;
    uint256 public totalSupply;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function setTransferFeeBps(uint16 feeBps) external {
        transferFeeBps = feeBps;
    }

    function setBlocklisted(address account, bool blocked) external {
        blocklisted[account] = blocked;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < amount) revert InsufficientAllowance();
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        if (blocklisted[from] || blocklisted[to]) revert Blocklisted();
        if (balanceOf[from] < amount) revert InsufficientBalance();
        balanceOf[from] -= amount;
        uint256 fee = amount * transferFeeBps / 10_000;
        uint256 received = amount - fee;
        balanceOf[to] += received;
        if (fee != 0) totalSupply -= fee;
        emit Transfer(from, to, received);
        if (fee != 0) emit Transfer(from, address(0), fee);
    }
}

