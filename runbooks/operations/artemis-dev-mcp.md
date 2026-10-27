# Artemis Dev MCP authentication for issue triage

`issue-triage-linear` connects to Artemis Dev through the gh-aw MCP gateway.
Artemis is optional: missing credentials or an unavailable MCP server do not
prevent ordinary GitHub/Linear triage. Invalid configured credentials fail the
authentication step with a diagnostic instead of silently pretending to work.

## Verified identity configuration

- Runtime: `artemis_dev-92qVD14h7V`, account `138234892319`, region `us-east-1`.
- Cognito pool: `us-east-1_N0nw1kBN3`.
- Public OAuth client: `63failqqtu4ovtp54eo3gg2i34`; **no client secret**.
- Token endpoint: `https://sunstone-dev.auth.us-east-1.amazoncognito.com/oauth2/token`.

The runtime's public protected-resource metadata and Cognito's OpenID discovery
were checked during implementation. The matching `packages/web/lib/mcpConnect.ts`
in `SunStone-Secure-LLC/agent-chatbot` identifies this as the public Claude MCP
client, using browser sign-in with `openid email profile` and callback port 8765.

A client ID identifies the application; it is not a bearer token. gh-aw's custom
HTTP server configuration supports headers, but has no OAuth browser-login or
refresh configuration field. MCP Scripts expose local code as agent-callable
tools; their gateway authentication does not authenticate to Artemis.

## Configure one credential

Obtain credentials through an authorized Artemis Dev user's OAuth
**authorization-code/PKCE** sign-in using the client above. Use a user whose
Cognito group membership grants only the organizations this workflow needs.
The user's group/tenant permissions still apply to MCP calls.

Set a repository Actions secret on `sunstonesecure-robert/test-turtle-1`:

- `ARTEMIS_DEV_ACCESS_TOKEN`: the raw access JWT, without `Bearer `. Suitable for
  an initial connection test; it needs at least 15 minutes remaining at startup.
  An ID token, client secret, or token issued for a different client is rejected.
- Alternatively, `ARTEMIS_DEV_REFRESH_TOKEN`: a refresh token from that same
  sign-in. The setup step exchanges it for a fresh access token on every run.
  This takes precedence if both secrets exist. The refresh token itself expires
  or can be revoked; renew the secret when that happens.

Do not paste either credential into issues, workflow YAML, PRs, or chat. Use the
GitHub Actions secrets UI, or `gh secret set NAME --repo
sunstonesecure-robert/test-turtle-1` and enter it at the hidden prompt.

The refresh-token path requires **rotation to be disabled for that login's app
client**. The helper rejects responses containing a new refresh token because it
cannot safely persist rotation back to a GitHub secret. It does not change the
Cognito app client. For rotating refresh tokens, use a managed token broker;
otherwise provision a suitable dedicated automation login/client before using
recurring refresh. A different client ID also requires updating the helper and
confirming the runtime's allowed clients.

A machine-to-machine `client_credentials` flow requires a separate confidential
client with a secret and appropriate scopes, plus runtime/application support.
The current server's authorization relies on user/group claims, so simply adding
a client secret or using GitHub OIDC/AWS credentials is not an equivalent login.

## Runtime behavior and verification

`scripts/mcp/artemis-auth.py` sends refresh requests only to the fixed Cognito
endpoint and refuses redirects. It masks the access token and passes it through
a step output to the gateway's Authorization header. Neither credential is
supplied to Claude's execution environment. Local JWT checks only check shape,
issuer, client, token type, and lifetime; AgentCore verifies the signature and
server-side authorization.

The gateway permits only the explicitly named read tools in the workflow.
Artemis tools cannot install skills or expand the GitHub safe outputs. Skills
continue to come exclusively from the approved `claude-skills` repository.

After configuring the credential, dispatch against a relevant issue and inspect
the `Authenticate Artemis Dev` and `Start MCP Gateway` steps. Confirm a successful
`artemis-dev` connection and an actual `server_info` or relevant read-tool result;
a green workflow alone is insufficient because this server is optional.

Validation:

```sh
python3 -m unittest discover -s tests/mcp -v
gh aw compile issue-triage-linear --no-check-update --actionlint
```

References: [gh-aw custom MCP servers](https://github.github.com/gh-aw/reference/tools/#custom-mcp-servers-mcp-servers),
[MCP Scripts specification](https://github.github.com/gh-aw/specs/mcp-scripts-specification/),
[Cognito token endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/token-endpoint.html).
