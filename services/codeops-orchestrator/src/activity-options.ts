export const agentJobActivityOptions = {
  startToCloseTimeout: "70 minutes",
  retry: {
    initialInterval: "5 seconds",
    // A failed dispatch can have crossed the provider boundary with unknown
    // charge state. Do not repeat that side effect automatically.
    maximumAttempts: 1,
  },
} as const;
