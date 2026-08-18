import { parseAbi } from "viem";

export const registryAbi = parseAbi([
  "function owner(bytes32 node) view returns (address)",
  "function resolver(bytes32 node) view returns (address)",
  "function ttl(bytes32 node) view returns (uint64)",
  "function recordExists(bytes32 node) view returns (bool)",
  "event Transfer(bytes32 indexed node, address owner)",
  "event NewOwner(bytes32 indexed node, bytes32 indexed label, address owner)",
  "event NewResolver(bytes32 indexed node, address resolver)",
  "event NewTTL(bytes32 indexed node, uint64 ttl)",
]);

export const baseRegistrarAbi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function nameExpires(uint256 tokenId) view returns (uint256)",
  "function available(uint256 tokenId) view returns (bool)",
  "function isActive(uint256 tokenId) view returns (bool)",
  "function inGracePeriod(uint256 tokenId) view returns (bool)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function approve(address approved, uint256 tokenId)",
  "function setApprovalForAll(address operator, bool approved)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)",
  "event ApprovalForAll(address indexed owner, address indexed operator, bool approved)",
  "event NameRegistered(uint256 indexed id, address indexed owner, uint256 expires)",
  "event NameRenewed(uint256 indexed id, uint256 expires)",
]);

export const registrationPermitTuple =
  "(uint256 chainId,address controller,bytes32 releaseId,bytes32 normalizationProfileHash,bytes32 normalizedLabelHash,bytes32 namehash,address requester,address recipient,address payer,address authorizedExecutor,uint256 durationYears,bytes32 resolverDataHash,address referrer,address settlementAsset,uint256 expectedAmount,uint256 expectedReferralBps,bytes32 permitId,uint256 nonce,uint256 issuedAt,uint256 validAfter,uint256 validUntil)" as const;

export const controllerAbi = parseAbi([
  "function quote(string normalizedLabel, uint256 durationYears) pure returns (uint256)",
  `function register(string normalizedLabel, ${registrationPermitTuple} permit, bytes[] resolverData, bytes signature) returns (uint256 tokenId, uint256 expires)`,
  "function renew(string normalizedLabel, uint256 durationYears, uint256 expectedAmount) returns (uint256 expires)",
  "function usedPermit(bytes32 permitId) view returns (bool)",
  "function nonces(address requester) view returns (uint256)",
  "function registrationsPaused() view returns (bool)",
  "function referralBps() view returns (uint16)",
  "function referralCredits(address referrer) view returns (uint256)",
  "function claimReferral() returns (uint256)",
  `function hashPermit(${registrationPermitTuple} permit) view returns (bytes32)`,
  "event NameRegistered(string name, bytes32 indexed label, address indexed owner, uint256 baseCost, uint256 premium, uint256 expires)",
  "event NameRenewed(string name, bytes32 indexed label, uint256 cost, uint256 expires)",
  "event PermitConsumed(bytes32 indexed permitId, address indexed requester, uint256 indexed nonce)",
  "event ReferralAccrued(address indexed referrer, uint256 amount)",
  "event ReferralClaimed(address indexed referrer, uint256 amount)",
]);

export const publicResolverAbi = parseAbi([
  "function supportsInterface(bytes4 interfaceID) view returns (bool)",
  "function addr(bytes32 node) view returns (address)",
  "function addr(bytes32 node, uint256 coinType) view returns (bytes)",
  "function text(bytes32 node, string key) view returns (string)",
  "function name(bytes32 node) view returns (string)",
  "function contenthash(bytes32 node) view returns (bytes)",
  "function setAddr(bytes32 node, address value)",
  "function setText(bytes32 node, string key, string value)",
  "function setName(bytes32 node, string value)",
  "function setContenthash(bytes32 node, bytes value)",
  "event AddrChanged(bytes32 indexed node, address a)",
  "event AddressChanged(bytes32 indexed node, uint256 coinType, bytes newAddress)",
  "event NameChanged(bytes32 indexed node, string name)",
  "event TextChanged(bytes32 indexed node, string indexed indexedKey, string key)",
  "event TextChanged(bytes32 indexed node, string indexed indexedKey, string key, string value)",
  "event ContenthashChanged(bytes32 indexed node, bytes hash)",
]);

export const reverseRegistrarAbi = parseAbi([
  "function claim(address reverseOwner) returns (bytes32)",
  "function setName(string name) returns (bytes32)",
  "function name(address account) view returns (string)",
  "function reverseNodeOf(address account) view returns (bytes32)",
  "function forwardNode(string forwardName) view returns (bytes32)",
  "function sha3HexAddress(address account) pure returns (bytes32)",
]);

export const universalResolverAbi = parseAbi([
  "function namehash(string fullName) pure returns (bytes32)",
  "function resolveAddress(string fullName) view returns (bytes32 node, address resolved)",
  "function resolveText(string fullName, string key) view returns (bytes32 node, string value)",
  "function resolveName(string fullName) view returns (bytes32 node, string value)",
  "function resolveReverse(address account) view returns (string value)",
]);

export const marketplaceAbi = parseAbi([
  "function list(uint256 tokenId, uint256 price, uint64 validUntil)",
  "function cancel(uint256 tokenId)",
  "function invalidateListing(uint256 tokenId) returns (bool invalidated)",
  "function buy(uint256 tokenId, uint256 expectedPrice, uint16 expectedFeeBps)",
  "function claimProceeds() returns (uint256)",
  "function listingOf(uint256 tokenId) view returns (address seller, uint256 price, uint64 validUntil)",
  "function rawListingOf(uint256 tokenId) view returns (address seller, uint256 price, uint64 validUntil)",
  "function proceeds(address seller) view returns (uint256)",
  "function feeBps() view returns (uint16)",
  "function paused() view returns (bool)",
  "event Listed(uint256 indexed tokenId, address indexed seller, uint256 price, uint64 validUntil)",
  "event ListingCancelled(uint256 indexed tokenId, address indexed seller)",
  "event ListingInvalidated(uint256 indexed tokenId, address indexed formerSeller)",
  "event Purchased(uint256 indexed tokenId, address indexed seller, address indexed buyer, uint256 price, uint256 fee)",
  "event ProceedsClaimed(address indexed seller, uint256 amount)",
]);

export const erc20Abi = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
