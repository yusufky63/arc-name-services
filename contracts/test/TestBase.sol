// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest)
        external
        returns (uint8 v, bytes32 r, bytes32 s);
    function chainId(uint256 newChainId) external;
    function etch(address target, bytes calldata newRuntimeBytecode) external;
    function setEnv(string calldata name, string calldata value) external;
    function toString(address value) external pure returns (string memory);
    function toString(bytes32 value) external pure returns (string memory);
    function toString(uint256 value) external pure returns (string memory);
    function warp(uint256 newTimestamp) external;
    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function expectRevert() external;
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata revertData) external;
}

abstract contract TestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    error AssertionFailed();

    function assertTrue(bool value) internal pure {
        if (!value) revert AssertionFailed();
    }

    function assertFalse(bool value) internal pure {
        if (value) revert AssertionFailed();
    }

    function assertEq(uint256 left, uint256 right) internal pure {
        if (left != right) revert AssertionFailed();
    }

    function assertEq(address left, address right) internal pure {
        if (left != right) revert AssertionFailed();
    }

    function assertEq(bytes32 left, bytes32 right) internal pure {
        if (left != right) revert AssertionFailed();
    }

    function assertEq(string memory left, string memory right) internal pure {
        if (keccak256(bytes(left)) != keccak256(bytes(right))) revert AssertionFailed();
    }
}
