// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IArcNameRegistry } from "./interfaces/IArcNameRegistry.sol";

/// @notice ENS-compatible ownership, resolver and TTL source of truth for Arc names.
contract ArcNameRegistry is IArcNameRegistry {
    error Unauthorized(bytes32 node, address caller);

    struct Record {
        address owner;
        address resolver;
        uint64 ttl;
    }

    mapping(bytes32 node => Record record) private _records;
    mapping(address account => mapping(address operator => bool approved)) private _operators;

    event Transfer(bytes32 indexed node, address owner);
    event NewOwner(bytes32 indexed node, bytes32 indexed label, address owner);
    event NewResolver(bytes32 indexed node, address resolver);
    event NewTTL(bytes32 indexed node, uint64 ttl);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    constructor(address rootOwner) {
        if (rootOwner == address(0)) revert Unauthorized(bytes32(0), address(0));
        _records[bytes32(0)].owner = rootOwner;
        emit Transfer(bytes32(0), rootOwner);
    }

    modifier authorised(bytes32 node) {
        address nodeOwner = _records[node].owner;
        if (msg.sender != nodeOwner && !_operators[nodeOwner][msg.sender]) {
            revert Unauthorized(node, msg.sender);
        }
        _;
    }

    function owner(bytes32 node) external view returns (address) {
        return _records[node].owner;
    }

    function resolver(bytes32 node) external view returns (address) {
        return _records[node].resolver;
    }

    function ttl(bytes32 node) external view returns (uint64) {
        return _records[node].ttl;
    }

    function recordExists(bytes32 node) external view returns (bool) {
        return _records[node].owner != address(0);
    }

    function isApprovedForAll(address account, address operator) external view returns (bool) {
        return _operators[account][operator];
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operators[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function setOwner(bytes32 node, address newOwner) external authorised(node) {
        _records[node].owner = newOwner;
        emit Transfer(node, newOwner);
    }

    function setSubnodeOwner(bytes32 node, bytes32 label, address newOwner)
        external
        authorised(node)
        returns (bytes32 subnode)
    {
        subnode = keccak256(abi.encodePacked(node, label));
        _records[subnode].owner = newOwner;
        emit NewOwner(node, label, newOwner);
    }

    function setResolver(bytes32 node, address newResolver) external authorised(node) {
        _records[node].resolver = newResolver;
        emit NewResolver(node, newResolver);
    }

    function setTTL(bytes32 node, uint64 newTTL) external authorised(node) {
        _records[node].ttl = newTTL;
        emit NewTTL(node, newTTL);
    }
}

