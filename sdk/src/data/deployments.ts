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
    "timelock": "0xf60F96DF709B2dD958519329b4ab488C27e178b5",
    "guardian": "0x4108064852c95135844be338fc8bcBdF91C41ACF",
    "riskParams": "0x113AbDCd234d00FfEA37D29A31BD1Fb2B035dcf1",
    "hub": "0xEcD2baaE3C13b526ffdBB8a8388609442C84d993",
    "registry": "0x9C99381dE80518350fEaA09db17a064eD2180b7b",
    "insurance": "0x531394f5a5D0c3D9e54d258c8825Fa70Fd645429",
    "clearinghouse": "0x0b0F4e67DcA3B846859Af452576e8E09316D1949",
    "auctionHouse": "0x4a132D6f83d9db88092A3D1F8B5985B30fd99Ad9",
    "rfq": "0x1aFD874fdd3914fB6958F282769dAC546993ED82",
    "vaults": [
      {
        "address": "0xCCF205358eF9bfd97335f0D7bD5240487bB64865",
        "type": "coveredCall",
        "underlying": "NVDA"
      },
      {
        "address": "0xF95EAbF20EE1D9034ABa1b240D0242B75e645BD5",
        "type": "coveredCall",
        "underlying": "TSLA"
      },
      {
        "address": "0x0FEee896be42E954c2881668da9035efc5dB0947",
        "type": "putWrite",
        "underlying": "NVDA"
      }
    ],
    "libraries": {
      "AuctionHookLogic": "0x5c3A1bAF3e0554bB703C00723ddb342ce2C82C06",
      "MarginLogic": "0x36EC877374e7F48b34BB190EB18f629F0067a536",
      "SettlementLogic": "0x095B3F6BB7B34E14835fa3BC375725B2C74669e7",
      "TradeLogic": "0xC899560e64267952dc88122651dDF3e40029eA4B",
      "VaultPricing": "0xe110F03A4C2835A3BAAf69D5A2d1EeB602f31C58"
    },
    "block": 127521684
  }
} as const;

/** Refused transactions sent by tools/e2e/scenario.py, per chain: real reverts anyone can replay. */
export const proofTxsJson = {
  "46630": {
    "refusals": [
      {
        "label": "4 agent buys 3 more calls (over budget)",
        "tx": "0xb0cbe3415a6439ecee889ac1c7d6e4438093f0b71b6863842f9128c72f63f4db",
        "block": 127565509,
        "expectedError": "AgentRiskBudgetExceeded"
      },
      {
        "label": "5 withdraw past initial margin",
        "tx": "0xa7e650bedb2c60418117f762f2c775d019f491d49d5d34e5e66e7783e25f9958",
        "block": 127565540,
        "expectedError": "InsufficientMargin"
      },
      {
        "label": "7 RFQ fill on AAPL inside the multiplier window",
        "tx": "0xeed1994e57e6b1d0f7da167b4a44b093ad9e6dcbd42167679f165200e45360e7",
        "block": 127566326,
        "expectedError": "OpeningNotAllowed"
      }
    ]
  }
} as const;
