// Written by sdk/scripts/gen.ts from the contracts build. Do not edit by hand.
export const marketDataHubAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "params_",
        "type": "address",
        "internalType": "contract IRiskParams"
      },
      {
        "name": "kernel_",
        "type": "address",
        "internalType": "contract IRiskKernel"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "initVol",
    "inputs": [
      {
        "name": "u",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "kernel",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IRiskKernel"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "markVol",
    "inputs": [
      {
        "name": "u",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "vol",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
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
    "name": "pokeVol",
    "inputs": [
      {
        "name": "u",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "roundIds",
        "type": "uint80[]",
        "internalType": "uint80[]"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "rebaseVol",
    "inputs": [
      {
        "name": "u",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "session",
    "inputs": [
      {
        "name": "u",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint8",
        "internalType": "enum Session"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "settlementPrice",
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
        "name": "hint",
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
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "settlementPriceFallback",
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
        "name": "firstAfter",
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
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "spot",
    "inputs": [
      {
        "name": "u",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "price",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "s",
        "type": "uint8",
        "internalType": "enum Session"
      },
      {
        "name": "ok",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "syncVol",
    "inputs": [
      {
        "name": "u",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "volState",
    "inputs": [
      {
        "name": "u",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "r2",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "dt",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "lastRoundId",
        "type": "uint80",
        "internalType": "uint80"
      },
      {
        "name": "lastPrice",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "lastUpdatedAt",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "lastPokeTs",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "VolInitialized",
    "inputs": [
      {
        "name": "underlying",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "roundId",
        "type": "uint80",
        "indexed": false,
        "internalType": "uint80"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "VolPoked",
    "inputs": [
      {
        "name": "underlying",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "lastRoundId",
        "type": "uint80",
        "indexed": false,
        "internalType": "uint80"
      },
      {
        "name": "variance",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "VolRebased",
    "inputs": [
      {
        "name": "underlying",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "oldRoundId",
        "type": "uint80",
        "indexed": false,
        "internalType": "uint80"
      },
      {
        "name": "newRoundId",
        "type": "uint80",
        "indexed": false,
        "internalType": "uint80"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AlreadyInitialized",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadDecimals",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadHint",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadRoundCount",
    "inputs": []
  },
  {
    "type": "error",
    "name": "FallbackNotAllowed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ImplausiblePrice",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidRound",
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
    "name": "NonConsecutiveRound",
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
    "name": "NotInitialized",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PhaseNotExhausted",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ReentrancyGuardReentrantCall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TooEarly",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  }
] as const;
