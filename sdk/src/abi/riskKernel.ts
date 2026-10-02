// Written by sdk/scripts/gen.ts from the contracts build. Do not edit by hand.
export const riskKernelAbi = [
  {
    "type": "function",
    "name": "bsQuote",
    "inputs": [
      {
        "name": "spot",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "strike",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "tau",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "vol",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "rate",
        "type": "int256",
        "internalType": "int256"
      },
      {
        "name": "isCall",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [
      {
        "name": "price",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "delta",
        "type": "int256",
        "internalType": "int256"
      },
      {
        "name": "gamma",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "vega",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "theta",
        "type": "int256",
        "internalType": "int256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "ewmaUpdate",
    "inputs": [
      {
        "name": "prevR2",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "prevDt",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "lastPrice",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "prices",
        "type": "uint256[]",
        "internalType": "uint256[]"
      },
      {
        "name": "dts",
        "type": "uint256[]",
        "internalType": "uint256[]"
      },
      {
        "name": "lambda",
        "type": "uint256",
        "internalType": "uint256"
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
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "margin",
    "inputs": [
      {
        "name": "p",
        "type": "tuple",
        "internalType": "struct KParams",
        "components": [
          {
            "name": "nowTs",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "rate",
            "type": "int256",
            "internalType": "int256"
          },
          {
            "name": "diversificationCredit",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "shortOptionMinPct",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      },
      {
        "name": "us",
        "type": "tuple[]",
        "internalType": "struct KUnderlying[]",
        "components": [
          {
            "name": "spot",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "vol",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "shockRange",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "volUp",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "volDown",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "tokenQty",
            "type": "int256",
            "internalType": "int256"
          }
        ]
      },
      {
        "name": "ps",
        "type": "tuple[]",
        "internalType": "struct KPosition[]",
        "components": [
          {
            "name": "u",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "isCall",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "expiry",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "strike",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "qty",
            "type": "int256",
            "internalType": "int256"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "out",
        "type": "tuple",
        "internalType": "struct KMarginOut",
        "components": [
          {
            "name": "mtm",
            "type": "int256",
            "internalType": "int256"
          },
          {
            "name": "lossIM",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "lossCorr",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "lossIndep",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "shortMin",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "worstScenario",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      },
      {
        "name": "perUnderlyingWorst",
        "type": "int256[]",
        "internalType": "int256[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "scenarioGrid",
    "inputs": [
      {
        "name": "p",
        "type": "tuple",
        "internalType": "struct KParams",
        "components": [
          {
            "name": "nowTs",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "rate",
            "type": "int256",
            "internalType": "int256"
          },
          {
            "name": "diversificationCredit",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "shortOptionMinPct",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      },
      {
        "name": "us",
        "type": "tuple[]",
        "internalType": "struct KUnderlying[]",
        "components": [
          {
            "name": "spot",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "vol",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "shockRange",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "volUp",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "volDown",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "tokenQty",
            "type": "int256",
            "internalType": "int256"
          }
        ]
      },
      {
        "name": "ps",
        "type": "tuple[]",
        "internalType": "struct KPosition[]",
        "components": [
          {
            "name": "u",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "isCall",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "expiry",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "strike",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "qty",
            "type": "int256",
            "internalType": "int256"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "pnl",
        "type": "int256[]",
        "internalType": "int256[]"
      }
    ],
    "stateMutability": "view"
  }
] as const;
