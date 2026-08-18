// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { TestBase } from "./TestBase.sol";
import { DeployArcNameService } from "../script/DeployArcNameService.s.sol";
import { MockUSDC } from "./mocks/MockUSDC.sol";

contract DeployArcNameServiceTest is TestBase, DeployArcNameService {
    uint256 private constant _ARC_TESTNET_CHAIN_ID = 5_042_002;
    address private constant _USDC = 0x3600000000000000000000000000000000000000;
    bytes32 private constant _BASE_NODE =
        0xb0622ac8c513b1e04f26418271b595fae314dbed2e3dea63916fc45cde7c5bbe;
    bytes32 private constant _REVERSE_NODE =
        0x91d1777781884d03a6757a803996e38de2a42967fb37eeaca72729271025a9e2;
    bytes32 private constant _REVERSE_ROOT =
        0xa097f6721ce401e757d1223a763fef49b8b5f90bb18567ddb86fd205dff71d34;

    address private governance = address(0xD3E10);
    address private permitSigner = address(0xD3E10);
    bytes32 private releaseId = keccak256("contour-release-1");

    function setUp() public {
        vm.chainId(_ARC_TESTNET_CHAIN_ID);
        MockUSDC settlementAsset = new MockUSDC();
        vm.etch(_USDC, address(settlementAsset).code);
    }

    function testRunDeploysAndLocksExactlySevenContracts() public {
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

        assertEq(address(deployed.controller.registrar()), address(deployed.baseRegistrar));
        assertEq(address(deployed.controller.settlementAsset()), _USDC);
        assertEq(deployed.controller.publicResolver(), address(deployed.publicResolver));
        assertEq(deployed.controller.baseNode(), _BASE_NODE);
        assertEq(deployed.controller.releaseId(), releaseId);
        assertEq(deployed.controller.permitSigner(), permitSigner);
        assertEq(deployed.controller.treasury(), governance);
        assertEq(uint256(deployed.controller.referralBps()), 500);
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
        assertEq(uint256(deployed.marketplace.feeBps()), 250);
        assertTrue(deployed.marketplace.paused());

        assertEq(deployed.baseRegistrar.owner(), governance);
        assertEq(deployed.controller.owner(), governance);
        assertEq(deployed.marketplace.owner(), governance);
        assertEq(deployed.baseRegistrar.pendingOwner(), address(0));
        assertEq(deployed.controller.pendingOwner(), address(0));
        assertEq(deployed.marketplace.pendingOwner(), address(0));
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

    function testGovernanceRejectsContractAuthority() public {
        MockUSDC contractAuthority = new MockUSDC();
        vm.expectRevert(InvalidGovernanceEoa.selector);
        this.assertGovernanceForTest(
            address(contractAuthority),
            address(contractAuthority),
            address(contractAuthority),
            permitSigner
        );
    }

    function testGovernanceAllowsOneEoaForEveryConfiguredRole() public view {
        this.assertGovernanceForTest(governance, governance, governance, governance);
    }

    function testGovernanceRejectsSeparatePermitSignerEoa() public {
        vm.expectRevert(InvalidPermitSigner.selector);
        this.assertGovernanceForTest(governance, governance, governance, address(0x51A9));
    }

    function testGovernanceRejectsContractPermitSigner() public {
        MockUSDC contractSigner = new MockUSDC();
        vm.expectRevert(InvalidPermitSigner.selector);
        this.assertGovernanceForTest(governance, governance, governance, address(contractSigner));
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
        return _runWithConfig(_deploymentConfig(governance));
    }

    function runWithTreasuryForTest(address treasury_) external returns (Deployment memory) {
        return _runWithConfig(_deploymentConfig(treasury_));
    }

    function _deploymentConfig(address treasury_)
        private
        view
        returns (DeploymentConfig memory config)
    {
        config = DeploymentConfig({
            deployer: governance,
            owner: governance,
            treasury: treasury_,
            permitSigner: permitSigner,
            releaseId: releaseId,
            referralBps: 500,
            marketplaceFeeBps: 250
        });
    }
}
