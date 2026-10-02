// Written by sdk/scripts/gen.ts from the contracts build. Do not edit by hand.
export const seriesRegistryAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "params_",
        "type": "address",
        "internalType": "contract IRiskParams"
      },
      {
        "name": "hub_",
        "type": "address",
        "internalType": "contract IMarketDataHub"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "hub",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IMarketDataHub"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "listSeries",
    "inputs": [
      {
        "name": "u",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "expiry",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "strike",
        "type": "uint128",
        "internalType": "uint128"
      },
      {
        "name": "isCall",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [
      {
        "name": "id",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "params",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IRiskParams"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "series",
    "inputs": [
      {
        "name": "id",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct Series",
        "components": [
          {
            "name": "underlying",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "expiry",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "isCall",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "strike",
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
    "name": "seriesCount",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "seriesId",
    "inputs": [
      {
        "name": "u",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "expiry",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "strike",
        "type": "uint128",
        "internalType": "uint128"
      },
      {
        "name": "isCall",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "settleExpiry",
    "inputs": [
      {
        "name": "u",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "expiry",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "roundIdHint",
        "type": "uint80",
        "internalType": "uint80"
      }
    ],
    "outputs": [
      {
        "name": "price",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "settleExpiryFallback",
    "inputs": [
      {
        "name": "u",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "expiry",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "firstAfterHint",
        "type": "uint80",
        "internalType": "uint80"
      }
    ],
    "outputs": [
      {
        "name": "price",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "settleExpiryLastResort",
    "inputs": [
      {
        "name": "u",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "expiry",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "roundIdHint",
        "type": "uint80",
        "internalType": "uint80"
      }
    ],
    "outputs": [
      {
        "name": "price",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "settlementPriceOf",
    "inputs": [
      {
        "name": "u",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "expiry",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [
      {
        "name": "price",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "settled",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "ExpirySettled",
    "inputs": [
      {
        "name": "underlying",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "expiry",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      },
      {
        "name": "price",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "roundId",
        "type": "uint80",
        "indexed": false,
        "internalType": "uint80"
      },
      {
        "name": "fallbackUsed",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "SeriesListed",
    "inputs": [
      {
        "name": "id",
        "type": "uint32",
        "indexed": true,
        "internalType": "uint32"
      },
      {
        "name": "underlying",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "expiry",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "strike",
        "type": "uint128",
        "indexed": false,
        "internalType": "uint128"
      },
      {
        "name": "isCall",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AlreadySettled",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadExpiry",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadStrike",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ImplausiblePrice",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NoPrice",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotWeeklyExpiry",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ReentrancyGuardReentrantCall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "StrikeTooFar",
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
    "name": "ZeroAddress",
    "inputs": []
  }
] as const;
