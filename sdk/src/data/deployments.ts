// Written by sdk/scripts/gen.ts from the contracts build. Do not edit by hand.
/** contracts/deployments/<chainId>.json, as deployed. */
export const deploymentsJson = {
  "46630": {
    "chainId": 46630,
    "kernel": {
      "address": "0xAeE1D4F45AF43a9C4d52ADa65d423b1c0e67f0fd",
      "type": "stylus",
      "codehash": "0xa34c0177edcade5da15ac0fe4aeddb59161e76165303686f66a9eeaed27a5c8d",
      "wasmSha256": "ed1fdde1c826c81c39ef6e4e72336c24f098ef581346691e7b7d735bb2487096"
    },
    "kernelReference": "0xB7d9232c8ff46b4950d85ed639908c86C08750C6",
    "tokens": {
      "AAPL": "0x4311Cc3931f638E9f4a7b7109563e78348C95266",
      "NVDA": "0xc2DBC8d95f357C2746242a497BD3170B87F77999",
      "SPY": "0x06774db4af357f760Dc6448C3C11b2b7aF2eBFdE",
      "TSLA": "0x8F5A67fAb73bcaBD569ac1263433A2Df633b8fF5",
      "USDG": "0xfBb0e60027151cb321b936C2c71278cd08d03921"
    },
    "feeds": {
      "AAPL": "0x06d33Aeb7A5A44ad8af1A67bB2FEA41D62185602",
      "NVDA": "0x8E465F19Ff52DACB53B9dE3A8C42912001A664e5",
      "SPY": "0x78d6096c09253cc7B30D324D06f8BA25C8A4265C",
      "TSLA": "0x3c57717cb77CD28e27bc57e67FB4b0DE73937d80"
    },
    "timelock": "0x5eb54aa55f3e03b7F50b7aFD22F235FB0e85235F",
    "guardian": "0x4108064852c95135844be338fc8bcBdF91C41ACF",
    "riskParams": "0x5Ec7F77cee13E6c246F80AAaa466992210e17F6f",
    "hub": "0x2BFFfa823cFcCfd703793320883134aC009a5a51",
    "registry": "0x4A8bD72CD6e2Cd743c2f103447B47cFf0B22cC77",
    "insurance": "0x9826E96ec14Ff888626E4c6Cf44224925671D1fF",
    "clearinghouse": "0xe799DF9b96a4809c411D3F90f67C5261a245ABB2",
    "auctionHouse": "0x0a7590A4C07604D738ab3DDe18306e3026a7Cf0B",
    "rfq": "0x56562573b74A6cD6ca96cfb794A63625A48edf08",
    "vaults": [
      {
        "address": "0x5e36BbAc665244f623cf8195b7a753Ad61D8bacA",
        "type": "coveredCall",
        "underlying": "NVDA"
      },
      {
        "address": "0x684Fc5aE66267E8184704f6A3cE393f0c18B1095",
        "type": "coveredCall",
        "underlying": "TSLA"
      },
      {
        "address": "0x691E99fb5498570F4A0AB8a74aAAE3361c0E0a3a",
        "type": "putWrite",
        "underlying": "NVDA"
      }
    ],
    "libraries": {
      "AuctionHookLogic": "0xF1f37F1320c06535149525Ed6dE2d7D9c9fc0033",
      "MarginLogic": "0xCe93b81f68b33b56aF06c00CB3AB659178Ce2D7b",
      "SettlementLogic": "0xf5c256273bafEc29d9F4b81C6bA84b8e2d45a901",
      "TradeLogic": "0x74C6318bd22f623c177faF5a9b24504ed7E86C17"
    },
    "block": 127134221
  }
} as const;

/** Refused transactions sent by tools/e2e/scenario.py, per chain: real reverts anyone can replay. */
export const proofTxsJson = {
  "46630": {
    "refusals": [
      {
        "label": "4 agent buys 3 more calls (over budget)",
        "tx": "0xa411c8e1173e78c41e6c2f12611d553f54583cb1203eaf651bc9bc725e2c1b9a",
        "block": 127138649,
        "expectedError": "AgentRiskBudgetExceeded"
      },
      {
        "label": "5 withdraw past initial margin",
        "tx": "0xc947dc28bb91b5499f88ac89911507758d7447db5666720a8eb7d86dd77c3094",
        "block": 127138669,
        "expectedError": "InsufficientMargin"
      },
      {
        "label": "7 RFQ fill on AAPL inside the multiplier window",
        "tx": "0x7756c29f080df6458613f129e8aa9b9dc5adadc3c098bb31edd04ecacb447c46",
        "block": 127139302,
        "expectedError": "OpeningNotAllowed"
      }
    ]
  }
} as const;
