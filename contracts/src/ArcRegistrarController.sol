// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IERC20 } from "./interfaces/IERC20.sol";
import { IArcBaseRegistrar } from "./interfaces/IArcBaseRegistrar.sol";
import { Ownable2Step } from "./libraries/Ownable2Step.sol";
import { ReentrancyGuard } from "./libraries/ReentrancyGuard.sol";
import { SafeERC20 } from "./libraries/SafeERC20.sol";
import { ECDSA } from "./libraries/ECDSA.sol";
import { Utf8 } from "./libraries/Utf8.sol";

/// @notice Permit-only direct registration controller settled in 6-decimal Arc USDC.
/// @dev This contract intentionally has no commit/reveal path and no native-value sweep path.
contract ArcRegistrarController is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error RegistrationPaused();
    error InvalidConfiguration();
    error InvalidPermitDomain();
    error InvalidRelease();
    error InvalidNormalizationProfile();
    error InvalidLabelHash();
    error InvalidNamehash();
    error InvalidParty();
    error UnauthorizedExecutor();
    error InvalidDurationYears();
    error InvalidResolverData();
    error InvalidSettlementAsset();
    error PriceChanged(uint256 expected, uint256 current);
    error ReferralChanged(uint256 expected, uint256 current);
    error InvalidPermitId();
    error PermitAlreadyUsed();
    error NonceMismatch(uint256 expected, uint256 supplied);
    error PermitNotYetValid();
    error PermitExpired();
    error InvalidPermitWindow();
    error InvalidPermitSigner();
    error SignerActivationNotReady();
    error NameUnavailable();
    error NotRegistrant();
    error IncorrectPaymentDelta(uint256 expected, uint256 received);
    error NoReferralCredit();
    error Insolvent(uint256 balance, uint256 liabilities);
    error InsufficientSurplus();

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant YEAR = 365 days;
    uint256 public constant MIN_DURATION_YEARS = 1;
    uint256 public constant MAX_DURATION_YEARS = 10;
    uint256 public constant MAX_LABEL_BYTES = 63;
    uint256 public constant MAX_LABEL_CODEPOINTS = 63;
    uint256 public constant MAX_REFERRAL_BPS = 3_000;
    uint256 public constant MAX_PERMIT_VALIDITY = 300;
    uint256 public constant MAX_PERMIT_CLOCK_SKEW = 5;
    uint256 public constant SIGNER_ACTIVATION_DELAY = 24 hours;
    uint256 public constant PRICE_ONE_CODEPOINT = 5_000_000;
    uint256 public constant PRICE_TWO_CODEPOINTS = 2_500_000;
    uint256 public constant PRICE_THREE_CODEPOINTS = 1_000_000;
    uint256 public constant PRICE_FOUR_PLUS_CODEPOINTS = 500_000;

    bytes32 public constant REGISTRATION_PERMIT_TYPEHASH = keccak256(
        "RegistrationPermit(uint256 chainId,address controller,bytes32 releaseId,bytes32 normalizationProfileHash,bytes32 normalizedLabelHash,bytes32 namehash,address requester,address recipient,address payer,address authorizedExecutor,uint256 durationYears,bytes32 resolverDataHash,address referrer,address settlementAsset,uint256 expectedAmount,uint256 expectedReferralBps,bytes32 permitId,uint256 nonce,uint256 issuedAt,uint256 validAfter,uint256 validUntil)"
    );
    bytes32 private constant _DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant _NAME_HASH = keccak256("Arc Registrar Controller");
    bytes32 private constant _VERSION_HASH = keccak256("1");

    struct RegistrationPermit {
        uint256 chainId;
        address controller;
        bytes32 releaseId;
        bytes32 normalizationProfileHash;
        bytes32 normalizedLabelHash;
        bytes32 namehash;
        address requester;
        address recipient;
        address payer;
        address authorizedExecutor;
        uint256 durationYears;
        bytes32 resolverDataHash;
        address referrer;
        address settlementAsset;
        uint256 expectedAmount;
        uint256 expectedReferralBps;
        bytes32 permitId;
        uint256 nonce;
        uint256 issuedAt;
        uint256 validAfter;
        uint256 validUntil;
    }

    IArcBaseRegistrar public immutable registrar;
    IERC20 public immutable settlementAsset;
    address public immutable publicResolver;
    bytes32 public immutable baseNode;
    bytes32 public immutable releaseId;
    bytes32 public immutable normalizationProfileHash;

    address public permitSigner;
    address public pendingPermitSigner;
    uint64 public pendingPermitSignerValidAfter;
    uint64 public signerPolicyVersion = 1;
    address public treasury;
    uint16 public referralBps;
    bool public registrationsPaused;

    mapping(bytes32 permitId => bool used) public usedPermit;
    mapping(address requester => uint256 nextNonce) public nonces;
    mapping(address referrer => uint256 amount) public referralCredits;
    uint256 public totalReferralLiability;

    event NameRegistered(
        string name,
        bytes32 indexed label,
        address indexed owner,
        uint256 baseCost,
        uint256 premium,
        uint256 expires
    );
    event NameRenewed(string name, bytes32 indexed label, uint256 cost, uint256 expires);
    event PermitConsumed(
        bytes32 indexed permitId, address indexed requester, uint256 indexed nonce
    );
    event ReferralAccrued(address indexed referrer, uint256 amount);
    event ReferralClaimed(address indexed referrer, uint256 amount);
    event TreasuryWithdrawal(address indexed treasury, uint256 amount);
    event PermitSignerProposed(
        address indexed currentSigner,
        address indexed pendingSigner,
        uint64 validAfter,
        uint64 policyVersion
    );
    event PermitSignerChanged(
        address indexed oldSigner, address indexed newSigner, uint64 policyVersion
    );
    event PermitSignerRevoked(address indexed oldSigner, uint64 policyVersion);
    event TreasuryChanged(address indexed oldTreasury, address indexed newTreasury);
    event ReferralBpsChanged(uint16 oldReferralBps, uint16 newReferralBps);
    event RegistrationPauseChanged(bool paused);

    constructor(
        IArcBaseRegistrar registrar_,
        IERC20 settlementAsset_,
        address publicResolver_,
        address initialOwner,
        address permitSigner_,
        address treasury_,
        bytes32 releaseId_,
        bytes32 normalizationProfileHash_,
        uint16 referralBps_
    ) Ownable2Step(initialOwner) {
        if (
            address(registrar_) == address(0) || address(settlementAsset_) == address(0)
                || publicResolver_ == address(0) || permitSigner_ == address(0)
                || treasury_ == address(0) || releaseId_ == bytes32(0)
                || normalizationProfileHash_ == bytes32(0) || referralBps_ > MAX_REFERRAL_BPS
        ) revert InvalidConfiguration();

        registrar = registrar_;
        settlementAsset = settlementAsset_;
        publicResolver = publicResolver_;
        baseNode = registrar_.baseNode();
        releaseId = releaseId_;
        normalizationProfileHash = normalizationProfileHash_;
        permitSigner = permitSigner_;
        treasury = treasury_;
        referralBps = referralBps_;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this))
        );
    }

    function hashPermit(RegistrationPermit calldata permit) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(REGISTRATION_PERMIT_TYPEHASH, permit));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function quote(string calldata normalizedLabel, uint256 durationYears)
        public
        pure
        returns (uint256 amount)
    {
        uint256 codePoints =
            Utf8.validateLabel(bytes(normalizedLabel), MAX_LABEL_BYTES, MAX_LABEL_CODEPOINTS);
        return _quote(codePoints, durationYears);
    }

    function _quote(uint256 codePoints, uint256 durationYears)
        private
        pure
        returns (uint256 amount)
    {
        if (durationYears < MIN_DURATION_YEARS || durationYears > MAX_DURATION_YEARS) {
            revert InvalidDurationYears();
        }
        uint256 annualPrice = codePoints == 1
            ? PRICE_ONE_CODEPOINT
            : codePoints == 2
                ? PRICE_TWO_CODEPOINTS
                : codePoints == 3 ? PRICE_THREE_CODEPOINTS : PRICE_FOUR_PLUS_CODEPOINTS;
        amount = annualPrice * durationYears;
    }

    function register(
        string calldata normalizedLabel,
        RegistrationPermit calldata permit,
        bytes[] calldata resolverData,
        bytes calldata signature
    ) external nonReentrant returns (uint256 tokenId, uint256 expires) {
        if (registrationsPaused) revert RegistrationPaused();

        bytes32 labelHash = _validateRegistration(normalizedLabel, permit, resolverData, signature);
        tokenId = uint256(labelHash);

        // Mutations precede external calls, but any downstream revert restores permit and nonce.
        usedPermit[permit.permitId] = true;
        nonces[permit.requester] = permit.nonce + 1;
        emit PermitConsumed(permit.permitId, permit.requester, permit.nonce);

        _collectExact(permit.payer, permit.expectedAmount);

        uint256 referralAmount;
        if (permit.referrer != address(0)) {
            referralAmount = permit.expectedAmount * permit.expectedReferralBps / BPS_DENOMINATOR;
            referralCredits[permit.referrer] += referralAmount;
            totalReferralLiability += referralAmount;
            emit ReferralAccrued(permit.referrer, referralAmount);
        }
        _requireSolvent();

        expires = registrar.register(
            tokenId, permit.recipient, permit.durationYears * YEAR, publicResolver, resolverData
        );

        emit NameRegistered(
            normalizedLabel, labelHash, permit.recipient, permit.expectedAmount, 0, expires
        );
    }

    /// @notice Renewal remains available when new registrations are paused.
    function renew(string calldata normalizedLabel, uint256 durationYears, uint256 expectedAmount)
        external
        nonReentrant
        returns (uint256 expires)
    {
        bytes memory labelBytes = bytes(normalizedLabel);
        uint256 codePoints = Utf8.validateLabel(labelBytes, MAX_LABEL_BYTES, MAX_LABEL_CODEPOINTS);
        uint256 currentPrice = _quote(codePoints, durationYears);
        if (expectedAmount != currentPrice) revert PriceChanged(expectedAmount, currentPrice);

        bytes32 labelHash = keccak256(labelBytes);
        if (registrar.ownerOf(uint256(labelHash)) != msg.sender) revert NotRegistrant();
        _collectExact(msg.sender, currentPrice);
        expires = registrar.renew(uint256(labelHash), durationYears * YEAR);
        _requireSolvent();
        emit NameRenewed(normalizedLabel, labelHash, currentPrice, expires);
    }

    function claimReferral() external nonReentrant returns (uint256 amount) {
        amount = referralCredits[msg.sender];
        if (amount == 0) revert NoReferralCredit();

        referralCredits[msg.sender] = 0;
        totalReferralLiability -= amount;
        _payExact(msg.sender, amount);
        _requireSolvent();
        emit ReferralClaimed(msg.sender, amount);
    }

    function surplus() public view returns (uint256) {
        uint256 balance = settlementAsset.balanceOf(address(this));
        if (balance < totalReferralLiability) {
            revert Insolvent(balance, totalReferralLiability);
        }
        return balance - totalReferralLiability;
    }

    function withdrawTreasurySurplus(uint256 amount) external onlyOwner nonReentrant {
        if (amount > surplus()) revert InsufficientSurplus();
        _payExact(treasury, amount);
        _requireSolvent();
        emit TreasuryWithdrawal(treasury, amount);
    }

    function proposePermitSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert InvalidConfiguration();
        uint256 activationTime = block.timestamp + SIGNER_ACTIVATION_DELAY;
        if (activationTime > type(uint64).max) revert InvalidConfiguration();
        pendingPermitSigner = newSigner;
        pendingPermitSignerValidAfter = uint64(activationTime);
        ++signerPolicyVersion;
        emit PermitSignerProposed(
            permitSigner, newSigner, pendingPermitSignerValidAfter, signerPolicyVersion
        );
    }

    function activatePermitSigner() external {
        address newSigner = pendingPermitSigner;
        if (newSigner == address(0) || block.timestamp < pendingPermitSignerValidAfter) {
            revert SignerActivationNotReady();
        }
        address oldSigner = permitSigner;
        permitSigner = newSigner;
        pendingPermitSigner = address(0);
        pendingPermitSignerValidAfter = 0;
        emit PermitSignerChanged(oldSigner, newSigner, signerPolicyVersion);
    }

    function revokePermitSigner() external onlyOwner {
        address oldSigner = permitSigner;
        permitSigner = address(0);
        pendingPermitSigner = address(0);
        pendingPermitSignerValidAfter = 0;
        ++signerPolicyVersion;
        emit PermitSignerRevoked(oldSigner, signerPolicyVersion);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert InvalidConfiguration();
        address oldTreasury = treasury;
        treasury = newTreasury;
        emit TreasuryChanged(oldTreasury, newTreasury);
    }

    function setReferralBps(uint16 newReferralBps) external onlyOwner {
        if (newReferralBps > MAX_REFERRAL_BPS) revert InvalidConfiguration();
        uint16 oldReferralBps = referralBps;
        referralBps = newReferralBps;
        emit ReferralBpsChanged(oldReferralBps, newReferralBps);
    }

    function setRegistrationsPaused(bool paused) external onlyOwner {
        registrationsPaused = paused;
        emit RegistrationPauseChanged(paused);
    }

    function _validateRegistration(
        string calldata normalizedLabel,
        RegistrationPermit calldata permit,
        bytes[] calldata resolverData,
        bytes calldata signature
    ) private view returns (bytes32 labelHash) {
        if (permit.chainId != block.chainid || permit.controller != address(this)) {
            revert InvalidPermitDomain();
        }
        if (permit.releaseId != releaseId) revert InvalidRelease();
        if (permit.normalizationProfileHash != normalizationProfileHash) {
            revert InvalidNormalizationProfile();
        }
        if (
            permit.requester == address(0) || permit.recipient == address(0)
                || permit.payer == address(0) || permit.authorizedExecutor == address(0)
        ) revert InvalidParty();
        if (permit.requester != permit.payer || permit.requester != permit.authorizedExecutor) {
            revert InvalidParty();
        }
        if (
            permit.referrer != address(0)
                && (permit.referrer == permit.payer || permit.referrer == permit.recipient)
        ) revert InvalidParty();
        if (msg.sender != permit.authorizedExecutor) revert UnauthorizedExecutor();

        bytes memory labelBytes = bytes(normalizedLabel);
        uint256 codePoints = Utf8.validateLabel(labelBytes, MAX_LABEL_BYTES, MAX_LABEL_CODEPOINTS);
        labelHash = keccak256(labelBytes);
        if (permit.normalizedLabelHash != labelHash) revert InvalidLabelHash();
        if (permit.namehash != keccak256(abi.encodePacked(baseNode, labelHash))) {
            revert InvalidNamehash();
        }
        if (permit.durationYears < MIN_DURATION_YEARS || permit.durationYears > MAX_DURATION_YEARS)
        {
            revert InvalidDurationYears();
        }
        if (permit.resolverDataHash != keccak256(abi.encode(resolverData))) {
            revert InvalidResolverData();
        }
        if (permit.settlementAsset != address(settlementAsset)) revert InvalidSettlementAsset();

        uint256 currentPrice = _quote(codePoints, permit.durationYears);
        if (permit.expectedAmount != currentPrice) {
            revert PriceChanged(permit.expectedAmount, currentPrice);
        }
        uint256 currentReferralBps = permit.referrer == address(0) ? 0 : referralBps;
        if (permit.expectedReferralBps != currentReferralBps) {
            revert ReferralChanged(permit.expectedReferralBps, currentReferralBps);
        }

        if (permit.permitId == bytes32(0)) revert InvalidPermitId();
        if (usedPermit[permit.permitId]) revert PermitAlreadyUsed();
        uint256 expectedNonce = nonces[permit.requester];
        if (permit.nonce != expectedNonce) revert NonceMismatch(expectedNonce, permit.nonce);
        if (
            permit.validAfter > permit.issuedAt || permit.issuedAt > permit.validUntil
                || permit.issuedAt - permit.validAfter > MAX_PERMIT_CLOCK_SKEW
                || permit.validUntil - permit.validAfter > MAX_PERMIT_VALIDITY
        ) revert InvalidPermitWindow();
        if (block.timestamp < permit.validAfter) revert PermitNotYetValid();
        if (block.timestamp > permit.validUntil) revert PermitExpired();
        if (ECDSA.recover(hashPermit(permit), signature) != permitSigner) {
            revert InvalidPermitSigner();
        }
        if (!registrar.available(uint256(labelHash))) revert NameUnavailable();
    }

    function _collectExact(address payer, uint256 amount) private {
        uint256 beforeBalance = settlementAsset.balanceOf(address(this));
        settlementAsset.safeTransferFrom(payer, address(this), amount);
        uint256 afterBalance = settlementAsset.balanceOf(address(this));
        if (afterBalance < beforeBalance || afterBalance - beforeBalance != amount) {
            uint256 received = afterBalance > beforeBalance ? afterBalance - beforeBalance : 0;
            revert IncorrectPaymentDelta(amount, received);
        }
    }

    function _payExact(address recipient, uint256 amount) private {
        uint256 beforeBalance = settlementAsset.balanceOf(address(this));
        settlementAsset.safeTransfer(recipient, amount);
        uint256 afterBalance = settlementAsset.balanceOf(address(this));
        if (beforeBalance < afterBalance || beforeBalance - afterBalance != amount) {
            uint256 spent = beforeBalance > afterBalance ? beforeBalance - afterBalance : 0;
            revert IncorrectPaymentDelta(amount, spent);
        }
    }

    function _requireSolvent() private view {
        uint256 balance = settlementAsset.balanceOf(address(this));
        if (balance < totalReferralLiability) {
            revert Insolvent(balance, totalReferralLiability);
        }
    }
}
