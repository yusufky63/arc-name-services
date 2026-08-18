// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IArcNameRegistry } from "./interfaces/IArcNameRegistry.sol";
import { IERC721Receiver } from "./interfaces/IERC721Receiver.sol";
import { IArcPublicResolver } from "./interfaces/IArcPublicResolver.sol";
import { Ownable2Step } from "./libraries/Ownable2Step.sol";

/// @notice ERC-721 registrar whose token IDs are normalized-label hashes.
contract ArcBaseRegistrar is Ownable2Step {
    error UnauthorizedController();
    error InvalidOwner();
    error InvalidDuration();
    error NameUnavailable();
    error NameNotRenewable();
    error NameNotActive();
    error TokenDoesNotExist();
    error NotApprovedOrOwner();
    error UnsafeRecipient();

    string public constant name = "Arc Testnet Names";
    string public constant symbol = "ARCN";

    IArcNameRegistry public immutable registry;
    bytes32 public immutable baseNode;
    uint256 public constant gracePeriod = 90 days;

    mapping(address controller => bool enabled) public controllers;
    mapping(uint256 id => uint256 expiry) public nameExpires;
    mapping(uint256 id => address owner) private _owners;
    mapping(address owner => uint256 balance) private _balances;
    mapping(uint256 id => address approved) private _tokenApprovals;
    mapping(address owner => mapping(address operator => bool approved)) private _operatorApprovals;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event ControllerChanged(address indexed controller, bool enabled);
    event NameRegistered(uint256 indexed id, address indexed owner, uint256 expires);
    event NameRenewed(uint256 indexed id, uint256 expires);

    constructor(IArcNameRegistry registry_, bytes32 baseNode_, address initialOwner)
        Ownable2Step(initialOwner)
    {
        if (address(registry_) == address(0)) revert ZeroAddress();
        registry = registry_;
        baseNode = baseNode_;
    }

    modifier onlyController() {
        if (!controllers[msg.sender]) revert UnauthorizedController();
        _;
    }

    function setController(address controller, bool enabled) external onlyOwner {
        if (controller == address(0)) revert ZeroAddress();
        controllers[controller] = enabled;
        emit ControllerChanged(controller, enabled);
    }

    function supportsInterface(bytes4 interfaceId) external pure virtual returns (bool) {
        return interfaceId == 0x01ffc9a7 // ERC-165
            || interfaceId == 0x80ac58cd; // ERC-721
    }

    function balanceOf(address tokenOwner) external view returns (uint256) {
        if (tokenOwner == address(0)) revert InvalidOwner();
        return _balances[tokenOwner];
    }

    function ownerOf(uint256 id) public view returns (address tokenOwner) {
        tokenOwner = _owners[id];
        if (tokenOwner == address(0)) revert TokenDoesNotExist();
    }

    function getApproved(uint256 id) external view returns (address) {
        if (_owners[id] == address(0)) revert TokenDoesNotExist();
        return _tokenApprovals[id];
    }

    function isApprovedForAll(address tokenOwner, address operator) external view returns (bool) {
        return _operatorApprovals[tokenOwner][operator];
    }

    function approve(address approved, uint256 id) external {
        address tokenOwner = ownerOf(id);
        if (msg.sender != tokenOwner && !_operatorApprovals[tokenOwner][msg.sender]) {
            revert NotApprovedOrOwner();
        }
        _tokenApprovals[id] = approved;
        emit Approval(tokenOwner, approved, id);
    }

    function setApprovalForAll(address operator, bool approved) external {
        if (operator == msg.sender) revert NotApprovedOrOwner();
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 id) public {
        _transfer(from, to, id);
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        safeTransferFrom(from, to, id, "");
    }

    function safeTransferFrom(address from, address to, uint256 id, bytes memory data) public {
        _transfer(from, to, id);
        if (to.code.length != 0) {
            try IERC721Receiver(to).onERC721Received(msg.sender, from, id, data) returns (
                bytes4 response
            ) {
                if (response != IERC721Receiver.onERC721Received.selector) {
                    revert UnsafeRecipient();
                }
            } catch {
                revert UnsafeRecipient();
            }
        }
    }

    function available(uint256 id) public view returns (bool) {
        uint256 expiry = nameExpires[id];
        return expiry == 0 || block.timestamp > expiry + gracePeriod;
    }

    function isActive(uint256 id) public view returns (bool) {
        uint256 expiry = nameExpires[id];
        return expiry != 0 && block.timestamp <= expiry;
    }

    function inGracePeriod(uint256 id) external view returns (bool) {
        uint256 expiry = nameExpires[id];
        return expiry != 0 && block.timestamp > expiry && block.timestamp <= expiry + gracePeriod;
    }

    function register(
        uint256 id,
        address tokenOwner,
        uint256 duration,
        address resolver,
        bytes[] calldata resolverData
    ) external onlyController returns (uint256 expires) {
        if (tokenOwner == address(0)) revert InvalidOwner();
        if (duration == 0) revert InvalidDuration();
        if (!available(id)) revert NameUnavailable();

        if (_owners[id] != address(0)) _burn(id);
        expires = block.timestamp + duration;
        nameExpires[id] = expires;
        _mint(tokenOwner, id);

        bytes32 label = bytes32(id);
        bytes32 node = keccak256(abi.encodePacked(baseNode, label));
        registry.setSubnodeOwner(baseNode, label, address(this));

        // The registrar is the temporary registry owner here, so the resolver's normal owner
        // authorization permits this reset while rejecting arbitrary external callers. Advancing
        // the record version before assigning the new owner makes all records from a prior lease
        // unreachable atomically, including addr/text/name/contenthash/interface records.
        if (resolver != address(0)) {
            IArcPublicResolver(resolver).clearRecords(node);
        }
        registry.setResolver(node, resolver);
        registry.setTTL(node, 0);
        if (resolver != address(0)) {
            if (resolverData.length != 0) {
                IArcPublicResolver(resolver).multicallWithNodeCheck(node, resolverData);
            }
        }
        registry.setOwner(node, tokenOwner);

        emit NameRegistered(id, tokenOwner, expires);
    }

    function renew(uint256 id, uint256 duration) external onlyController returns (uint256 expires) {
        if (duration == 0) revert InvalidDuration();
        uint256 oldExpiry = nameExpires[id];
        if (oldExpiry == 0 || block.timestamp > oldExpiry + gracePeriod) {
            revert NameNotRenewable();
        }
        expires = oldExpiry + duration;
        nameExpires[id] = expires;
        emit NameRenewed(id, expires);
    }

    function reclaim(uint256 id, address registryOwner) external {
        address tokenOwner = ownerOf(id);
        if (msg.sender != tokenOwner && !_operatorApprovals[tokenOwner][msg.sender]) {
            revert NotApprovedOrOwner();
        }
        if (!isActive(id)) revert NameNotActive();
        registry.setSubnodeOwner(baseNode, bytes32(id), registryOwner);
    }

    function _transfer(address from, address to, uint256 id) internal {
        address tokenOwner = ownerOf(id);
        if (tokenOwner != from || to == address(0)) revert InvalidOwner();
        if (!isActive(id)) revert NameNotActive();
        if (
            msg.sender != tokenOwner && _tokenApprovals[id] != msg.sender
                && !_operatorApprovals[tokenOwner][msg.sender]
        ) {
            revert NotApprovedOrOwner();
        }

        delete _tokenApprovals[id];
        unchecked {
            --_balances[from];
            ++_balances[to];
        }
        _owners[id] = to;
        registry.setSubnodeOwner(baseNode, bytes32(id), to);
        emit Transfer(from, to, id);
    }

    function _mint(address to, uint256 id) internal {
        _owners[id] = to;
        unchecked {
            ++_balances[to];
        }
        emit Transfer(address(0), to, id);
    }

    function _burn(uint256 id) internal {
        address tokenOwner = _owners[id];
        delete _tokenApprovals[id];
        unchecked {
            --_balances[tokenOwner];
        }
        delete _owners[id];
        registry.setSubnodeOwner(baseNode, bytes32(id), address(0));
        emit Transfer(tokenOwner, address(0), id);
    }
}
