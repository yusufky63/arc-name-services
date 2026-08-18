// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { TestBase } from "./TestBase.sol";
import { MockUSDC } from "./mocks/MockUSDC.sol";
import { ArcNameRegistry } from "../src/ArcNameRegistry.sol";
import { ArcBaseRegistrar } from "../src/ArcBaseRegistrar.sol";
import { ArcRegistrarController } from "../src/ArcRegistrarController.sol";
import { ArcPublicResolver } from "../src/ArcPublicResolver.sol";
import { ArcReverseRegistrar } from "../src/ArcReverseRegistrar.sol";
import { ArcUniversalResolver } from "../src/ArcUniversalResolver.sol";
import { ArcNameMarketplace } from "../src/ArcNameMarketplace.sol";
import { SafeERC20 } from "../src/libraries/SafeERC20.sol";
import { IArcBaseRegistrar } from "../src/interfaces/IArcBaseRegistrar.sol";
import { IArcPublicResolver } from "../src/interfaces/IArcPublicResolver.sol";
import { IForwardConfirmedReverse } from "../src/ArcUniversalResolver.sol";
import { BoundedNamehash } from "../src/libraries/BoundedNamehash.sol";
import { Utf8 } from "../src/libraries/Utf8.sol";

contract ArcNameServiceTest is TestBase {
    uint256 private constant _SIGNER_KEY = 0xA11CE;
    uint256 private constant _NEXT_SIGNER_KEY = 0xBEEF;
    uint256 private constant _ANNUAL_PRICE = 500_000; // 4+ code points, 0.50 USDC
    uint16 private constant _REFERRAL_BPS = 500;
    uint16 private constant _MARKET_FEE_BPS = 250;
    uint256 private constant _GRACE_PERIOD = 90 days;
    bytes4 private constant _TEST_INTERFACE_ID = 0x12345678;

    address private alice = address(0xA11CE);
    address private bob = address(0xB0B);
    address private attacker = address(0xBAD);
    address private referrer = address(0xFEE1);
    address private treasury = address(0x7E45);
    address private permitSigner;

    MockUSDC private usdc;
    ArcNameRegistry private registry;
    ArcBaseRegistrar private registrar;
    ArcRegistrarController private controller;
    ArcPublicResolver private resolver;
    ArcReverseRegistrar private reverseRegistrar;
    ArcUniversalResolver private universalResolver;
    ArcNameMarketplace private marketplace;

    bytes32 private suffixLabelHash;
    bytes32 private baseNode;
    bytes32 private reverseNode;
    bytes32 private releaseId = keccak256("arc-name-release-1");
    bytes32 private profileHash =
        0x0889fdb1d0500090d2c605094dd2bd30510a137778f641aca67d8d2fb491f89c;

    function setUp() public {
        vm.chainId(5_042_002);
        vm.warp(1_800_000_000);
        permitSigner = vm.addr(_SIGNER_KEY);

        registry = new ArcNameRegistry(address(this));
        suffixLabelHash = keccak256("contour");
        baseNode = keccak256(abi.encodePacked(bytes32(0), suffixLabelHash));

        registrar = new ArcBaseRegistrar(registry, baseNode, address(this));
        resolver = new ArcPublicResolver(registry);
        usdc = new MockUSDC();
        controller = new ArcRegistrarController(
            IArcBaseRegistrar(address(registrar)),
            usdc,
            address(resolver),
            address(this),
            permitSigner,
            treasury,
            releaseId,
            profileHash,
            _REFERRAL_BPS
        );

        registry.setSubnodeOwner(bytes32(0), suffixLabelHash, address(registrar));
        registrar.setController(address(controller), true);

        bytes32 reverseRoot =
            registry.setSubnodeOwner(bytes32(0), keccak256("reverse"), address(this));
        reverseNode = keccak256(abi.encodePacked(reverseRoot, keccak256("addr")));
        reverseRegistrar = new ArcReverseRegistrar(
            registry,
            IArcPublicResolver(address(resolver)),
            IArcBaseRegistrar(address(registrar)),
            reverseNode,
            baseNode,
            "contour"
        );
        registry.setSubnodeOwner(reverseRoot, keccak256("addr"), address(reverseRegistrar));
        universalResolver = new ArcUniversalResolver(
            registry, IForwardConfirmedReverse(address(reverseRegistrar))
        );
        marketplace = new ArcNameMarketplace(
            IArcBaseRegistrar(address(registrar)), usdc, address(this), treasury, _MARKET_FEE_BPS
        );

        usdc.mint(alice, 1_000_000_000);
        usdc.mint(bob, 1_000_000_000);
        vm.prank(alice);
        usdc.approve(address(controller), type(uint256).max);
        vm.prank(alice);
        usdc.approve(address(marketplace), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(controller), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(marketplace), type(uint256).max);
    }

    function testRegistryConformanceAndAuthorization() public {
        bytes32 label = keccak256("child");
        bytes32 node = keccak256(abi.encodePacked(bytes32(0), label));

        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(ArcNameRegistry.Unauthorized.selector, bytes32(0), attacker)
        );
        registry.setSubnodeOwner(bytes32(0), label, attacker);

        registry.setSubnodeOwner(bytes32(0), label, alice);
        assertEq(registry.owner(node), alice);
        assertTrue(registry.recordExists(node));

        vm.startPrank(alice);
        registry.setResolver(node, address(resolver));
        registry.setTTL(node, 60);
        vm.stopPrank();
        assertEq(registry.resolver(node), address(resolver));
        assertEq(uint256(registry.ttl(node)), 60);
    }

    function testPermitRegistrationConfiguresResolverAndLiabilities() public {
        bytes[] memory data = _resolverData("alice", alice);
        ArcRegistrarController.RegistrationPermit memory permit =
            _permit("alice", alice, alice, alice, referrer, bytes32("permit-1"), 0, data);
        bytes memory signature = _sign(permit);

        vm.prank(alice);
        (uint256 tokenId, uint256 expires) = controller.register("alice", permit, data, signature);

        bytes32 labelHash = keccak256("alice");
        bytes32 node = keccak256(abi.encodePacked(baseNode, labelHash));
        assertEq(tokenId, uint256(labelHash));
        assertEq(registrar.ownerOf(tokenId), alice);
        assertEq(registry.owner(node), alice);
        assertEq(registry.resolver(node), address(resolver));
        assertEq(resolver.addr(node), alice);
        assertEq(expires, block.timestamp + 365 days);
        assertTrue(controller.usedPermit(bytes32("permit-1")));
        assertEq(controller.nonces(alice), 1);

        uint256 referralAmount = _ANNUAL_PRICE * _REFERRAL_BPS / 10_000;
        assertEq(controller.referralCredits(referrer), referralAmount);
        assertEq(controller.totalReferralLiability(), referralAmount);
        assertEq(usdc.balanceOf(address(controller)), _ANNUAL_PRICE);

        (bytes32 resolvedNode, address resolved) = universalResolver.resolveAddress("alice.contour");
        assertEq(resolvedNode, node);
        assertEq(resolved, alice);
    }

    function testCopiedCalldataCannotRegister() public {
        bytes[] memory data = _resolverData("alice", alice);
        ArcRegistrarController.RegistrationPermit memory permit =
            _permit("alice", alice, alice, alice, address(0), bytes32("copied"), 0, data);
        bytes memory signature = _sign(permit);

        vm.prank(attacker);
        vm.expectRevert(ArcRegistrarController.UnauthorizedExecutor.selector);
        controller.register("alice", permit, data, signature);

        assertFalse(controller.usedPermit(bytes32("copied")));
        assertEq(controller.nonces(alice), 0);
        assertEq(usdc.balanceOf(address(controller)), 0);
    }

    function testReplayAndDoubleIssuedNonceAreRejected() public {
        bytes[] memory aliceData = _resolverData("alice", alice);
        ArcRegistrarController.RegistrationPermit memory first =
            _permit("alice", alice, alice, alice, address(0), bytes32("first"), 0, aliceData);
        bytes memory firstSignature = _sign(first);

        bytes[] memory secondData = _resolverData("second", alice);
        ArcRegistrarController.RegistrationPermit memory second =
            _permit("second", alice, alice, alice, address(0), bytes32("second"), 0, secondData);
        bytes memory secondSignature = _sign(second);

        vm.prank(alice);
        controller.register("alice", first, aliceData, firstSignature);

        vm.prank(alice);
        vm.expectRevert(ArcRegistrarController.PermitAlreadyUsed.selector);
        controller.register("alice", first, aliceData, firstSignature);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ArcRegistrarController.NonceMismatch.selector, 1, 0));
        controller.register("second", second, secondData, secondSignature);
        assertFalse(controller.usedPermit(bytes32("second")));
    }

    function testPriceAndReferralGuardsRunBeforePayment() public {
        bytes[] memory data = _resolverData("alice", alice);
        ArcRegistrarController.RegistrationPermit memory stalePrice =
            _permit("alice", alice, alice, alice, referrer, bytes32("stale-price"), 0, data);
        stalePrice.expectedAmount = _ANNUAL_PRICE + 1;
        bytes memory stalePriceSignature = _sign(stalePrice);

        uint256 payerBalance = usdc.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                ArcRegistrarController.PriceChanged.selector, _ANNUAL_PRICE + 1, _ANNUAL_PRICE
            )
        );
        controller.register("alice", stalePrice, data, stalePriceSignature);
        assertEq(usdc.balanceOf(alice), payerBalance);
        assertFalse(controller.usedPermit(bytes32("stale-price")));

        ArcRegistrarController.RegistrationPermit memory staleReferral =
            _permit("alice", alice, alice, alice, referrer, bytes32("stale-referral"), 0, data);
        bytes memory staleReferralSignature = _sign(staleReferral);
        controller.setReferralBps(_REFERRAL_BPS + 1);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                ArcRegistrarController.ReferralChanged.selector, _REFERRAL_BPS, _REFERRAL_BPS + 1
            )
        );
        controller.register("alice", staleReferral, data, staleReferralSignature);
        assertEq(usdc.balanceOf(alice), payerBalance);
    }

    function testWrongDomainAndResolverNodeMismatchRevertBeforePayment() public {
        bytes[] memory data = _resolverData("alice", alice);
        ArcRegistrarController.RegistrationPermit memory wrongChain =
            _permit("alice", alice, alice, alice, address(0), bytes32("wrong-chain"), 0, data);
        wrongChain.chainId = 1;
        bytes memory wrongChainSignature = _sign(wrongChain);

        vm.prank(alice);
        vm.expectRevert(ArcRegistrarController.InvalidPermitDomain.selector);
        controller.register("alice", wrongChain, data, wrongChainSignature);

        bytes[] memory wrongNodeData = new bytes[](1);
        wrongNodeData[0] = abi.encodeWithSignature("setAddr(bytes32,address)", baseNode, alice);
        ArcRegistrarController.RegistrationPermit memory wrongNode = _permit(
            "alice", alice, alice, alice, address(0), bytes32("wrong-node"), 0, wrongNodeData
        );
        bytes memory wrongNodeSignature = _sign(wrongNode);

        vm.prank(alice);
        vm.expectRevert(ArcPublicResolver.NodeMismatch.selector);
        controller.register("alice", wrongNode, wrongNodeData, wrongNodeSignature);
        assertFalse(controller.usedPermit(bytes32("wrong-node")));
        assertEq(usdc.balanceOf(address(controller)), 0);
    }

    function testCompromisedSignerCannotChargeAnotherApprovedPayer() public {
        bytes[] memory data = _resolverData("stolen", bob);
        ArcRegistrarController.RegistrationPermit memory permit =
            _permit("stolen", bob, alice, bob, address(0), bytes32("payer-theft"), 0, data);
        permit.requester = bob;
        bytes memory signature = _sign(permit);
        uint256 payerBalance = usdc.balanceOf(alice);

        vm.prank(bob);
        vm.expectRevert(ArcRegistrarController.InvalidParty.selector);
        controller.register("stolen", permit, data, signature);

        assertEq(usdc.balanceOf(alice), payerBalance);
        assertFalse(controller.usedPermit(bytes32("payer-theft")));
    }

    function testExactDeltaRejectsFeeOnTransferAndRollsBackPermit() public {
        usdc.setTransferFeeBps(100);
        bytes[] memory data = _resolverData("alice", alice);
        ArcRegistrarController.RegistrationPermit memory permit =
            _permit("alice", alice, alice, alice, address(0), bytes32("delta"), 0, data);
        bytes memory signature = _sign(permit);
        uint256 payerBalance = usdc.balanceOf(alice);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                ArcRegistrarController.IncorrectPaymentDelta.selector,
                _ANNUAL_PRICE,
                _ANNUAL_PRICE * 99 / 100
            )
        );
        controller.register("alice", permit, data, signature);

        assertFalse(controller.usedPermit(bytes32("delta")));
        assertEq(controller.nonces(alice), 0);
        assertEq(usdc.balanceOf(alice), payerBalance);
        assertEq(usdc.balanceOf(address(controller)), 0);
    }

    function testPermitBindsPartiesExpiresAndBlocklistRollsBackState() public {
        bytes[] memory data = _resolverData("alice", alice);
        ArcRegistrarController.RegistrationPermit memory bound =
            _permit("alice", alice, alice, alice, address(0), bytes32("bound"), 0, data);
        bytes memory boundSignature = _sign(bound);
        bound.recipient = bob;

        vm.prank(alice);
        vm.expectRevert(ArcRegistrarController.InvalidPermitSigner.selector);
        controller.register("alice", bound, data, boundSignature);

        ArcRegistrarController.RegistrationPermit memory expired =
            _permit("alice", alice, alice, alice, address(0), bytes32("expired"), 0, data);
        expired.issuedAt = block.timestamp - 5 minutes;
        expired.validAfter = expired.issuedAt;
        expired.validUntil = block.timestamp - 2 minutes;
        bytes memory expiredSignature = _sign(expired);
        vm.prank(alice);
        vm.expectRevert(ArcRegistrarController.PermitExpired.selector);
        controller.register("alice", expired, data, expiredSignature);

        ArcRegistrarController.RegistrationPermit memory blocked =
            _permit("alice", alice, alice, alice, address(0), bytes32("blocked"), 0, data);
        bytes memory blockedSignature = _sign(blocked);
        usdc.setBlocklisted(alice, true);
        vm.prank(alice);
        vm.expectRevert(SafeERC20.ERC20CallFailed.selector);
        controller.register("alice", blocked, data, blockedSignature);
        assertFalse(controller.usedPermit(bytes32("blocked")));
        assertEq(controller.nonces(alice), 0);
        assertEq(usdc.balanceOf(address(controller)), 0);
    }

    function testSignerRotationDelayAndEmergencyRevoke() public {
        address nextSigner = vm.addr(_NEXT_SIGNER_KEY);
        controller.proposePermitSigner(nextSigner);
        assertEq(controller.pendingPermitSigner(), nextSigner);

        vm.expectRevert(ArcRegistrarController.SignerActivationNotReady.selector);
        controller.activatePermitSigner();

        vm.warp(controller.pendingPermitSignerValidAfter());
        controller.activatePermitSigner();
        assertEq(controller.permitSigner(), nextSigner);

        bytes[] memory data = _resolverData("alice", alice);
        ArcRegistrarController.RegistrationPermit memory permit =
            _permit("alice", alice, alice, alice, address(0), bytes32("rotated"), 0, data);
        bytes memory signature = _signWith(_NEXT_SIGNER_KEY, permit);
        vm.prank(alice);
        controller.register("alice", permit, data, signature);

        controller.revokePermitSigner();
        assertEq(controller.permitSigner(), address(0));
        bytes[] memory nextData = _resolverData("second", alice);
        ArcRegistrarController.RegistrationPermit memory revoked =
            _permit("second", alice, alice, alice, address(0), bytes32("revoked"), 1, nextData);
        bytes memory revokedSignature = _signWith(_NEXT_SIGNER_KEY, revoked);
        vm.prank(alice);
        vm.expectRevert(ArcRegistrarController.InvalidPermitSigner.selector);
        controller.register("second", revoked, nextData, revokedSignature);
        assertFalse(controller.usedPermit(bytes32("revoked")));
    }

    function testPermitWindowHardMaximumAndRenewRegistrantGuard() public {
        bytes[] memory data = _resolverData("alice", alice);
        ArcRegistrarController.RegistrationPermit memory tooLong =
            _permit("alice", alice, alice, alice, address(0), bytes32("too-long"), 0, data);
        tooLong.validUntil = tooLong.validAfter + 301;
        bytes memory signature = _sign(tooLong);
        vm.prank(alice);
        vm.expectRevert(ArcRegistrarController.InvalidPermitWindow.selector);
        controller.register("alice", tooLong, data, signature);

        bytes[] memory skewData = _resolverData("skew", alice);
        ArcRegistrarController.RegistrationPermit memory tooMuchSkew =
            _permit("skew", alice, alice, alice, address(0), bytes32("too-much-skew"), 0, skewData);
        tooMuchSkew.validAfter = tooMuchSkew.issuedAt - 6;
        bytes memory skewSignature = _sign(tooMuchSkew);
        vm.prank(alice);
        vm.expectRevert(ArcRegistrarController.InvalidPermitWindow.selector);
        controller.register("skew", tooMuchSkew, skewData, skewSignature);

        _register("alice", alice, alice, 0);
        uint256 bobBalance = usdc.balanceOf(bob);
        vm.prank(bob);
        vm.expectRevert(ArcRegistrarController.NotRegistrant.selector);
        controller.renew("alice", 1, _ANNUAL_PRICE);
        assertEq(usdc.balanceOf(bob), bobBalance);
        assertEq(registrar.gracePeriod(), _GRACE_PERIOD);
    }

    function testRegistrarTransferExpiryGraceAndRenewal() public {
        uint256 tokenId = _register("alice", alice, alice, 0);
        bytes32 node = keccak256(abi.encodePacked(baseNode, bytes32(tokenId)));

        vm.prank(alice);
        registrar.transferFrom(alice, bob, tokenId);
        assertEq(registrar.ownerOf(tokenId), bob);
        assertEq(registry.owner(node), bob);

        uint256 oldExpiry = registrar.nameExpires(tokenId);
        vm.warp(oldExpiry + 1);
        assertFalse(registrar.isActive(tokenId));
        assertTrue(registrar.inGracePeriod(tokenId));

        vm.prank(bob);
        vm.expectRevert(ArcBaseRegistrar.NameNotActive.selector);
        registrar.transferFrom(bob, alice, tokenId);

        vm.prank(bob);
        uint256 renewedExpiry = controller.renew("alice", 1, _ANNUAL_PRICE);
        assertEq(renewedExpiry, oldExpiry + 365 days);
        assertTrue(registrar.isActive(tokenId));

        vm.warp(renewedExpiry + _GRACE_PERIOD + 1);
        assertTrue(registrar.available(tokenId));
    }

    function testReverseNameRequiresLiveForwardConfirmation() public {
        uint256 tokenId = _register("alice", alice, alice, 0);
        bytes32 node = keccak256(abi.encodePacked(baseNode, bytes32(tokenId)));

        vm.prank(alice);
        reverseRegistrar.setName("alice.contour");
        assertEq(reverseRegistrar.name(alice), "alice.contour");
        assertEq(universalResolver.resolveReverse(alice), "alice.contour");

        vm.prank(alice);
        resolver.setAddr(node, bob);
        assertEq(reverseRegistrar.name(alice), "");

        vm.prank(alice);
        vm.expectRevert(ArcReverseRegistrar.ForwardResolutionMismatch.selector);
        reverseRegistrar.setName("alice.contour");
    }

    function testReregistrationAtomicallyClearsEveryResolverRecordKind() public {
        bytes32 labelHash = keccak256("alice");
        bytes32 node = keccak256(abi.encodePacked(baseNode, labelHash));
        {
            bytes[] memory oldData = _allResolverData(node);
            ArcRegistrarController.RegistrationPermit memory first = _permit(
                "alice", alice, alice, alice, address(0), bytes32("records-old"), 0, oldData
            );
            bytes memory firstSignature = _sign(first);
            vm.prank(alice);
            controller.register("alice", first, oldData, firstSignature);
        }

        assertEq(resolver.recordVersions(node), 1);
        assertEq(resolver.addr(node), alice);
        assertEq(resolver.text(node, "bio"), "old bio");
        assertEq(resolver.name(node), "alice.contour");
        assertEq(keccak256(resolver.contenthash(node)), keccak256(hex"e30101701220aabbccdd"));
        assertEq(resolver.interfaceImplementer(node, _TEST_INTERFACE_ID), attacker);
        vm.prank(alice);
        registry.setTTL(node, type(uint64).max);
        assertEq(uint256(registry.ttl(node)), type(uint64).max);

        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(ArcPublicResolver.Unauthorized.selector, node, attacker)
        );
        resolver.clearRecords(node);

        vm.warp(registrar.nameExpires(uint256(labelHash)) + registrar.gracePeriod() + 1);

        // A failure after the reset point must roll back the version, records, payment and permit.
        uint256 bobBalance = usdc.balanceOf(bob);
        {
            bytes[] memory invalidData = new bytes[](1);
            invalidData[0] = abi.encodeWithSignature("setAddr(bytes32,address)", baseNode, bob);
            ArcRegistrarController.RegistrationPermit memory invalid = _permit(
                "alice", bob, bob, bob, address(0), bytes32("records-invalid"), 0, invalidData
            );
            bytes memory invalidSignature = _sign(invalid);
            vm.prank(bob);
            vm.expectRevert(ArcPublicResolver.NodeMismatch.selector);
            controller.register("alice", invalid, invalidData, invalidSignature);
        }
        assertEq(resolver.recordVersions(node), 1);
        assertEq(resolver.addr(node), alice);
        assertEq(usdc.balanceOf(bob), bobBalance);
        assertFalse(controller.usedPermit(bytes32("records-invalid")));

        {
            bytes[] memory emptyData = new bytes[](0);
            ArcRegistrarController.RegistrationPermit memory replacement =
                _permit("alice", bob, bob, bob, address(0), bytes32("records-new"), 0, emptyData);
            bytes memory replacementSignature = _sign(replacement);
            vm.prank(bob);
            controller.register("alice", replacement, emptyData, replacementSignature);
        }

        assertEq(registrar.ownerOf(uint256(labelHash)), bob);
        assertEq(registry.owner(node), bob);
        assertEq(registry.resolver(node), address(resolver));
        assertEq(uint256(registry.ttl(node)), 0);
        assertEq(resolver.recordVersions(node), 2);
        assertEq(resolver.addr(node), address(0));
        assertEq(resolver.text(node, "bio"), "");
        assertEq(resolver.name(node), "");
        assertEq(resolver.contenthash(node).length, 0);
        assertEq(resolver.interfaceImplementer(node, _TEST_INTERFACE_ID), address(0));
    }

    function testMarketplacePurchasePullPaymentsAndPauseLiveness() public {
        uint256 tokenId = _register("alice", alice, alice, 0);
        uint256 price = 100_000_000;
        vm.startPrank(alice);
        registrar.setApprovalForAll(address(marketplace), true);
        marketplace.list(tokenId, price, uint64(block.timestamp + 30 days));
        vm.stopPrank();

        vm.prank(bob);
        marketplace.buy(tokenId, price, _MARKET_FEE_BPS);

        uint256 fee = price * _MARKET_FEE_BPS / 10_000;
        uint256 sellerProceeds = price - fee;
        assertEq(registrar.ownerOf(tokenId), bob);
        assertEq(marketplace.proceeds(alice), sellerProceeds);
        assertEq(marketplace.totalSellerLiability(), sellerProceeds);
        assertEq(marketplace.surplus(), fee);

        marketplace.setPaused(true);
        usdc.setBlocklisted(alice, true);
        vm.prank(alice);
        vm.expectRevert(SafeERC20.ERC20CallFailed.selector);
        marketplace.claimProceeds();
        assertEq(marketplace.proceeds(alice), sellerProceeds);

        usdc.setBlocklisted(alice, false);
        vm.prank(alice);
        marketplace.claimProceeds();
        assertEq(marketplace.totalSellerLiability(), 0);
        assertEq(usdc.balanceOf(address(marketplace)), fee);
    }

    function testMarketplaceTransferInvalidatesListingAndCancelWorksPaused() public {
        uint256 tokenId = _register("alice", alice, alice, 0);
        vm.startPrank(alice);
        registrar.setApprovalForAll(address(marketplace), true);
        marketplace.list(tokenId, 20_000_000, uint64(block.timestamp + 30 days));
        registrar.transferFrom(alice, bob, tokenId);
        vm.stopPrank();

        ArcNameMarketplace.Listing memory listing = marketplace.listingOf(tokenId);
        assertEq(listing.seller, address(0));
        assertTrue(marketplace.invalidateListing(tokenId));

        vm.startPrank(bob);
        registrar.setApprovalForAll(address(marketplace), true);
        marketplace.list(tokenId, 30_000_000, uint64(block.timestamp + 30 days));
        vm.stopPrank();
        marketplace.setPaused(true);
        vm.prank(bob);
        marketplace.cancel(tokenId);
        listing = marketplace.rawListingOf(tokenId);
        assertEq(listing.seller, address(0));
    }

    function testMarketplaceExpectedPriceAndFeeGuardsPrecedePayment() public {
        uint256 tokenId = _register("alice", alice, alice, 0);
        uint256 price = 50_000_000;
        vm.startPrank(alice);
        registrar.setApprovalForAll(address(marketplace), true);
        marketplace.list(tokenId, price, uint64(block.timestamp + 30 days));
        vm.stopPrank();

        uint256 buyerBalance = usdc.balanceOf(bob);
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(ArcNameMarketplace.PriceChanged.selector, price - 1, price)
        );
        marketplace.buy(tokenId, price - 1, _MARKET_FEE_BPS);
        assertEq(usdc.balanceOf(bob), buyerBalance);

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                ArcNameMarketplace.FeeChanged.selector, _MARKET_FEE_BPS - 1, _MARKET_FEE_BPS
            )
        );
        marketplace.buy(tokenId, price, _MARKET_FEE_BPS - 1);
        assertEq(usdc.balanceOf(bob), buyerBalance);
        assertEq(marketplace.rawListingOf(tokenId).seller, alice);
    }

    function testUniversalResolverRejectsUnboundedInputs() public {
        vm.expectRevert(BoundedNamehash.NameTooLong.selector);
        universalResolver.namehash(new string(256));

        vm.expectRevert(ArcUniversalResolver.TextKeyTooLong.selector);
        universalResolver.resolveText("alice.contour", new string(65));
    }

    function testUnicodeCodePointPriceTiersAndLabelBounds() public view {
        assertEq(controller.quote("a", 1), 5_000_000);
        assertEq(controller.quote("ab", 1), 2_500_000);
        assertEq(controller.quote("abc", 1), 1_000_000);
        assertEq(controller.quote("alice", 1), 500_000);
        assertEq(controller.quote(unicode"é", 1), 5_000_000);
        assertEq(controller.quote(unicode"日本", 1), 2_500_000);
        assertEq(controller.quote(unicode"👩‍💻", 1), 1_000_000);
        assertEq(controller.quote(_asciiLabel(63), 1), 500_000);
    }

    function testRejects64ByteLabel() public {
        vm.expectRevert();
        controller.quote(_asciiLabel(64), 1);
    }

    function testRejectsEnsAlternateDotSeparators() public {
        vm.expectRevert(Utf8.InvalidLabel.selector);
        controller.quote(unicode"alice。contour", 1);
        vm.expectRevert(Utf8.InvalidLabel.selector);
        controller.quote(unicode"alice．contour", 1);
        vm.expectRevert(Utf8.InvalidLabel.selector);
        controller.quote(unicode"alice｡contour", 1);
    }

    function testReferralAndTreasuryRemainSolvent() public {
        _register("alice", alice, alice, 0);
        uint256 referralAmount = _ANNUAL_PRICE * _REFERRAL_BPS / 10_000;
        assertEq(controller.surplus(), _ANNUAL_PRICE - referralAmount);

        controller.withdrawTreasurySurplus(_ANNUAL_PRICE - referralAmount);
        assertEq(usdc.balanceOf(address(controller)), referralAmount);
        assertEq(controller.totalReferralLiability(), referralAmount);

        vm.prank(referrer);
        controller.claimReferral();
        assertEq(usdc.balanceOf(address(controller)), 0);
        assertEq(controller.totalReferralLiability(), 0);
    }

    function _register(string memory label, address recipient, address payer, uint256 nonce)
        private
        returns (uint256 tokenId)
    {
        bytes[] memory data = _resolverData(label, recipient);
        ArcRegistrarController.RegistrationPermit memory permit = _permit(
            label, recipient, payer, payer, referrer, keccak256(bytes(label)), nonce, data
        );
        bytes memory signature = _sign(permit);
        vm.prank(payer);
        (tokenId,) = controller.register(label, permit, data, signature);
    }

    function _permit(
        string memory label,
        address recipient,
        address payer,
        address executor,
        address permitReferrer,
        bytes32 permitId,
        uint256 nonce,
        bytes[] memory data
    ) private view returns (ArcRegistrarController.RegistrationPermit memory permit) {
        bytes32 labelHash = keccak256(bytes(label));
        permit = ArcRegistrarController.RegistrationPermit({
            chainId: block.chainid,
            controller: address(controller),
            releaseId: releaseId,
            normalizationProfileHash: profileHash,
            normalizedLabelHash: labelHash,
            namehash: keccak256(abi.encodePacked(baseNode, labelHash)),
            requester: payer,
            recipient: recipient,
            payer: payer,
            authorizedExecutor: executor,
            durationYears: 1,
            resolverDataHash: keccak256(abi.encode(data)),
            referrer: permitReferrer,
            settlementAsset: address(usdc),
            expectedAmount: controller.quote(label, 1),
            expectedReferralBps: permitReferrer == address(0) ? 0 : _REFERRAL_BPS,
            permitId: permitId,
            nonce: nonce,
            issuedAt: block.timestamp,
            validAfter: block.timestamp,
            validUntil: block.timestamp + 3 minutes
        });
    }

    function _resolverData(string memory label, address resolvedAddress)
        private
        view
        returns (bytes[] memory data)
    {
        bytes32 labelHash = keccak256(bytes(label));
        bytes32 node = keccak256(abi.encodePacked(baseNode, labelHash));
        data = new bytes[](2);
        data[0] = abi.encodeWithSignature("setAddr(bytes32,address)", node, resolvedAddress);
        data[1] = abi.encodeWithSignature(
            "setText(bytes32,string,string)", node, "network", "arc-testnet"
        );
    }

    function _allResolverData(bytes32 node) private view returns (bytes[] memory data) {
        data = new bytes[](5);
        data[0] = abi.encodeWithSignature("setAddr(bytes32,address)", node, alice);
        data[1] = abi.encodeWithSignature("setText(bytes32,string,string)", node, "bio", "old bio");
        data[2] = abi.encodeWithSignature("setName(bytes32,string)", node, "alice.contour");
        data[3] = abi.encodeWithSignature(
            "setContenthash(bytes32,bytes)", node, hex"e30101701220aabbccdd"
        );
        data[4] = abi.encodeWithSignature(
            "setInterface(bytes32,bytes4,address)", node, _TEST_INTERFACE_ID, attacker
        );
    }

    function _sign(ArcRegistrarController.RegistrationPermit memory permit)
        private
        returns (bytes memory)
    {
        return _signWith(_SIGNER_KEY, permit);
    }

    function _signWith(uint256 signerKey, ArcRegistrarController.RegistrationPermit memory permit)
        private
        returns (bytes memory)
    {
        bytes32 digest = controller.hashPermit(permit);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _asciiLabel(uint256 length) private pure returns (string memory value) {
        bytes memory raw = new bytes(length);
        for (uint256 i; i < length; ++i) {
            raw[i] = "a";
        }
        value = string(raw);
    }
}
