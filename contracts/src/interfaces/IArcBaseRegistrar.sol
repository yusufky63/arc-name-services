// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IArcBaseRegistrar {
    function baseNode() external view returns (bytes32);
    function gracePeriod() external view returns (uint256);
    function nameExpires(uint256 id) external view returns (uint256);
    function available(uint256 id) external view returns (bool);
    function isActive(uint256 id) external view returns (bool);
    function ownerOf(uint256 id) external view returns (address);
    function getApproved(uint256 id) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);

    function register(
        uint256 id,
        address owner,
        uint256 duration,
        address resolver,
        bytes[] calldata resolverData
    ) external returns (uint256 expires);
    function renew(uint256 id, uint256 duration) external returns (uint256 expires);
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
}

