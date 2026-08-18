// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { ArcNameRegistry } from "../src/ArcNameRegistry.sol";
import { ArcBaseRegistrar } from "../src/ArcBaseRegistrar.sol";
import { ArcRegistrarController } from "../src/ArcRegistrarController.sol";
import { ArcPublicResolver } from "../src/ArcPublicResolver.sol";
import { ArcReverseRegistrar } from "../src/ArcReverseRegistrar.sol";
import { ArcUniversalResolver, IForwardConfirmedReverse } from "../src/ArcUniversalResolver.sol";
import { ArcNameMarketplace } from "../src/ArcNameMarketplace.sol";
import { IERC20 } from "../src/interfaces/IERC20.sol";
import { IArcBaseRegistrar } from "../src/interfaces/IArcBaseRegistrar.sol";
import { IArcPublicResolver } from "../src/interfaces/IArcPublicResolver.sol";
import { BoundedNamehash } from "../src/libraries/BoundedNamehash.sol";

interface Vm {
    function envAddress(string calldata name) external view returns (address value);
    function envBytes32(string calldata name) external view returns (bytes32 value);
    function envUint(string calldata name) external view returns (uint256 value);
    function startBroadcast(address signer) external;
    function stopBroadcast() external;
}

interface IERC20Metadata {
    function decimals() external view returns (uint8);
}

