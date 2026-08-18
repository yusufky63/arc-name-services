// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IArcNameRegistry } from "./interfaces/IArcNameRegistry.sol";
import { IArcPublicResolver } from "./interfaces/IArcPublicResolver.sol";
import { BoundedNamehash } from "./libraries/BoundedNamehash.sol";

interface IForwardConfirmedReverse {
    function name(address account) external view returns (string memory);
}

/// @notice Narrow, bounded on-chain read facade; this is not ENS CCIP-Read Universal Resolver.
contract ArcUniversalResolver {
    error InvalidConfiguration();
    error ResolverNotSet(bytes32 node);
    error ResolverReadFailed();
    error ResolverResponseTooLarge();
    error TextKeyTooLong();

    uint256 public constant MAX_NAME_BYTES = 255;
    uint256 public constant MAX_LABELS = 10;
    uint256 public constant MAX_TEXT_KEY_BYTES = 64;
    uint256 public constant MAX_TEXT_VALUE_BYTES = 2_048;
    uint256 public constant MAX_RESOLVER_RETURN_BYTES = 4_096;
    uint256 public constant RESOLVER_GAS_LIMIT = 100_000;
    bytes4 private constant _ADDR_SELECTOR = bytes4(keccak256("addr(bytes32)"));

    IArcNameRegistry public immutable registry;
    IForwardConfirmedReverse public immutable reverseRegistrar;

    constructor(IArcNameRegistry registry_, IForwardConfirmedReverse reverseRegistrar_) {
        if (address(registry_) == address(0) || address(reverseRegistrar_) == address(0)) {
            revert InvalidConfiguration();
        }
        registry = registry_;
        reverseRegistrar = reverseRegistrar_;
    }

    function namehash(string memory fullName) public pure returns (bytes32) {
        return BoundedNamehash.namehash(fullName, MAX_NAME_BYTES, MAX_LABELS);
    }

    function resolveAddress(string calldata fullName)
        external
        view
        returns (bytes32 node, address resolved)
    {
        node = namehash(fullName);
        address resolverAddress = _resolver(node);
        bytes memory response =
            _boundedStaticcall(resolverAddress, abi.encodeWithSelector(_ADDR_SELECTOR, node), 32);
        if (response.length != 32) revert ResolverReadFailed();
        resolved = abi.decode(response, (address));
    }

    function resolveText(string calldata fullName, string calldata key)
        external
        view
        returns (bytes32 node, string memory value)
    {
        if (bytes(key).length > MAX_TEXT_KEY_BYTES) revert TextKeyTooLong();
        node = namehash(fullName);
        address resolverAddress = _resolver(node);
        bytes memory response = _boundedStaticcall(
            resolverAddress,
            abi.encodeWithSelector(IArcPublicResolver.text.selector, node, key),
            MAX_RESOLVER_RETURN_BYTES
        );
        value = abi.decode(response, (string));
        if (bytes(value).length > MAX_TEXT_VALUE_BYTES) revert ResolverResponseTooLarge();
    }

    function resolveName(string calldata fullName)
        external
        view
        returns (bytes32 node, string memory value)
    {
        node = namehash(fullName);
        address resolverAddress = _resolver(node);
        bytes memory response = _boundedStaticcall(
            resolverAddress,
            abi.encodeWithSelector(IArcPublicResolver.name.selector, node),
            MAX_RESOLVER_RETURN_BYTES
        );
        value = abi.decode(response, (string));
        if (bytes(value).length > MAX_NAME_BYTES) revert ResolverResponseTooLarge();
    }

    function resolveReverse(address account) external view returns (string memory value) {
        bytes memory response = _boundedStaticcall(
            address(reverseRegistrar),
            abi.encodeCall(IForwardConfirmedReverse.name, (account)),
            MAX_RESOLVER_RETURN_BYTES
        );
        value = abi.decode(response, (string));
        if (bytes(value).length > MAX_NAME_BYTES) revert ResolverResponseTooLarge();
    }

    function _resolver(bytes32 node) private view returns (address resolverAddress) {
        resolverAddress = registry.resolver(node);
        if (resolverAddress == address(0)) revert ResolverNotSet(node);
    }

    function _boundedStaticcall(address target, bytes memory data, uint256 maxReturn)
        private
        view
        returns (bytes memory response)
    {
        bool success;
        bool tooLarge;
        response = new bytes(maxReturn);
        uint256 gasLimit = RESOLVER_GAS_LIMIT;
        assembly ("memory-safe") {
            success := staticcall(
                gasLimit,
                target,
                add(data, 32),
                mload(data),
                add(response, 32),
                maxReturn
            )
            let size := returndatasize()
            tooLarge := gt(size, maxReturn)
            let boundedSize := size
            if tooLarge { boundedSize := maxReturn }
            mstore(response, boundedSize)
        }
        if (!success) revert ResolverReadFailed();
        if (tooLarge) revert ResolverResponseTooLarge();
    }
}
