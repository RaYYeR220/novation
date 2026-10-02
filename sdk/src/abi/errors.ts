// Written by sdk/scripts/gen.ts from the contracts build. Do not edit by hand.
/** Every custom error a Novation contract or linked library can revert with (OpenZeppelin's included). */
export const novationErrorsAbi = [
  {
    "type": "error",
    "name": "AccountNotEmpty",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "AgentPremiumExceeded",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AgentRiskBudgetExceeded",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "worstLoss",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "budget",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "AgentUnderlyingNotAllowed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AgentValueDrainExceeded",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "loss",
        "type": "int256",
        "internalType": "int256"
      },
      {
        "name": "cap",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "AlreadyAdded",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AlreadyBound",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AlreadyFinalized",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AlreadyInitialized",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AlreadySettled",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AuctionActive",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AuctionHouseNotBound",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AuctionNotActive",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadConfig",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadDecimals",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadExpiry",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadFraction",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadHint",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadQty",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadReceiver",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadRoundCount",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadShockRange",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadSignature",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadStrike",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadUnderlyingIndex",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BelowMinNewSeries",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BelowMinOut",
    "inputs": [
      {
        "name": "tokens",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "cash",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "BidRaisesRisk",
    "inputs": [
      {
        "name": "imAfter",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "imBefore",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "BidderInDeficit",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BidderUnhealthy",
    "inputs": []
  },
  {
    "type": "error",
    "name": "DepositNotAllowed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "DustPosition",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "qty",
        "type": "int256",
        "internalType": "int256"
      }
    ]
  },
  {
    "type": "error",
    "name": "ERC20InsufficientAllowance",
    "inputs": [
      {
        "name": "spender",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "allowance",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "needed",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "ERC20InsufficientBalance",
    "inputs": [
      {
        "name": "sender",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "balance",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "needed",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "ERC20InvalidApprover",
    "inputs": [
      {
        "name": "approver",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "ERC20InvalidReceiver",
    "inputs": [
      {
        "name": "receiver",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "ERC20InvalidSender",
    "inputs": [
      {
        "name": "sender",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "ERC20InvalidSpender",
    "inputs": [
      {
        "name": "spender",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "ERC4626ExceededMaxDeposit",
    "inputs": [
      {
        "name": "receiver",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "assets",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "max",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "ERC4626ExceededMaxMint",
    "inputs": [
      {
        "name": "receiver",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "shares",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "max",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "ERC4626ExceededMaxRedeem",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "shares",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "max",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "ERC4626ExceededMaxWithdraw",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "assets",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "max",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "ExceedsCapacity",
    "inputs": [
      {
        "name": "required",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "available",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "ExceedsCollateral",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ExceedsDeficit",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ExceedsFreeAssets",
    "inputs": [
      {
        "name": "assets",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "free",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "ExceedsShort",
    "inputs": [
      {
        "name": "qty",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "short",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "ExitCooldown",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "until",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "ExpOverflow",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ExpiryNotSettled",
    "inputs": []
  },
  {
    "type": "error",
    "name": "FallbackNotAllowed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "FractionTooLarge",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ImplausiblePrice",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InDeficit",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InsufficientCash",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "cash",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "wad",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "InsufficientCollateral",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "collateral",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "wad",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "InsufficientMargin",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "equity",
        "type": "int256",
        "internalType": "int256"
      },
      {
        "name": "im",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidAgent",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidExpiry",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidFraction",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidRecipient",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidRound",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidShortString",
    "inputs": []
  },
  {
    "type": "error",
    "name": "LengthMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "LnNonPositive",
    "inputs": []
  },
  {
    "type": "error",
    "name": "MarketClosed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NextRoundMissing",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NoPhaseChange",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NoPrice",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NoWeeklyExpiryFound",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NonConsecutiveRound",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NonceCancelled",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotAuctionHouse",
    "inputs": [
      {
        "name": "caller",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotAuthorized",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "actor",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotBidder",
    "inputs": [
      {
        "name": "bidderId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "caller",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotClearinghouse",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotExpiry",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotFirstAfter",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotImplemented",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotInitialized",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotLiquidatable",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotOwner",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "caller",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotSetupAdmin",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotVenue",
    "inputs": [
      {
        "name": "caller",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotWeeklyExpiry",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NothingToClaim",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NothingToSettle",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NothingToSocialize",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OpenInterestCap",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OpeningNotAllowed",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "OutOfBounds",
    "inputs": [
      {
        "name": "field",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "OutsideOfferBand",
    "inputs": [
      {
        "name": "absDelta",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "Overfill",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PayAboveMax",
    "inputs": [
      {
        "name": "paid",
        "type": "int256",
        "internalType": "int256"
      },
      {
        "name": "maxPay",
        "type": "int256",
        "internalType": "int256"
      }
    ]
  },
  {
    "type": "error",
    "name": "PhaseNotExhausted",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PoolNotReady",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PoolShortfall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PremiumAboveMax",
    "inputs": [
      {
        "name": "premium",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "maxPremium",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "PremiumBelowMin",
    "inputs": [
      {
        "name": "premium",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "minPremium",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "QtyTooSmall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "QuoteExpired",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ReentrancyGuardReentrantCall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RiskIncreaseNotAllowed",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "im",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "preIm",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "SafeCastOverflowedIntDowncast",
    "inputs": [
      {
        "name": "bits",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "value",
        "type": "int256",
        "internalType": "int256"
      }
    ]
  },
  {
    "type": "error",
    "name": "SafeCastOverflowedUintToInt",
    "inputs": [
      {
        "name": "value",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "SafeERC20FailedOperation",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "SaleNotActive",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SelfBid",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SelfTrade",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SeriesExpired",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SetupAlreadyFinalized",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SignerNotAuthorized",
    "inputs": []
  },
  {
    "type": "error",
    "name": "StillLiquidatable",
    "inputs": []
  },
  {
    "type": "error",
    "name": "StrikeNotOtm",
    "inputs": []
  },
  {
    "type": "error",
    "name": "StrikeTooFar",
    "inputs": []
  },
  {
    "type": "error",
    "name": "StringTooLong",
    "inputs": [
      {
        "name": "str",
        "type": "string",
        "internalType": "string"
      }
    ]
  },
  {
    "type": "error",
    "name": "TenorTooLong",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TokenNotAllowed",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "TooEarly",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TooManyPositions",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TooManySeries",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TooManyUnderlyings",
    "inputs": []
  },
  {
    "type": "error",
    "name": "Unauthorized",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnderlyingDisabled",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnderlyingHalted",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnknownAccount",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "UnknownSeries",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnknownUnderlying",
    "inputs": []
  },
  {
    "type": "error",
    "name": "VaultInDeficit",
    "inputs": []
  },
  {
    "type": "error",
    "name": "VaultNotLive",
    "inputs": []
  },
  {
    "type": "error",
    "name": "VolNotCurrent",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WrongOptionType",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WrongUnderlying",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAmount",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroShares",
    "inputs": []
  }
] as const;
