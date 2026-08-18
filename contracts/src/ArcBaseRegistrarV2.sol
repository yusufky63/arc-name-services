// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { ArcBaseRegistrar } from "./ArcBaseRegistrar.sol";
import { IArcNameRegistry } from "./interfaces/IArcNameRegistry.sol";

/// @notice Future registrar release with ERC-721 token metadata support.
/// @dev This is a separate deployment target. It does not upgrade or alter an existing V1 registrar.
contract ArcBaseRegistrarV2 is ArcBaseRegistrar {
    error InvalidMetadataBaseURI();

    uint256 public constant MAX_METADATA_BASE_URI_LENGTH = 512;

    string public metadataBaseURI;

    event MetadataBaseURIUpdated(string previousBaseURI, string newBaseURI);

    constructor(
        IArcNameRegistry registry_,
        bytes32 baseNode_,
        address initialOwner,
        string memory initialMetadataBaseURI
    ) ArcBaseRegistrar(registry_, baseNode_, initialOwner) {
        _validateMetadataBaseURI(initialMetadataBaseURI);
        metadataBaseURI = initialMetadataBaseURI;
    }

    /// @notice Reports ERC-165, ERC-721 and ERC-721 Metadata support.
    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == 0x01ffc9a7 // ERC-165
            || interfaceId == 0x80ac58cd // ERC-721
            || interfaceId == 0x5b5e139f; // ERC-721 Metadata
    }

    /// @notice Returns the public JSON metadata endpoint for an existing token.
    function tokenURI(uint256 id) external view returns (string memory) {
        ownerOf(id);
        return string.concat(metadataBaseURI, _toDecimalString(id));
    }

    /// @notice Changes the metadata endpoint used by every token in this collection.
    function setMetadataBaseURI(string calldata newMetadataBaseURI) external onlyOwner {
        _validateMetadataBaseURI(newMetadataBaseURI);
        string memory previousBaseURI = metadataBaseURI;
        metadataBaseURI = newMetadataBaseURI;
        emit MetadataBaseURIUpdated(previousBaseURI, newMetadataBaseURI);
    }

    function _validateMetadataBaseURI(string memory value) private pure {
        bytes memory uri = bytes(value);
        if (
            uri.length < 10 || uri.length > MAX_METADATA_BASE_URI_LENGTH || uri[0] != "h"
                || uri[1] != "t" || uri[2] != "t" || uri[3] != "p" || uri[4] != "s" || uri[5] != ":"
                || uri[6] != "/" || uri[7] != "/" || uri[uri.length - 1] != "/"
        ) {
            revert InvalidMetadataBaseURI();
        }

        uint256 authorityEnd;
        for (uint256 index = 8; index < uri.length;) {
            bytes1 character = uri[index];
            // Require a canonical, percent-encoded ASCII URL. Query and fragment components
            // would make decimal token-ID concatenation ambiguous, so only a path is accepted.
            if (
                character < 0x21 || character > 0x7e || character == 0x5c || character == 0x3f
                    || character == 0x23
            ) {
                revert InvalidMetadataBaseURI();
            }
            if (character == "%" && !_hasValidPercentEncoding(uri, index)) {
                revert InvalidMetadataBaseURI();
            }
            if (authorityEnd == 0 && character == "/") authorityEnd = index;
            unchecked {
                ++index;
            }
        }

        if (!_isValidAuthority(uri, authorityEnd)) revert InvalidMetadataBaseURI();
    }

    function _isValidAuthority(bytes memory uri, uint256 authorityEnd) private pure returns (bool) {
        if (authorityEnd <= 8) return false;

        for (uint256 index = 8; index < authorityEnd;) {
            bytes1 character = uri[index];
            bool alphaNumeric = (character >= "a" && character <= "z")
                || (character >= "A" && character <= "Z") || (character >= "0" && character <= "9");

            if (!alphaNumeric) {
                if (character == "-") {
                    if (
                        index == 8 || index + 1 == authorityEnd || uri[index - 1] == "."
                            || uri[index + 1] == "."
                    ) return false;
                } else if (character == ".") {
                    if (
                        index == 8 || index + 1 == authorityEnd || uri[index - 1] == "."
                            || uri[index + 1] == "." || uri[index - 1] == "-"
                            || uri[index + 1] == "-"
                    ) return false;
                } else {
                    return false;
                }
            }

            unchecked {
                ++index;
            }
        }
        return true;
    }

    function _hasValidPercentEncoding(bytes memory uri, uint256 index) private pure returns (bool) {
        return index + 2 < uri.length && _isHexDigit(uri[index + 1]) && _isHexDigit(uri[index + 2]);
    }

    function _isHexDigit(bytes1 character) private pure returns (bool) {
        return (character >= "0" && character <= "9") || (character >= "a" && character <= "f")
            || (character >= "A" && character <= "F");
    }

    function _toDecimalString(uint256 value) private pure returns (string memory result) {
        if (value == 0) return "0";

        uint256 digits;
        uint256 remaining = value;
        while (remaining != 0) {
            unchecked {
                ++digits;
            }
            remaining /= 10;
        }

        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            unchecked {
                --digits;
                buffer[digits] = bytes1(uint8(48 + (value % 10)));
            }
            value /= 10;
        }
        result = string(buffer);
    }
}
