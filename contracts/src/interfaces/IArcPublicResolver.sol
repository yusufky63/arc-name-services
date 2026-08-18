// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IArcPublicResolver {
    function addr(bytes32 node) external view returns (address payable);
    function addr(bytes32 node, uint256 coinType) external view returns (bytes memory);
    function text(bytes32 node, string calldata key) external view returns (string memory);
    function name(bytes32 node) external view returns (string memory);
    function contenthash(bytes32 node) external view returns (bytes memory);

    function setAddr(bytes32 node, address addr_) external;
    function setName(bytes32 node, string calldata name_) external;
    function clearRecords(bytes32 node) external;
    function multicallWithNodeCheck(bytes32 node, bytes[] calldata data)
        external
        returns (bytes[] memory results);
}
