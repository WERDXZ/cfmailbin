export const gatewayEnv = {
  CFMAILBIN_AI_GATEWAY_ACCOUNT_ID: "a".repeat(32),
  CFMAILBIN_AI_GATEWAY_ID: "cfmailbin",
  CF_AIG_TOKEN: "test-gateway-token-never-public",
};

export const gateway = {
  accountId: gatewayEnv.CFMAILBIN_AI_GATEWAY_ACCOUNT_ID,
  id: gatewayEnv.CFMAILBIN_AI_GATEWAY_ID,
  token: gatewayEnv.CF_AIG_TOKEN,
};

export const gatewayBase =
  `https://gateway.ai.cloudflare.com/v1/${gateway.accountId}/${gateway.id}`;
