// Written by sdk/scripts/gen.ts from the contracts build. Do not edit by hand.
export const riskParamsAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "usdg_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "treasury_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "sequencerUptimeFeed_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "timelock_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "guardian_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "setupAdmin_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "initial",
        "type": "tuple",
        "internalType": "struct GlobalParams",
        "components": [
          {
            "name": "mmRatio",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "diversificationCredit",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "shortOptionMinPct",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "feeRate",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "feeCapOfPremium",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "insuranceShare",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "startDiscount",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "maxDiscount",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "maxFractionPerBid",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "liquidationPenalty",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "auctionDuration",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "maxSettlementLag",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "haltWindow",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "maxWeeksOut",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "maxStrikeDeviation",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "rate",
            "type": "int64",
            "internalType": "int64"
          },
          {
            "name": "minTradeQty",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "dustEquity",
            "type": "uint128",
            "internalType": "uint128"
          }
        ]
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "addUnderlying",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "p",
        "type": "tuple",
        "internalType": "struct UnderlyingParams",
        "components": [
          {
            "name": "enabled",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "index",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "feed",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "strikeStep",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "volFloor",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "volCap",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "lambda",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "shockK",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "minShock",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "horizonDays",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "volUp",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "volDown",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "multExtended",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "multWeekend",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "multHoliday",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "multHalted",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "maxOpenInterest",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "maxStaleRegular",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "maxStaleExtended",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "maxStaleClosed",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "volStaleness",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "minPrice",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "maxPrice",
            "type": "uint128",
            "internalType": "uint128"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "finalizeSetup",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "globals",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct GlobalParams",
        "components": [
          {
            "name": "mmRatio",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "diversificationCredit",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "shortOptionMinPct",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "feeRate",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "feeCapOfPremium",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "insuranceShare",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "startDiscount",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "maxDiscount",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "maxFractionPerBid",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "liquidationPenalty",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "auctionDuration",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "maxSettlementLag",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "haltWindow",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "maxWeeksOut",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "maxStrikeDeviation",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "rate",
            "type": "int64",
            "internalType": "int64"
          },
          {
            "name": "minTradeQty",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "dustEquity",
            "type": "uint128",
            "internalType": "uint128"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "guardian",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "openingPaused",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pauseOpening",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "sequencerUptimeFeed",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "setGlobals",
    "inputs": [
      {
        "name": "g",
        "type": "tuple",
        "internalType": "struct GlobalParams",
        "components": [
          {
            "name": "mmRatio",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "diversificationCredit",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "shortOptionMinPct",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "feeRate",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "feeCapOfPremium",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "insuranceShare",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "startDiscount",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "maxDiscount",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "maxFractionPerBid",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "liquidationPenalty",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "auctionDuration",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "maxSettlementLag",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "haltWindow",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "maxWeeksOut",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "maxStrikeDeviation",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "rate",
            "type": "int64",
            "internalType": "int64"
          },
          {
            "name": "minTradeQty",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "dustEquity",
            "type": "uint128",
            "internalType": "uint128"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setUnderlying",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "p",
        "type": "tuple",
        "internalType": "struct UnderlyingParams",
        "components": [
          {
            "name": "enabled",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "index",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "feed",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "strikeStep",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "volFloor",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "volCap",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "lambda",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "shockK",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "minShock",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "horizonDays",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "volUp",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "volDown",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "multExtended",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "multWeekend",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "multHoliday",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "multHalted",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "maxOpenInterest",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "maxStaleRegular",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "maxStaleExtended",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "maxStaleClosed",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "volStaleness",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "minPrice",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "maxPrice",
            "type": "uint128",
            "internalType": "uint128"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setupAdmin",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "setupFinalized",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "timelock",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "treasury",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "underlying",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct UnderlyingParams",
        "components": [
          {
            "name": "enabled",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "index",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "feed",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "strikeStep",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "volFloor",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "volCap",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "lambda",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "shockK",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "minShock",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "horizonDays",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "volUp",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "volDown",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "multExtended",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "multWeekend",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "multHoliday",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "multHalted",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "maxOpenInterest",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "maxStaleRegular",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "maxStaleExtended",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "maxStaleClosed",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "volStaleness",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "minPrice",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "maxPrice",
            "type": "uint128",
            "internalType": "uint128"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "underlyingAt",
    "inputs": [
      {
        "name": "index",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "underlyingCount",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "unpauseOpening",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "usdg",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "GlobalsUpdated",
    "inputs": [],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OpeningPaused",
    "inputs": [
      {
        "name": "paused",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "UnderlyingAdded",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "index",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "UnderlyingUpdated",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AlreadyAdded",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AlreadyFinalized",
    "inputs": []
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
    "name": "ReentrancyGuardReentrantCall",
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
    "name": "UnknownUnderlying",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  }
] as const;
