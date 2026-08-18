// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IERC20 } from "./interfaces/IERC20.sol";
import { IArcBaseRegistrar } from "./interfaces/IArcBaseRegistrar.sol";
import { Ownable2Step } from "./libraries/Ownable2Step.sol";
import { ReentrancyGuard } from "./libraries/ReentrancyGuard.sol";
import { SafeERC20 } from "./libraries/SafeERC20.sol";

/// @notice Fixed-price, non-custodial marketplace with pull-payment seller proceeds.
contract ArcNameMarketplace is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error MarketPaused();
    error InvalidConfiguration();
    error InvalidListing();
    error NotTokenOwner();
    error NameNotActive();
    error MarketplaceNotApproved();
    error ListingExpired();
    error StaleListing();
    error PriceChanged(uint256 expected, uint256 current);
    error FeeChanged(uint16 expected, uint16 current);
    error SellerCannotBuy();
    error UnauthorizedCancellation();
    error NoProceeds();
    error IncorrectPaymentDelta(uint256 expected, uint256 received);
    error Insolvent(uint256 balance, uint256 liabilities);
    error InsufficientSurplus();

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint16 public constant MAX_FEE_BPS = 1_000;

    struct Listing {
        address seller;
        uint256 price;
        uint64 validUntil;
    }

    IArcBaseRegistrar public immutable registrar;
    IERC20 public immutable settlementAsset;
    address public treasury;
    uint16 public feeBps;
    bool public paused;

    mapping(uint256 tokenId => Listing listing) private _listings;
    mapping(address seller => uint256 amount) public proceeds;
    uint256 public totalSellerLiability;

    event Listed(uint256 indexed tokenId, address indexed seller, uint256 price, uint64 validUntil);
    event ListingCancelled(uint256 indexed tokenId, address indexed seller);
    event ListingInvalidated(uint256 indexed tokenId, address indexed formerSeller);
    event Purchased(
        uint256 indexed tokenId,
        address indexed seller,
        address indexed buyer,
        uint256 price,
        uint256 fee
    );
    event ProceedsClaimed(address indexed seller, uint256 amount);
    event FeeWithdrawal(address indexed treasury, uint256 amount);
    event FeeChangedEvent(uint16 oldFeeBps, uint16 newFeeBps);
    event TreasuryChanged(address indexed oldTreasury, address indexed newTreasury);
    event PauseChanged(bool paused);

    constructor(
        IArcBaseRegistrar registrar_,
        IERC20 settlementAsset_,
        address initialOwner,
        address treasury_,
        uint16 feeBps_
    ) Ownable2Step(initialOwner) {
        if (
            address(registrar_) == address(0) || address(settlementAsset_) == address(0)
                || treasury_ == address(0) || feeBps_ > MAX_FEE_BPS
        ) revert InvalidConfiguration();
        registrar = registrar_;
        settlementAsset = settlementAsset_;
        treasury = treasury_;
        feeBps = feeBps_;
    }

    modifier whenNotPaused() {
        if (paused) revert MarketPaused();
        _;
    }

    function list(uint256 tokenId, uint256 price, uint64 validUntil) external whenNotPaused {
        if (price == 0 || validUntil <= block.timestamp) revert InvalidListing();
        if (!registrar.isActive(tokenId)) revert NameNotActive();
        if (registrar.ownerOf(tokenId) != msg.sender) revert NotTokenOwner();
        if (uint256(validUntil) > registrar.nameExpires(tokenId)) revert ListingExpired();
        if (!_isApproved(msg.sender, tokenId)) revert MarketplaceNotApproved();

        _listings[tokenId] = Listing({ seller: msg.sender, price: price, validUntil: validUntil });
        emit Listed(tokenId, msg.sender, price, validUntil);
    }

    /// @notice Returns an empty listing when ownership, approval, lifecycle or deadline is stale.
    function listingOf(uint256 tokenId) external view returns (Listing memory listing) {
        listing = _listings[tokenId];
        if (!_isLive(tokenId, listing)) return Listing(address(0), 0, 0);
    }

    function rawListingOf(uint256 tokenId) external view returns (Listing memory) {
        return _listings[tokenId];
    }

    /// @notice Permissionlessly removes a stale listing after an NFT transfer/approval/expiry.
    function invalidateListing(uint256 tokenId) external returns (bool invalidated) {
        Listing memory listing = _listings[tokenId];
        if (listing.seller == address(0) || _isLive(tokenId, listing)) return false;
        delete _listings[tokenId];
        emit ListingInvalidated(tokenId, listing.seller);
        return true;
    }

    /// @notice Cancellation stays open while the market is paused.
    function cancel(uint256 tokenId) external {
        Listing memory listing = _listings[tokenId];
        if (listing.seller == address(0)) revert InvalidListing();
        if (msg.sender != listing.seller && _isLive(tokenId, listing)) {
            revert UnauthorizedCancellation();
        }
        delete _listings[tokenId];
        emit ListingCancelled(tokenId, listing.seller);
    }

    function buy(uint256 tokenId, uint256 expectedPrice, uint16 expectedFeeBps)
        external
        nonReentrant
        whenNotPaused
    {
        Listing memory listing = _listings[tokenId];
        if (listing.seller == address(0)) revert InvalidListing();
        if (block.timestamp > listing.validUntil) revert ListingExpired();
        if (!_isLive(tokenId, listing)) revert StaleListing();
        if (msg.sender == listing.seller) revert SellerCannotBuy();
        if (expectedPrice != listing.price) revert PriceChanged(expectedPrice, listing.price);
        if (expectedFeeBps != feeBps) revert FeeChanged(expectedFeeBps, feeBps);

        // Effects are rolled back if payment or NFT transfer fails.
        delete _listings[tokenId];
        _collectExact(msg.sender, listing.price);

        uint256 fee = listing.price * feeBps / BPS_DENOMINATOR;
        uint256 sellerProceeds = listing.price - fee;
        proceeds[listing.seller] += sellerProceeds;
        totalSellerLiability += sellerProceeds;

        registrar.safeTransferFrom(listing.seller, msg.sender, tokenId);
        _requireSolvent();
        emit Purchased(tokenId, listing.seller, msg.sender, listing.price, fee);
    }

    /// @notice Proceeds claims stay open while the market is paused.
    function claimProceeds() external nonReentrant returns (uint256 amount) {
        amount = proceeds[msg.sender];
        if (amount == 0) revert NoProceeds();
        proceeds[msg.sender] = 0;
        totalSellerLiability -= amount;
        _payExact(msg.sender, amount);
        _requireSolvent();
        emit ProceedsClaimed(msg.sender, amount);
    }

    function surplus() public view returns (uint256) {
        uint256 balance = settlementAsset.balanceOf(address(this));
        if (balance < totalSellerLiability) revert Insolvent(balance, totalSellerLiability);
        return balance - totalSellerLiability;
    }

    function withdrawFeeSurplus(uint256 amount) external onlyOwner nonReentrant {
        if (amount > surplus()) revert InsufficientSurplus();
        _payExact(treasury, amount);
        _requireSolvent();
        emit FeeWithdrawal(treasury, amount);
    }

    function setFeeBps(uint16 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert InvalidConfiguration();
        uint16 oldFeeBps = feeBps;
        feeBps = newFeeBps;
        emit FeeChangedEvent(oldFeeBps, newFeeBps);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert InvalidConfiguration();
        address oldTreasury = treasury;
        treasury = newTreasury;
        emit TreasuryChanged(oldTreasury, newTreasury);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PauseChanged(paused_);
    }

    function _isLive(uint256 tokenId, Listing memory listing) private view returns (bool) {
        if (
            listing.seller == address(0) || block.timestamp > listing.validUntil
                || !registrar.isActive(tokenId)
        ) return false;

        try registrar.ownerOf(tokenId) returns (address tokenOwner) {
            return tokenOwner == listing.seller && _isApproved(tokenOwner, tokenId);
        } catch {
            return false;
        }
    }

    function _isApproved(address tokenOwner, uint256 tokenId) private view returns (bool) {
        if (registrar.isApprovedForAll(tokenOwner, address(this))) return true;
        try registrar.getApproved(tokenId) returns (address approved) {
            return approved == address(this);
        } catch {
            return false;
        }
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
        if (balance < totalSellerLiability) revert Insolvent(balance, totalSellerLiability);
    }
}
