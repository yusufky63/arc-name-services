// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

library BoundedNamehash {
    error NameTooLong();
    error TooManyLabels();
    error EmptyLabel();

    function namehash(string memory name, uint256 maxBytes, uint256 maxLabels)
        internal
        pure
        returns (bytes32 node)
    {
        bytes memory value = bytes(name);
        uint256 length = value.length;
        if (length == 0) return bytes32(0);
        if (length > maxBytes) revert NameTooLong();

        uint256 labelEnd = length;
        uint256 labels;
        for (uint256 cursor = length; cursor != 0; --cursor) {
            if (value[cursor - 1] == bytes1(".")) {
                uint256 labelStart = cursor;
                if (labelEnd == labelStart) revert EmptyLabel();
                node = _hashLabel(node, value, labelStart, labelEnd - labelStart);
                unchecked {
                    ++labels;
                }
                if (labels > maxLabels) revert TooManyLabels();
                labelEnd = cursor - 1;
            }
        }

        if (labelEnd == 0) revert EmptyLabel();
        node = _hashLabel(node, value, 0, labelEnd);
        unchecked {
            ++labels;
        }
        if (labels > maxLabels) revert TooManyLabels();
    }

    function _hashLabel(bytes32 node, bytes memory value, uint256 start, uint256 length)
        private
        pure
        returns (bytes32)
    {
        bytes32 labelHash;
        assembly ("memory-safe") {
            labelHash := keccak256(add(add(value, 32), start), length)
        }
        return keccak256(abi.encodePacked(node, labelHash));
    }
}

