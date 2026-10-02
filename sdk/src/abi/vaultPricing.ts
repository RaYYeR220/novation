// Written by sdk/scripts/gen.ts from the contracts build. Do not edit by hand.
export const vaultPricingAbi = [
  {
    "type": "function",
    "name": "absDelta",
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
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "unitPrice",
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
        "name": "skewSlope",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "utilTerm",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "sessionAdd",
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
      },
      {
        "name": "takerBuys",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [
      {
        "name": "px",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "error",
    "name": "ExpOverflow",
    "inputs": []
  },
  {
    "type": "error",
    "name": "LnNonPositive",
    "inputs": []
  }
] as const;
