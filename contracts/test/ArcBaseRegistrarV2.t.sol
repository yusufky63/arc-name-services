// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { TestBase } from "./TestBase.sol";
import { ArcNameRegistry } from "../src/ArcNameRegistry.sol";
import { ArcBaseRegistrar } from "../src/ArcBaseRegistrar.sol";
import { ArcBaseRegistrarV2 } from "../src/ArcBaseRegistrarV2.sol";
import { Ownable2Step } from "../src/libraries/Ownable2Step.sol";

interface VmEventAssertions {
    function expectEmit(
        bool checkTopic1,
        bool checkTopic2,
        bool checkTopic3,
        bool checkData,
        address emitter
    ) external;
}

interface VmArtifactAssertions {
    function getDeployedCode(string calldata artifactPath)
        external
        view
        returns (bytes memory runtimeBytecode);
}

contract ArcBaseRegistrarV2Test is TestBase {
    string private constant _METADATA_BASE_URI =
        "https://contour-arc.vercel.app/api/metadata/";
    bytes32 private constant _V1_RUNTIME_HASH =
        0xcfd71a52e25e0f786933d9891d364e3f1fb71f7e2d6956f270c53e735f458430;
    uint256 private constant _TOKEN_ID =
        32540854028373530199979267381508191878139842538060205354946260187502743967163;

    VmEventAssertions private constant _VM_EVENTS =
        VmEventAssertions(address(uint160(uint256(keccak256("hevm cheat code")))));
    VmArtifactAssertions private constant _VM_ARTIFACTS =
        VmArtifactAssertions(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private alice = address(0xA11CE);
    address private attacker = address(0xBAD);

    ArcNameRegistry private registry;
    ArcBaseRegistrarV2 private registrar;
    bytes32 private baseNode;

    event MetadataBaseURIUpdated(string previousBaseURI, string newBaseURI);

    function setUp() public {
        registry = new ArcNameRegistry(address(this));
        bytes32 suffixLabelHash = keccak256("contour");
        baseNode = keccak256(abi.encodePacked(bytes32(0), suffixLabelHash));
        registrar = new ArcBaseRegistrarV2(registry, baseNode, address(this), _METADATA_BASE_URI);

        registry.setSubnodeOwner(bytes32(0), suffixLabelHash, address(registrar));
        registrar.setController(address(this), true);
    }

    function testSupportsERC721MetadataAndReturnsTokenURI() public {
        registrar.register(_TOKEN_ID, alice, 365 days, address(0), new bytes[](0));

        assertTrue(registrar.supportsInterface(0x01ffc9a7));
        assertTrue(registrar.supportsInterface(0x80ac58cd));
        assertTrue(registrar.supportsInterface(0x5b5e139f));
        assertFalse(registrar.supportsInterface(0x49064906));
        assertEq(registrar.name(), "Arc Testnet Names");
        assertEq(registrar.symbol(), "ARCN");
        assertEq(
            registrar.tokenURI(_TOKEN_ID),
            string.concat(
                _METADATA_BASE_URI,
                "32540854028373530199979267381508191878139842538060205354946260187502743967163"
            )
        );
    }

    function testV1RuntimeBytecodeRemainsCanonical() public view {
        bytes memory runtimeCode =
            _VM_ARTIFACTS.getDeployedCode("ArcBaseRegistrar.sol:ArcBaseRegistrar");
        assertEq(keccak256(runtimeCode), _V1_RUNTIME_HASH);
    }

    function testTokenURIRequiresAnExistingToken() public {
        vm.expectRevert(ArcBaseRegistrar.TokenDoesNotExist.selector);
        registrar.tokenURI(_TOKEN_ID);
    }

    function testOwnerCanUpdateMetadataBaseURI() public {
        string memory newBaseURI = "https://metadata.contour.network/nft/v2/";

        _VM_EVENTS.expectEmit(false, false, false, true, address(registrar));
        emit MetadataBaseURIUpdated(_METADATA_BASE_URI, newBaseURI);
        registrar.setMetadataBaseURI(newBaseURI);

        assertEq(registrar.metadataBaseURI(), newBaseURI);
    }

    function testNonOwnerCannotUpdateMetadataBaseURI() public {
        vm.prank(attacker);
        vm.expectRevert(Ownable2Step.NotOwner.selector);
        registrar.setMetadataBaseURI("https://metadata.contour.network/nft/");
    }

    function testRejectsInvalidMetadataBaseURIAtDeployment() public {
        vm.expectRevert(ArcBaseRegistrarV2.InvalidMetadataBaseURI.selector);
        new ArcBaseRegistrarV2(registry, baseNode, address(this), "http://contour.network/");

        vm.expectRevert(ArcBaseRegistrarV2.InvalidMetadataBaseURI.selector);
        new ArcBaseRegistrarV2(registry, baseNode, address(this), "https://contour.network");

        vm.expectRevert(ArcBaseRegistrarV2.InvalidMetadataBaseURI.selector);
        new ArcBaseRegistrarV2(registry, baseNode, address(this), "https:///");
    }

    function testRejectsInvalidMetadataBaseURIUpdate() public {
        vm.expectRevert(ArcBaseRegistrarV2.InvalidMetadataBaseURI.selector);
        registrar.setMetadataBaseURI("ipfs://bafy/");

        vm.expectRevert(ArcBaseRegistrarV2.InvalidMetadataBaseURI.selector);
        registrar.setMetadataBaseURI("https://contour.network/metadata");
    }

    function testRejectsInvalidAuthority() public {
        _expectInvalidMetadataBaseURI("https:///");
        _expectInvalidMetadataBaseURI("https://bad_host/metadata/");
        _expectInvalidMetadataBaseURI("https://user@contour.network/metadata/");
        _expectInvalidMetadataBaseURI("https://-contour.network/metadata/");
        _expectInvalidMetadataBaseURI("https://contour-.network/metadata/");
        _expectInvalidMetadataBaseURI("https://contour..network/metadata/");
    }

    function testRejectsWhitespaceControlBackslashQueryAndFragment() public {
        _expectInvalidMetadataBaseURI("https://contour.network/meta data/");
        _expectInvalidMetadataBaseURI(
            string.concat("https://contour.network/meta", string(hex"1f"), "data/")
        );
        _expectInvalidMetadataBaseURI("https://contour.network/meta\\data/");
        _expectInvalidMetadataBaseURI("https://contour.network/metadata?version=2/");
        _expectInvalidMetadataBaseURI("https://contour.network/metadata#version-2/");
    }

    function testRejectsMalformedPercentEncodingAndAcceptsEncodedPath() public {
        _expectInvalidMetadataBaseURI("https://contour.network/meta%/data/");
        _expectInvalidMetadataBaseURI("https://contour.network/meta%2/data/");
        _expectInvalidMetadataBaseURI("https://contour.network/meta%zz/data/");

        registrar.setMetadataBaseURI("https://contour.network/meta%20data/");
        assertEq(registrar.metadataBaseURI(), "https://contour.network/meta%20data/");
    }

    function testMetadataBaseURIHonorsLengthBound() public {
        string memory maximumLengthURI = _metadataBaseURIWithLength(512);
        registrar.setMetadataBaseURI(maximumLengthURI);
        assertEq(bytes(registrar.metadataBaseURI()).length, 512);

        vm.expectRevert(ArcBaseRegistrarV2.InvalidMetadataBaseURI.selector);
        registrar.setMetadataBaseURI(_metadataBaseURIWithLength(513));
    }

    function testTokenURIHandlesZeroAndUint256Max() public {
        registrar.register(0, alice, 365 days, address(0), new bytes[](0));
        registrar.register(type(uint256).max, alice, 365 days, address(0), new bytes[](0));

        assertEq(registrar.tokenURI(0), string.concat(_METADATA_BASE_URI, "0"));
        assertEq(
            registrar.tokenURI(type(uint256).max),
            string.concat(
                _METADATA_BASE_URI,
                "115792089237316195423570985008687907853269984665640564039457584007913129639935"
            )
        );
    }

    function _expectInvalidMetadataBaseURI(string memory value) private {
        vm.expectRevert(ArcBaseRegistrarV2.InvalidMetadataBaseURI.selector);
        registrar.setMetadataBaseURI(value);
    }

    function _metadataBaseURIWithLength(uint256 length) private pure returns (string memory) {
        bytes memory value = new bytes(length);
        bytes memory prefix = bytes("https://");
        for (uint256 index; index < prefix.length;) {
            value[index] = prefix[index];
            unchecked {
                ++index;
            }
        }
        for (uint256 index = prefix.length; index < length - 1;) {
            value[index] = "a";
            unchecked {
                ++index;
            }
        }
        value[length - 1] = "/";
        return string(value);
    }
}
