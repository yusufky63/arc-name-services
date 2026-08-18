// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IArcNameRegistry } from "./interfaces/IArcNameRegistry.sol";
import { IArcBaseRegistrar } from "./interfaces/IArcBaseRegistrar.sol";
import { IArcPublicResolver } from "./interfaces/IArcPublicResolver.sol";
import { BoundedNamehash } from "./libraries/BoundedNamehash.sol";

/// @notice Manages `<lowercase-address>.addr.reverse` and returns only forward-confirmed names.
contract ArcReverseRegistrar {
    error InvalidConfiguration();
    error InvalidOwner();
    error InvalidForwardName();
    error ForwardResolutionMismatch();

    IArcNameRegistry public immutable registry;
    IArcPublicResolver public immutable defaultResolver;
    IArcBaseRegistrar public immutable registrar;
    bytes32 public immutable reverseNode;
    bytes32 public immutable baseNode;
    string public suffix;

    event ReverseClaimed(address indexed account, bytes32 indexed node, address indexed owner);

    constructor(
        IArcNameRegistry registry_,
        IArcPublicResolver defaultResolver_,
        IArcBaseRegistrar registrar_,
        bytes32 reverseNode_,
        bytes32 baseNode_,
        string memory suffix_
    ) {
        if (
            address(registry_) == address(0) || address(defaultResolver_) == address(0)
                || address(registrar_) == address(0) || reverseNode_ == bytes32(0)
                || baseNode_ == bytes32(0) || bytes(suffix_).length == 0
        ) revert InvalidConfiguration();
        if (
            BoundedNamehash.namehash(suffix_, 255, 10) != baseNode_
                || BoundedNamehash.namehash("addr.reverse", 255, 10) != reverseNode_
        ) revert InvalidConfiguration();
        registry = registry_;
        defaultResolver = defaultResolver_;
        registrar = registrar_;
        reverseNode = reverseNode_;
        baseNode = baseNode_;
        suffix = suffix_;
    }

    function claim(address reverseOwner) external returns (bytes32 node) {
        if (reverseOwner == address(0)) revert InvalidOwner();
        node = _claim(msg.sender, reverseOwner);
    }

    function setName(string calldata forwardName) external returns (bytes32 node) {
        if (!_isForwardConfirmed(msg.sender, forwardName)) revert ForwardResolutionMismatch();

        bytes32 label = sha3HexAddress(msg.sender);
        node = keccak256(abi.encodePacked(reverseNode, label));
        registry.setSubnodeOwner(reverseNode, label, address(this));
        registry.setResolver(node, address(defaultResolver));
        defaultResolver.setName(node, forwardName);
        registry.setOwner(node, msg.sender);
        emit ReverseClaimed(msg.sender, node, msg.sender);
    }

    function name(address account) external view returns (string memory effectiveName) {
        bytes32 node = reverseNodeOf(account);
        address resolverAddress = registry.resolver(node);
        if (resolverAddress == address(0)) return "";

        try IArcPublicResolver(resolverAddress).name(node) returns (string memory storedName) {
            if (_isForwardConfirmed(account, storedName)) return storedName;
        } catch { }
        return "";
    }

    function reverseNodeOf(address account) public view returns (bytes32) {
        return keccak256(abi.encodePacked(reverseNode, sha3HexAddress(account)));
    }

    function forwardNode(string calldata forwardName) external view returns (bytes32 node) {
        (node,) = _validatedForwardNode(forwardName);
    }

    function sha3HexAddress(address account) public pure returns (bytes32) {
        bytes memory hexAddress = new bytes(40);
        bytes20 raw = bytes20(account);
        bytes16 alphabet = "0123456789abcdef";
        for (uint256 i; i < 20; ++i) {
            uint8 value = uint8(raw[i]);
            hexAddress[i * 2] = alphabet[value >> 4];
            hexAddress[i * 2 + 1] = alphabet[value & 0x0f];
        }
        return keccak256(hexAddress);
    }

    function _claim(address account, address reverseOwner) private returns (bytes32 node) {
        bytes32 label = sha3HexAddress(account);
        node = registry.setSubnodeOwner(reverseNode, label, reverseOwner);
        emit ReverseClaimed(account, node, reverseOwner);
    }

    function _isForwardConfirmed(address account, string memory forwardName)
        private
        view
        returns (bool)
    {
        bytes32 node;
        bytes32 labelHash;
        try this.validatedForwardNode(forwardName) returns (bytes32 node_, bytes32 labelHash_) {
            node = node_;
            labelHash = labelHash_;
        } catch {
            return false;
        }

        if (!registrar.isActive(uint256(labelHash))) return false;
        address resolverAddress = registry.resolver(node);
        if (resolverAddress == address(0)) return false;
        try IArcPublicResolver(resolverAddress).addr(node) returns (address payable resolved) {
            return resolved == account;
        } catch {
            return false;
        }
    }

    /// @dev External self-call target permits graceful validation failure in view functions.
    function validatedForwardNode(string calldata forwardName)
        external
        view
        returns (bytes32 node, bytes32 labelHash)
    {
        if (msg.sender != address(this)) revert InvalidForwardName();
        return _validatedForwardNode(forwardName);
    }

    function _validatedForwardNode(string memory forwardName)
        private
        view
        returns (bytes32 node, bytes32 labelHash)
    {
        bytes memory nameBytes = bytes(forwardName);
        bytes memory suffixBytes = bytes(suffix);
        if (nameBytes.length <= suffixBytes.length + 1 || nameBytes.length > 255) {
            revert InvalidForwardName();
        }

        uint256 separator = nameBytes.length - suffixBytes.length - 1;
        if (nameBytes[separator] != bytes1(".")) revert InvalidForwardName();
        for (uint256 i; i < suffixBytes.length; ++i) {
            if (nameBytes[separator + 1 + i] != suffixBytes[i]) revert InvalidForwardName();
        }
        for (uint256 i; i < separator; ++i) {
            if (nameBytes[i] == bytes1(".")) revert InvalidForwardName();
        }

        assembly ("memory-safe") {
            labelHash := keccak256(add(nameBytes, 32), separator)
        }
        node = keccak256(abi.encodePacked(baseNode, labelHash));
    }
}
