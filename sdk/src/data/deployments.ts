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
    "timelock": "0xe3a0D2Dd94607f86d9641571B5fe328a274C4030",
    "guardian": "0x4108064852c95135844be338fc8bcBdF91C41ACF",
    "riskParams": "0x569768651DbB577Dcda4547e9B177f702b6F1D00",
    "hub": "0x42894B89a9fC7aFe3bD12555CAc20b6695a5ed9C",
    "registry": "0x079f744c046F7C1fCc43b1Fe5124513637d19dA8",
    "insurance": "0x295FB7eB9dcE936190567032C72697FaCEAdb96C",
    "clearinghouse": "0x397dc6b74003172C27297520E98472C5fd168238",
    "auctionHouse": "0x2775a3feECA95a29141A9d3903b1C8fABa2B4658",
    "rfq": "0xcD5d78984A2ebe76D7B09C8304E79a078B93D328",
    "vaults": [
      {
        "address": "0xAC989aF37744FeB96Cad8d553e7321a8b5b1D5d9",
        "type": "coveredCall",
        "underlying": "NVDA"
      },
      {
        "address": "0x55E624783C129721Bd8735D1E4Ef1E5c06BE708A",
        "type": "coveredCall",
        "underlying": "TSLA"
      },
      {
        "address": "0xa47A07846902bDB8cE5306C1F851278447f3e237",
        "type": "putWrite",
        "underlying": "NVDA"
      }
    ],
    "libraries": {
      "AuctionHookLogic": "0x27D6Be2eC8980721235916b7d6Ed73aaaD79C6be",
      "MarginLogic": "0x3e991293bfff1953e9C30ef7B5D2dd28083B234D",
      "SettlementLogic": "0x943D999897d3833Ea76826AFf894814F82d38fA7",
      "TradeLogic": "0x53F0e60fa0Ccdd8B4A76a6961fE228498B4F9471",
      "VaultPricing": "0x47417e1Ac7Ac31F015E06C3Af843A92C6f217D51"
    },
    "block": 127762103
  }
} as const;

/** Refused transactions sent by tools/e2e/scenario.py, per chain: real reverts anyone can replay. */
export const proofTxsJson = {
  "46630": {
    "refusals": [
      {
        "label": "4 agent buys 3 more calls (over budget)",
        "tx": "0x7b91ebf435f1c2e3f57d65dc06d0e01e88ed48d2b9fcfe1a862ed5c677826afb",
        "block": 127766068,
        "expectedError": "AgentRiskBudgetExceeded"
      },
      {
        "label": "5 withdraw past initial margin",
        "tx": "0x96b225d4cef0e2c30fb00da1b406e30799b16be5342edb2f6bb363459175edb5",
        "block": 127766095,
        "expectedError": "InsufficientMargin"
      },
      {
        "label": "7 RFQ fill on AAPL inside the multiplier window",
        "tx": "0xae5f3ea5f320c91d36334a53d56e90cb2e203f8933b454bba396bbc8f6fc32cf",
        "block": 127766643,
        "expectedError": "OpeningNotAllowed"
      }
    ]
  }
} as const;
