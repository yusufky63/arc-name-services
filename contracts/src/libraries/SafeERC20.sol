// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IERC20 } from "../interfaces/IERC20.sol";

library SafeERC20 {
    error ERC20CallFailed();

    function safeTransfer(IERC20 token, address to, uint256 amount) internal {
        _call(token, abi.encodeCall(IERC20.transfer, (to, amount)));
    }

    function safeTransferFrom(IERC20 token, address from, address to, uint256 amount) internal {
        _call(token, abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
    }

    function _call(IERC20 token, bytes memory data) private {
        (bool success, bytes memory result) = address(token).call(data);
        if (!success || (result.length != 0 && !abi.decode(result, (bool)))) {
            revert ERC20CallFailed();
        }
    }
}

