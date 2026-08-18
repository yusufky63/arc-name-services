// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IArcNameRegistry } from "./interfaces/IArcNameRegistry.sol";

/// @notice On-chain resolver for address, text, name, contenthash and interface records.
contract ArcPublicResolver {
    error Unauthorized(bytes32 node, address caller);
    error InvalidAddressEncoding();
    error InvalidMulticall();
    error NodeMismatch();
    error UnsupportedMulticallSelector();

    uint256 public constant EVM_COIN_TYPE = 60;

    // ENSIP resolver interface IDs are the selectors of their single read methods.
    bytes4 private constant _INTERFACE_ID_ERC165 = 0x01ffc9a7;
    bytes4 private constant _INTERFACE_ID_ADDR = 0x3b3b57de;
    bytes4 private constant _INTERFACE_ID_ADDRESS = 0xf1cb7e06;
    bytes4 private constant _INTERFACE_ID_TEXT = 0x59d1d43c;
    bytes4 private constant _INTERFACE_ID_NAME = 0x691f3431;
    bytes4 private constant _INTERFACE_ID_CONTENTHASH = 0xbc1c58d1;
    bytes4 private constant _INTERFACE_ID_INTERFACE = 0x124a319c;

    bytes4 private constant _SET_ADDR = bytes4(keccak256("setAddr(bytes32,address)"));
    bytes4 private constant _SET_ADDRESS = bytes4(keccak256("setAddr(bytes32,uint256,bytes)"));
    bytes4 private constant _SET_TEXT = bytes4(keccak256("setText(bytes32,string,string)"));
    bytes4 private constant _SET_NAME = bytes4(keccak256("setName(bytes32,string)"));
    bytes4 private constant _SET_CONTENTHASH = bytes4(keccak256("setContenthash(bytes32,bytes)"));
    bytes4 private constant _SET_INTERFACE =
        bytes4(keccak256("setInterface(bytes32,bytes4,address)"));

    IArcNameRegistry public immutable registry;

    mapping(bytes32 node => uint64 version) public recordVersions;
    mapping(
        bytes32 node => mapping(uint64 version => mapping(uint256 coinType => bytes value))
    ) private _addresses;
    mapping(
        bytes32 node => mapping(uint64 version => mapping(bytes32 keyHash => string value))
    ) private _texts;
    mapping(bytes32 node => mapping(uint64 version => string value)) private _names;
    mapping(bytes32 node => mapping(uint64 version => bytes value)) private _contenthashes;
    mapping(
        bytes32 node => mapping(uint64 version => mapping(bytes4 interfaceId => address value))
    ) private _interfaces;

    event AddrChanged(bytes32 indexed node, address a);
    event AddressChanged(bytes32 indexed node, uint256 coinType, bytes newAddress);
    event NameChanged(bytes32 indexed node, string name);
    event TextChanged(bytes32 indexed node, string indexed indexedKey, string key, string value);
    event ContenthashChanged(bytes32 indexed node, bytes hash);
    event VersionChanged(bytes32 indexed node, uint64 newVersion);
    event InterfaceChanged(bytes32 indexed node, bytes4 indexed interfaceID, address implementer);

    constructor(IArcNameRegistry registry_) {
        if (address(registry_) == address(0)) revert Unauthorized(bytes32(0), address(0));
        registry = registry_;
    }

    modifier authorised(bytes32 node) {
        address nodeOwner = registry.owner(node);
        if (msg.sender != nodeOwner && !registry.isApprovedForAll(nodeOwner, msg.sender)) {
            revert Unauthorized(node, msg.sender);
        }
        _;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == _INTERFACE_ID_ERC165 || interfaceId == _INTERFACE_ID_ADDR
            || interfaceId == _INTERFACE_ID_ADDRESS || interfaceId == _INTERFACE_ID_TEXT
            || interfaceId == _INTERFACE_ID_NAME || interfaceId == _INTERFACE_ID_CONTENTHASH
            || interfaceId == _INTERFACE_ID_INTERFACE;
    }

    function addr(bytes32 node) external view returns (address payable value) {
        bytes memory encoded = _addresses[node][recordVersions[node]][EVM_COIN_TYPE];
        if (encoded.length == 0) return payable(address(0));
        if (encoded.length != 20) revert InvalidAddressEncoding();
        assembly ("memory-safe") {
            value := shr(96, mload(add(encoded, 32)))
        }
    }

    function addr(bytes32 node, uint256 coinType) external view returns (bytes memory) {
        return _addresses[node][recordVersions[node]][coinType];
    }

    function text(bytes32 node, string calldata key) external view returns (string memory) {
        return _texts[node][recordVersions[node]][keccak256(bytes(key))];
    }

    function name(bytes32 node) external view returns (string memory) {
        return _names[node][recordVersions[node]];
    }

    function contenthash(bytes32 node) external view returns (bytes memory) {
        return _contenthashes[node][recordVersions[node]];
    }

    function interfaceImplementer(bytes32 node, bytes4 interfaceId)
        external
        view
        returns (address)
    {
        return _interfaces[node][recordVersions[node]][interfaceId];
    }

    function setAddr(bytes32 node, address addr_) external authorised(node) {
        bytes memory encoded = abi.encodePacked(addr_);
        _addresses[node][recordVersions[node]][EVM_COIN_TYPE] = encoded;
        emit AddrChanged(node, addr_);
        emit AddressChanged(node, EVM_COIN_TYPE, encoded);
    }

    function setAddr(bytes32 node, uint256 coinType, bytes calldata value)
        external
        authorised(node)
    {
        _addresses[node][recordVersions[node]][coinType] = value;
        emit AddressChanged(node, coinType, value);

        if (coinType == EVM_COIN_TYPE) {
            if (value.length != 0 && value.length != 20) revert InvalidAddressEncoding();
            address decoded;
            if (value.length == 20) {
                assembly ("memory-safe") {
                    decoded := shr(96, calldataload(value.offset))
                }
            }
            emit AddrChanged(node, decoded);
        }
    }

    function setText(bytes32 node, string calldata key, string calldata value)
        external
        authorised(node)
    {
        _texts[node][recordVersions[node]][keccak256(bytes(key))] = value;
        emit TextChanged(node, key, key, value);
    }

    function setName(bytes32 node, string calldata name_) external authorised(node) {
        _names[node][recordVersions[node]] = name_;
        emit NameChanged(node, name_);
    }

    function setContenthash(bytes32 node, bytes calldata hash) external authorised(node) {
        _contenthashes[node][recordVersions[node]] = hash;
        emit ContenthashChanged(node, hash);
    }

    function setInterface(bytes32 node, bytes4 interfaceId, address implementer)
        external
        authorised(node)
    {
        _interfaces[node][recordVersions[node]][interfaceId] = implementer;
        emit InterfaceChanged(node, interfaceId, implementer);
    }

    function clearRecords(bytes32 node) external authorised(node) {
        uint64 nextVersion = recordVersions[node] + 1;
        recordVersions[node] = nextVersion;
        emit VersionChanged(node, nextVersion);
    }

    /// @notice Executes only known record setters whose first argument is exactly `node`.
    /// @dev Used by the registrar while it briefly owns a newly-created registry node.
    function multicallWithNodeCheck(bytes32 node, bytes[] calldata data)
        external
        returns (bytes[] memory results)
    {
        results = new bytes[](data.length);
        for (uint256 i; i < data.length; ++i) {
            bytes calldata callData = data[i];
            if (callData.length < 36) revert InvalidMulticall();

            bytes4 selector;
            bytes32 suppliedNode;
            assembly ("memory-safe") {
                selector := calldataload(callData.offset)
                suppliedNode := calldataload(add(callData.offset, 4))
            }
            if (suppliedNode != node) revert NodeMismatch();
            if (!_isAllowedSetter(selector)) revert UnsupportedMulticallSelector();

            (bool success, bytes memory result) = address(this).delegatecall(callData);
            if (!success) {
                assembly ("memory-safe") {
                    revert(add(result, 32), mload(result))
                }
            }
            results[i] = result;
        }
    }

    function _isAllowedSetter(bytes4 selector) private pure returns (bool) {
        return selector == _SET_ADDR || selector == _SET_ADDRESS || selector == _SET_TEXT
            || selector == _SET_NAME || selector == _SET_CONTENTHASH || selector == _SET_INTERFACE;
    }
}
