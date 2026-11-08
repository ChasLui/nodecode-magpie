// magpie entry point. The host instantiates every exported function, so this
// file must export plugin factories only. Helpers live in lib/nodecode.mjs.

import {
  authFor,
  declareProvider,
  providerEntry,
  FREE_ID,
  PAID_ID,
} from "./lib/nodecode.mjs"

// Paid NodeCode key: full 1M context and native tool calling.
export const NodecodePlugin = async () => ({
  config: async (config) => {
    declareProvider(config, PAID_ID, providerEntry(false))
  },
  auth: authFor(PAID_ID, { free: false }),
  provider: {
    id: PAID_ID,
    async models() {
      return providerEntry(false).models
    },
  },
})

// Free NodeCode key: nodecode-cyber-v1 only, 256K context, no tools.
export const NodecodeFreePlugin = async () => ({
  config: async (config) => {
    declareProvider(config, FREE_ID, providerEntry(true))
  },
  auth: authFor(FREE_ID, { free: true }),
  provider: {
    id: FREE_ID,
    async models() {
      return providerEntry(true).models
    },
  },
})