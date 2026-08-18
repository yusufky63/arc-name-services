// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { TestBase } from "./TestBase.sol";
import { DeployArcNameServiceV2 } from "../script/DeployArcNameServiceV2.s.sol";
import { ArcBaseRegistrarV2 } from "../src/ArcBaseRegistrarV2.sol";
import { ArcRegistrarController } from "../src/ArcRegistrarController.sol";
import { MockUSDC } from "./mocks/MockUSDC.sol";

contract DeployArcNameServiceV2Test is TestBase, DeployArcNameServiceV2 {
    uint256 private constant _ARC_TESTNET_CHAIN_ID = 5_042_002;
    address private constant _USDC = 0x3600000000000000000000000000000000000000;
    bytes32 private constant _NORMALIZATION_PROFILE_HASH =
        0x0889fdb1d0500090d2c605094dd2bd30510a137778f641aca67d8d2fb491f89c;
    bytes32 private constant _BASE_NODE =
        0xb0622ac8c513b1e04f26418271b595fae314dbed2e3dea63916fc45cde7c5bbe;
    bytes32 private constant _REVERSE_NODE =
        0x91d1777781884d03a6757a803996e38de2a42967fb37eeaca72729271025a9e2;
    bytes32 private constant _REVERSE_ROOT =
        0xa097f6721ce401e757d1223a763fef49b8b5f90bb18567ddb86fd205dff71d34;
    uint256 private constant _SIGNER_KEY = 0xC0170;
    uint256 private constant _REFERRAL_BPS = 500;
    uint256 private constant _MARKETPLACE_FEE_BPS = 250;
    string private constant _METADATA_BASE_URI =
        "https://contour-arc.vercel.app/api/metadata/";

    address private governance;
    address private alice = address(0xA11CE);
    address private bob = address(0xB0B);
    address private referrer = address(0xBEEF);
    bytes32 private releaseId = keccak256("contour-metadata-release-2");

    function setUp() public {
        vm.chainId(_ARC_TESTNET_CHAIN_ID);
        vm.warp(1_800_000_000);
        governance = vm.addr(_SIGNER_KEY);

        MockUSDC settlementAsset = new MockUSDC();
        vm.etch(_USDC, address(settlementAsset).code);
    }

    function testRunDeploysMetadataCapableAndLockedSevenContractSuite() public {
        Deployment memory deployed = this.runForTest();

        address[7] memory contracts_ = [
            address(deployed.registry),
            address(deployed.baseRegistrar),
            address(deployed.controller),
            address(deployed.publicResolver),
            address(deployed.reverseRegistrar),
            address(deployed.universalResolver),
            address(deployed.marketplace)
        ];
        for (uint256 i; i < contracts_.length; ++i) {
            assertTrue(contracts_[i].code.length != 0);
            for (uint256 j = i + 1; j < contracts_.length; ++j) {
                assertTrue(contracts_[i] != contracts_[j]);
            }
        }

        assertEq(deployed.registry.owner(bytes32(0)), governance);
        assertEq(deployed.registry.owner(_REVERSE_ROOT), governance);
        assertEq(deployed.registry.owner(_BASE_NODE), address(deployed.baseRegistrar));
        assertEq(deployed.registry.owner(_REVERSE_NODE), address(deployed.reverseRegistrar));
        assertEq(address(deployed.baseRegistrar.registry()), address(deployed.registry));
        assertEq(deployed.baseRegistrar.baseNode(), _BASE_NODE);
        assertTrue(deployed.baseRegistrar.controllers(address(deployed.controller)));
        assertTrue(deployed.baseRegistrar.supportsInterface(0x01ffc9a7));
        assertTrue(deployed.baseRegistrar.supportsInterface(0x80ac58cd));
        assertTrue(deployed.baseRegistrar.supportsInterface(0x5b5e139f));
        assertEq(deployed.baseRegistrar.metadataBaseURI(), _METADATA_BASE_URI);

        assertEq(address(deployed.controller.registrar()), address(deployed.baseRegistrar));
        assertEq(address(deployed.controller.settlementAsset()), _USDC);
        assertEq(deployed.controller.publicResolver(), address(deployed.publicResolver));
        assertEq(deployed.controller.baseNode(), _BASE_NODE);
        assertEq(deployed.controller.releaseId(), releaseId);
        assertEq(deployed.controller.normalizationProfileHash(), _NORMALIZATION_PROFILE_HASH);
        assertEq(deployed.controller.permitSigner(), governance);
        assertEq(deployed.controller.treasury(), governance);
        assertEq(uint256(deployed.controller.referralBps()), _REFERRAL_BPS);
        assertTrue(deployed.controller.registrationsPaused());

        assertEq(address(deployed.publicResolver.registry()), address(deployed.registry));
        assertEq(address(deployed.reverseRegistrar.registry()), address(deployed.registry));
        assertEq(
            address(deployed.reverseRegistrar.defaultResolver()), address(deployed.publicResolver)
        );
        assertEq(address(deployed.reverseRegistrar.registrar()), address(deployed.baseRegistrar));
        assertEq(deployed.reverseRegistrar.reverseNode(), _REVERSE_NODE);
        assertEq(deployed.reverseRegistrar.baseNode(), _BASE_NODE);
        assertEq(deployed.reverseRegistrar.suffix(), "contour");
        assertEq(address(deployed.universalResolver.registry()), address(deployed.registry));
        assertEq(
            address(deployed.universalResolver.reverseRegistrar()),
            address(deployed.reverseRegistrar)
        );

        assertEq(address(deployed.marketplace.registrar()), address(deployed.baseRegistrar));
        assertEq(address(deployed.marketplace.settlementAsset()), _USDC);
        assertEq(deployed.marketplace.treasury(), governance);
        assertEq(uint256(deployed.marketplace.feeBps()), _MARKETPLACE_FEE_BPS);
        assertTrue(deployed.marketplace.paused());

        assertEq(deployed.baseRegistrar.owner(), governance);
        assertEq(deployed.controller.owner(), governance);
        assertEq(deployed.marketplace.owner(), governance);
        assertEq(deployed.baseRegistrar.pendingOwner(), address(0));
        assertEq(deployed.controller.pendingOwner(), address(0));
        assertEq(deployed.marketplace.pendingOwner(), address(0));
    }

    function testCleanSuiteSupportsPermitRegistrationMetadataAndMarketplacePurchase() public {
        Deployment memory deployed = this.runForTest();

        vm.startPrank(governance);
        deployed.controller.setRegistrationsPaused(false);
        deployed.marketplace.setPaused(false);
        vm.stopPrank();

        MockUSDC usdc = MockUSDC(_USDC);
        string memory label = "alice";
        uint256 registrationPrice = deployed.controller.quote(label, 1);
        usdc.mint(alice, registrationPrice);

        vm.prank(alice);
        usdc.approve(address(deployed.controller), registrationPrice);

        bytes[] memory resolverData = new bytes[](0);
        ArcRegistrarController.RegistrationPermit memory permit =
            _registrationPermit(deployed, label, resolverData, registrationPrice);
        bytes memory signature = _sign(deployed.controller, permit);

        vm.prank(alice);
        (uint256 tokenId, uint256 expires) =
            deployed.controller.register(label, permit, resolverData, signature);

        uint256 referralCredit = registrationPrice * _REFERRAL_BPS / 10_000;
        assertEq(deployed.baseRegistrar.ownerOf(tokenId), alice);
        assertEq(deployed.baseRegistrar.nameExpires(tokenId), expires);
        assertEq(
            deployed.baseRegistrar.tokenURI(tokenId),
            string.concat(_METADATA_BASE_URI, vm.toString(tokenId))
        );
        assertEq(usdc.balanceOf(address(deployed.controller)), registrationPrice);
        assertEq(deployed.controller.referralCredits(referrer), referralCredit);
        assertEq(deployed.controller.totalReferralLiability(), referralCredit);

        uint256 salePrice = 7_500_000;
        usdc.mint(bob, salePrice);
        vm.prank(bob);
        usdc.approve(address(deployed.marketplace), salePrice);

        vm.startPrank(alice);
        deployed.baseRegistrar.setApprovalForAll(address(deployed.marketplace), true);
        deployed.marketplace.list(tokenId, salePrice, uint64(block.timestamp + 1 days));
        vm.stopPrank();

        vm.prank(bob);
        deployed.marketplace.buy(tokenId, salePrice, uint16(_MARKETPLACE_FEE_BPS));

        uint256 marketFee = salePrice * _MARKETPLACE_FEE_BPS / 10_000;
        assertEq(deployed.baseRegistrar.ownerOf(tokenId), bob);
        assertEq(deployed.marketplace.proceeds(alice), salePrice - marketFee);
        assertEq(deployed.marketplace.totalSellerLiability(), salePrice - marketFee);
        assertEq(usdc.balanceOf(address(deployed.marketplace)), salePrice);
        assertEq(
            deployed.baseRegistrar.tokenURI(tokenId),
            string.concat(_METADATA_BASE_URI, vm.toString(tokenId))
        );
    }

    function testRunRejectsInvalidMetadataBaseURIBeforeProducingARelease() public {
        vm.expectRevert(ArcBaseRegistrarV2.InvalidMetadataBaseURI.selector);
        this.runWithMetadataBaseURIForTest("http://contour.network/api/metadata/");
    }

    function testRunRejectsWrongChainBeforeBroadcast() public {
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(InvalidChain.selector, uint256(1)));
        this.runForTest();
    }

    function testRunRejectsMissingCanonicalSettlementAsset() public {
        vm.etch(_USDC, "");
        vm.expectRevert(InvalidSettlementAsset.selector);
        this.runForTest();
    }

    function testRunRejectsSplitGovernanceBeforeBroadcast() public {
        vm.expectRevert(InvalidGovernanceEoa.selector);
        this.runWithTreasuryForTest(address(0x7E45));
    }

    function testGovernanceRejectsSeparatePermitSigner() public {
        vm.expectRevert(InvalidPermitSigner.selector);
        this.assertGovernanceForTest(governance, governance, governance, address(0x51A9));
    }

    function assertGovernanceForTest(
        address deployer_,
        address owner_,
        address treasury_,
        address signer_
    ) external view {
        _assertGovernance(deployer_, owner_, treasury_, signer_);
    }

    function runForTest() external returns (Deployment memory) {
        return _runWithConfig(_deploymentConfig(governance, _METADATA_BASE_URI));
    }

    function runWithTreasuryForTest(address treasury_) external returns (Deployment memory) {
        return _runWithConfig(_deploymentConfig(treasury_, _METADATA_BASE_URI));
    }

    function runWithMetadataBaseURIForTest(string calldata metadataBaseURI)
        external
        returns (Deployment memory)
    {
        return _runWithConfig(_deploymentConfig(governance, metadataBaseURI));
    }

    function _registrationPermit(
        Deployment memory deployed,
        string memory label,
        bytes[] memory resolverData,
        uint256 registrationPrice
    ) private view returns (ArcRegistrarController.RegistrationPermit memory permit) {
        bytes32 labelHash = keccak256(bytes(label));
        permit = ArcRegistrarController.RegistrationPermit({
            chainId: block.chainid,
            controller: address(deployed.controller),
            releaseId: releaseId,
            normalizationProfileHash: _NORMALIZATION_PROFILE_HASH,
            normalizedLabelHash: labelHash,
            namehash: keccak256(abi.encodePacked(_BASE_NODE, labelHash)),
            requester: alice,
            recipient: alice,
            payer: alice,
            authorizedExecutor: alice,
            durationYears: 1,
            resolverDataHash: keccak256(abi.encode(resolverData)),
            referrer: referrer,
            settlementAsset: _USDC,
            expectedAmount: registrationPrice,
            expectedReferralBps: _REFERRAL_BPS,
            permitId: keccak256("contour-v2-alice-permit"),
            nonce: 0,
            issuedAt: block.timestamp,
            validAfter: block.timestamp,
            validUntil: block.timestamp + 3 minutes
        });
    }

    function _sign(
        ArcRegistrarController controller,
        ArcRegistrarController.RegistrationPermit memory permit
    ) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(_SIGNER_KEY, controller.hashPermit(permit));
        return abi.encodePacked(r, s, v);
    }

    function _deploymentConfig(address treasury_, string memory metadataBaseURI)
        private
        view
        returns (DeploymentConfig memory config)
    {
        config = DeploymentConfig({
            deployer: governance,
            owner: governance,
            treasury: treasury_,
            permitSigner: governance,
            releaseId: releaseId,
            referralBps: uint16(_REFERRAL_BPS),
            marketplaceFeeBps: uint16(_MARKETPLACE_FEE_BPS),
            metadataBaseURI: metadataBaseURI
        });
    }
}
