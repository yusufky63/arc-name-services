// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IArcNameRegistry {
    function owner(bytes32 node) external view returns (address);
    function resolver(bytes32 node) external view returns (address);
    function ttl(bytes32 node) external view returns (uint64);
    function recordExists(bytes32 node) external view returns (bool);
    function isApprovedForAll(address account, address operator) external view returns (bool);

    function setOwner(bytes32 node, address newOwner) external;
    function setSubnodeOwner(bytes32 node, bytes32 label, address newOwner)
        external
        returns (bytes32);
    function setResolver(bytes32 node, address newResolver) external;
    function setTTL(bytes32 node, uint64 newTTL) external;
}