/// @notice Fail-closed Arc Testnet deployment script for the seven protocol contracts.
/// @dev Run with `forge script` and a hardware/keystore-backed broadcaster. The script never
///      reads a raw private key environment variable. It leaves registration and the market
///      paused. Deployer, protocol owner, treasury and the initial EIP-712 permit signer must all
///      be the same funded EOA for this Arc Testnet release.
contract DeployArcNameService {
    error InvalidChain(uint256 actual);
    error InvalidInput();
    error InvalidGovernanceEoa();
    error InvalidPermitSigner();
    error InvalidSettlementAsset();
    error WiringInvariantFailed();

    Vm private constant _VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant _ARC_TESTNET_CHAIN_ID = 5_042_002;
    uint256 private constant _MAX_REFERRAL_BPS = 3_000;
    uint256 private constant _MAX_MARKETPLACE_FEE_BPS = 1_000;
    address private constant _ARC_USDC = 0x3600000000000000000000000000000000000000;
    bytes32 private constant _NORMALIZATION_PROFILE_HASH =
        0x0889fdb1d0500090d2c605094dd2bd30510a137778f641aca67d8d2fb491f89c;
    bytes32 private constant _BASE_NODE =
        0xb0622ac8c513b1e04f26418271b595fae314dbed2e3dea63916fc45cde7c5bbe;
    bytes32 private constant _REVERSE_NODE =
        0x91d1777781884d03a6757a803996e38de2a42967fb37eeaca72729271025a9e2;
    string private constant _SUFFIX = "contour";

    struct DeploymentConfig {
        address deployer;
        address owner;
        address treasury;
        address permitSigner;
        bytes32 releaseId;
        uint16 referralBps;
        uint16 marketplaceFeeBps;
    }

    struct Deployment {
        ArcNameRegistry registry;
        ArcBaseRegistrar baseRegistrar;
        ArcRegistrarController controller;
        ArcPublicResolver publicResolver;
        ArcReverseRegistrar reverseRegistrar;
        ArcUniversalResolver universalResolver;
        ArcNameMarketplace marketplace;
    }

    function run() external returns (Deployment memory deployed) {
        _assertReleaseEnvironment();
        deployed = _deployWithConfig(_loadConfig());
    }

    /// @dev Test harnesses use this path with in-memory configuration so parallel tests never
    ///      mutate Foundry's process-global environment. Production callers always use run().
    function _runWithConfig(DeploymentConfig memory config)
        internal
        returns (Deployment memory deployed)
    {
        _assertReleaseEnvironment();
        deployed = _deployWithConfig(config);
    }

    function _deployWithConfig(DeploymentConfig memory config)
        private
        returns (Deployment memory deployed)
    {
        _assertGovernance(config.deployer, config.owner, config.treasury, config.permitSigner);

        // Binding broadcast mode to the configured deployer makes a CLI wallet mismatch fatal.
        // Foundry must have a keystore or hardware signer for this exact address; this script has
        // no private-key overload and never reads raw key material from the environment.
        _VM.startBroadcast(config.deployer);
        _deployCore(deployed, config);
        _wireNamespacesAndDeployReads(deployed, config);
        _deployMarketAndLock(deployed, config);
        _VM.stopBroadcast();

        _assertDeployment(deployed, config);
    }

    function _assertReleaseEnvironment() private view {
        if (block.chainid != _ARC_TESTNET_CHAIN_ID) revert InvalidChain(block.chainid);
        if (
            BoundedNamehash.namehash(_SUFFIX, 255, 10) != _BASE_NODE
                || BoundedNamehash.namehash("addr.reverse", 255, 10) != _REVERSE_NODE
        ) revert WiringInvariantFailed();
        _assertSettlementAsset();
    }

    function _loadConfig() private view returns (DeploymentConfig memory config) {
        config.deployer = _VM.envAddress("DEPLOYER_ADDRESS");
        config.owner = _VM.envAddress("OWNER_ADDRESS");
        config.treasury = _VM.envAddress("TREASURY_ADDRESS");
        config.permitSigner = _VM.envAddress("PERMIT_SIGNER_ADDRESS");
        config.releaseId = _VM.envBytes32("RELEASE_ID");
        uint256 referralBpsRaw = _VM.envUint("REFERRAL_BPS");
        uint256 marketplaceFeeBpsRaw = _VM.envUint("MARKETPLACE_FEE_BPS");
        if (
            config.deployer == address(0) || config.owner == address(0)
                || config.treasury == address(0) || config.permitSigner == address(0)
                || config.releaseId == bytes32(0) || referralBpsRaw > _MAX_REFERRAL_BPS
                || marketplaceFeeBpsRaw > _MAX_MARKETPLACE_FEE_BPS
        ) revert InvalidInput();
        // Values are bounded far below uint16.max above.
        // forge-lint: disable-next-line(unsafe-typecast)
        config.referralBps = uint16(referralBpsRaw);
        // forge-lint: disable-next-line(unsafe-typecast)
        config.marketplaceFeeBps = uint16(marketplaceFeeBpsRaw);
    }

    function _deployCore(Deployment memory deployed, DeploymentConfig memory config) private {
        deployed.registry = new ArcNameRegistry(config.deployer);
        deployed.baseRegistrar =
            new ArcBaseRegistrar(deployed.registry, _BASE_NODE, config.deployer);
        deployed.publicResolver = new ArcPublicResolver(deployed.registry);
        deployed.controller = new ArcRegistrarController(
            IArcBaseRegistrar(address(deployed.baseRegistrar)),
            IERC20(_ARC_USDC),
            address(deployed.publicResolver),
            config.deployer,
            config.permitSigner,
            config.treasury,
            config.releaseId,
            _NORMALIZATION_PROFILE_HASH,
            config.referralBps
        );
    }

    function _wireNamespacesAndDeployReads(
        Deployment memory deployed,
        DeploymentConfig memory config
    ) private {
        deployed.registry
            .setSubnodeOwner(bytes32(0), keccak256(bytes(_SUFFIX)), address(deployed.baseRegistrar));
        deployed.baseRegistrar.setController(address(deployed.controller), true);
        bytes32 reverseRoot =
            deployed.registry.setSubnodeOwner(bytes32(0), keccak256("reverse"), config.deployer);
        deployed.reverseRegistrar = new ArcReverseRegistrar(
            deployed.registry,
            IArcPublicResolver(address(deployed.publicResolver)),
            IArcBaseRegistrar(address(deployed.baseRegistrar)),
            _REVERSE_NODE,
            _BASE_NODE,
            _SUFFIX
        );
        deployed.registry
            .setSubnodeOwner(reverseRoot, keccak256("addr"), address(deployed.reverseRegistrar));
        deployed.universalResolver = new ArcUniversalResolver(
            deployed.registry, IForwardConfirmedReverse(address(deployed.reverseRegistrar))
        );
    }

    function _deployMarketAndLock(Deployment memory deployed, DeploymentConfig memory config)
        private
    {
        deployed.marketplace = new ArcNameMarketplace(
            IArcBaseRegistrar(address(deployed.baseRegistrar)),
            IERC20(_ARC_USDC),
            config.deployer,
            config.treasury,
            config.marketplaceFeeBps
        );
        // A deployment is intentionally unusable until the verified manifest and permit signer
        // are active. The broadcaster is already the final owner, so no acceptance transaction
        // or externally coordinated ownership ceremony is needed.
        deployed.controller.setRegistrationsPaused(true);
        deployed.marketplace.setPaused(true);
        deployed.registry.setOwner(_reverseRoot(), config.owner);
        deployed.registry.setOwner(bytes32(0), config.owner);
    }

    function _assertGovernance(
        address deployer,
        address owner,
        address treasury,
        address permitSigner
    ) internal view {
        if (
            deployer != owner || owner != treasury || deployer.code.length != 0
                || owner.code.length != 0 || treasury.code.length != 0
        ) revert InvalidGovernanceEoa();
        if (permitSigner != deployer || permitSigner.code.length != 0) {
            revert InvalidPermitSigner();
        }
    }

    function _assertSettlementAsset() private view {
        if (_ARC_USDC.code.length == 0) revert InvalidSettlementAsset();
        try IERC20Metadata(_ARC_USDC).decimals() returns (uint8 decimals) {
            if (decimals != 6) revert InvalidSettlementAsset();
        } catch {
            revert InvalidSettlementAsset();
        }
    }

    function _reverseRoot() private pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes32(0), keccak256(bytes("reverse"))));
    }

    function _assertDeployment(Deployment memory deployed, DeploymentConfig memory config)
        private
        view
    {
        address registryAddress = address(deployed.registry);
        address registrarAddress = address(deployed.baseRegistrar);
        address controllerAddress = address(deployed.controller);
        address resolverAddress = address(deployed.publicResolver);
        address reverseAddress = address(deployed.reverseRegistrar);
        address universalAddress = address(deployed.universalResolver);
        address marketplaceAddress = address(deployed.marketplace);

        if (
            registryAddress == address(0) || registrarAddress == address(0)
                || controllerAddress == address(0) || resolverAddress == address(0)
                || reverseAddress == address(0) || universalAddress == address(0)
                || marketplaceAddress == address(0) || registryAddress == registrarAddress
                || registryAddress == controllerAddress || registryAddress == resolverAddress
                || registryAddress == reverseAddress || registryAddress == universalAddress
                || registryAddress == marketplaceAddress || registrarAddress == controllerAddress
                || registrarAddress == resolverAddress || registrarAddress == reverseAddress
                || registrarAddress == universalAddress || registrarAddress == marketplaceAddress
                || controllerAddress == resolverAddress || controllerAddress == reverseAddress
                || controllerAddress == universalAddress || controllerAddress == marketplaceAddress
                || resolverAddress == reverseAddress || resolverAddress == universalAddress
                || resolverAddress == marketplaceAddress || reverseAddress == universalAddress
                || reverseAddress == marketplaceAddress || universalAddress == marketplaceAddress
        ) revert WiringInvariantFailed();

        if (
            deployed.registry.owner(bytes32(0)) != config.owner
                || deployed.registry.owner(_reverseRoot()) != config.owner
                || deployed.registry.owner(_BASE_NODE) != registrarAddress
                || deployed.registry.owner(_REVERSE_NODE) != reverseAddress
                || address(deployed.baseRegistrar.registry()) != registryAddress
                || deployed.baseRegistrar.baseNode() != _BASE_NODE
                || !deployed.baseRegistrar.controllers(controllerAddress)
                || address(deployed.controller.registrar()) != registrarAddress
                || address(deployed.controller.settlementAsset()) != _ARC_USDC
                || deployed.controller.publicResolver() != resolverAddress
                || deployed.controller.baseNode() != _BASE_NODE
                || deployed.controller.releaseId() != config.releaseId
                || deployed.controller.normalizationProfileHash() != _NORMALIZATION_PROFILE_HASH
                || deployed.controller.permitSigner() != config.permitSigner
                || deployed.controller.treasury() != config.treasury
                || deployed.controller.referralBps() != config.referralBps
                || address(deployed.publicResolver.registry()) != registryAddress
        ) revert WiringInvariantFailed();

        if (
            address(deployed.reverseRegistrar.registry()) != registryAddress
                || address(deployed.reverseRegistrar.defaultResolver()) != resolverAddress
                || address(deployed.reverseRegistrar.registrar()) != registrarAddress
                || deployed.reverseRegistrar.reverseNode() != _REVERSE_NODE
                || deployed.reverseRegistrar.baseNode() != _BASE_NODE
                || keccak256(bytes(deployed.reverseRegistrar.suffix())) != keccak256(bytes(_SUFFIX))
                || address(deployed.universalResolver.registry()) != registryAddress
                || address(deployed.universalResolver.reverseRegistrar()) != reverseAddress
                || address(deployed.marketplace.registrar()) != registrarAddress
                || address(deployed.marketplace.settlementAsset()) != _ARC_USDC
                || deployed.marketplace.treasury() != config.treasury
                || deployed.marketplace.feeBps() != config.marketplaceFeeBps
        ) revert WiringInvariantFailed();

        if (
            deployed.baseRegistrar.owner() != config.deployer
                || deployed.controller.owner() != config.deployer
                || deployed.marketplace.owner() != config.deployer
                || deployed.baseRegistrar.pendingOwner() != address(0)
                || deployed.controller.pendingOwner() != address(0)
                || deployed.marketplace.pendingOwner() != address(0)
                || !deployed.controller.registrationsPaused() || !deployed.marketplace.paused()
        ) revert WiringInvariantFailed();
    }
}
