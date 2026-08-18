// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

library Utf8 {
    error InvalidLabel();
    error LabelTooLong();

    /// @dev Validates canonical UTF-8 and bounds both bytes and code points. This is deliberately
    /// not an ENSIP-15 normalizer; the signed profile hash attests to off-chain normalization.
    function validateLabel(bytes memory value, uint256 maxBytes, uint256 maxCodePoints)
        internal
        pure
        returns (uint256 codePoints)
    {
        uint256 length = value.length;
        if (length == 0) revert InvalidLabel();
        if (length > maxBytes) revert LabelTooLong();

        uint256 i;
        while (i < length) {
            uint8 c = uint8(value[i]);
            uint256 width;

            if (c < 0x80) {
                if (c == 0 || c == 0x2e || c < 0x20 || c == 0x7f) revert InvalidLabel();
                width = 1;
            } else if (c >= 0xc2 && c <= 0xdf) {
                width = 2;
                if (i + width > length || !_continuation(value[i + 1])) revert InvalidLabel();
            } else if (c >= 0xe0 && c <= 0xef) {
                width = 3;
                if (
                    i + width > length || !_continuation(value[i + 1])
                        || !_continuation(value[i + 2])
                ) revert InvalidLabel();
                uint8 second = uint8(value[i + 1]);
                if ((c == 0xe0 && second < 0xa0) || (c == 0xed && second >= 0xa0)) {
                    revert InvalidLabel();
                }
                uint8 third = uint8(value[i + 2]);
                if (
                    (c == 0xe3 && second == 0x80 && third == 0x82)
                        || (c == 0xef && second == 0xbc && third == 0x8e)
                        || (c == 0xef && second == 0xbd && third == 0xa1)
                ) revert InvalidLabel();
            } else if (c >= 0xf0 && c <= 0xf4) {
                width = 4;
                if (
                    i + width > length || !_continuation(value[i + 1])
                        || !_continuation(value[i + 2]) || !_continuation(value[i + 3])
                ) {
                    revert InvalidLabel();
                }
                uint8 second = uint8(value[i + 1]);
                if ((c == 0xf0 && second < 0x90) || (c == 0xf4 && second >= 0x90)) {
                    revert InvalidLabel();
                }
            } else {
                revert InvalidLabel();
            }

            unchecked {
                ++codePoints;
                i += width;
            }
            if (codePoints > maxCodePoints) revert LabelTooLong();
        }
    }

    function _continuation(bytes1 c) private pure returns (bool) {
        uint8 value = uint8(c);
        return value >= 0x80 && value <= 0xbf;
    }
}
