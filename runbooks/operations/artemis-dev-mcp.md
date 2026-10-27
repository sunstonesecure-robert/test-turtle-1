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

### First connection test: browser sign-in and an access token

1. On your laptop, install Python 3 and GitHub CLI (`gh`) if needed. Run
   `gh auth login` and sign in with an account allowed to manage Actions secrets
   in `sunstonesecure-robert/test-turtle-1`. The login helper needs only Python's
   standard library; there is no pip install.
2. Get a current checkout containing the helper. For a new directory:

   ```sh
   gh repo clone sunstonesecure-robert/test-turtle-1 artemis-login-setup
   cd artemis-login-setup
   ```

3. Run this **locally on the computer running your browser**, not in Actions,
   an SSH session, or a remote container:

   ```sh
   python3 scripts/mcp/artemis-login.py
   ```

4. Your browser opens Cognito's Artemis Dev sign-in. Use your authorized Artemis
   Dev account and complete any Google sign-in/MFA prompts. The browser returns to
   `http://localhost:8765/callback`. Leave the helper running until your terminal
   confirms `Saved ARTEMIS_DEV_ACCESS_TOKEN in sunstonesecure-robert/test-turtle-1`.
   Browser callback success alone does not confirm GitHub upload success.
5. Verify the **name** of the secret exists (this never displays its value):

   ```sh
   gh secret list --repo sunstonesecure-robert/test-turtle-1
   ```

6. Test promptly, before the access token expires. Issue 175 is available as a
   workflow smoke test, but its test-submission content may cause Claude to skip
   Artemis reads. For an actual Artemis read, select a relevant issue and check
   for a successful server connection and read-tool result:

   ```sh
   gh aw run issue-triage-linear --repo sunstonesecure-robert/test-turtle-1 --ref main --raw-field issue_number=175
   ```

The helper generates the PKCE verifier/challenge and state, listens only on the
loopback interface, exchanges the authorization code at the fixed Cognito token
endpoint, and pipes the access token directly into `gh secret set`. It does not
print tokens, log callback URLs, or save tokens to a local file. Do not paste
credentials or the callback URL into chat or issues.

### Recurring runs: save a refresh token

1. In the AWS console, select **us-east-1 → Cognito → User pools** and open pool
   `us-east-1_N0nw1kBN3`. Under its app clients, select client ID
   `63failqqtu4ovtp54eo3gg2i34`.
2. Inspect its refresh-token settings. Proceed only if refresh-token rotation is
   **disabled**. Do not change a shared app client's settings solely for this
   workflow; if rotation is enabled, use the access-token test above and arrange
   a dedicated automation client or token broker.
3. From the same checkout on your laptop, run:

   ```sh
   python3 scripts/mcp/artemis-login.py --refresh --rotation-disabled
   ```

4. Complete browser sign-in again. Wait for the terminal confirmation that
   `ARTEMIS_DEV_REFRESH_TOKEN` was saved. The workflow exchanges that secret for
   a fresh access token before each run. It takes precedence over
   `ARTEMIS_DEV_ACCESS_TOKEN`, so both may exist, but a stale refresh token will
   not automatically fall back to the access token.
5. Repeat this sign-in when the refresh token expires or is revoked. Its lifetime
   is controlled by Cognito; the helper does not alter that configuration.

### Login troubleshooting

If an older helper prints only `Token exchange failed. No credential or response
body was printed.`, update your clean setup checkout and run the new diagnostic:

```sh
git pull --ff-only
python3 scripts/mcp/artemis-login.py --check-connection
```

This contacts the actual token endpoint with a dummy authorization code. It
checks Python's TLS/network path without signing in, accessing credentials, or
changing GitHub secrets. A successful check reports `Connection OK`; then run
`python3 scripts/mcp/artemis-login.py` again for a fresh browser sign-in. Do not
reuse an old callback URL or authorization code.

- **TLS certificate verification failed:** for Python installed from python.org
  on macOS, run `Install Certificates.command` in the matching
  `/Applications/Python 3.x/` folder. The diagnostic prints the active Python
  version and executable. Do not modify Apple's system Python. For corporate TLS
  inspection, use your organization-approved CA configuration. Never disable
  certificate verification. See [Python's macOS installation guide](https://docs.python.org/3/using/mac.html).
- **DNS, connection refusal, or timeout:** check the network, VPN, and proxy used
  by your terminal. Browser sign-in succeeding does not prove Python can contact
  the token endpoint.
- **Non-JSON response:** a proxy or unexpected endpoint response may be involved;
  the helper intentionally does not print the response body.
- **OAuth `invalid_grant`:** start a fresh sign-in; the code may have expired,
  been used already, or failed PKCE/callback validation. During
  `--check-connection` only, this rejection is expected for the dummy code.


- **Redirect mismatch:** inspect the client above and its allowed callback URLs.
  The exact URL must be `http://localhost:8765/callback`. Its login configuration
  must allow authorization-code grants and `openid email profile`. Ask the client
  administrator to correct any mismatch; these are the settings documented by
  Artemis's own MCP connector.
- **Port 8765 in use:** stop another local OAuth login helper using that port,
  then retry. The callback port cannot be changed without registering that URL.
- **Browser cannot connect to localhost:** run the helper on the same computer
  as the browser and keep its terminal open. Restart if the five-minute window
  expired.
- **An existing refresh token takes precedence:** the helper refuses to save an
  access-only credential that the workflow would ignore. Renew the refresh token
  with the refresh command, or deliberately remove `ARTEMIS_DEV_REFRESH_TOKEN`
  from the repository's Actions secrets to switch to access-token-only testing.
- **GitHub upload denied:** confirm your GitHub account can manage this
  repository's Actions secrets, then rerun sign-in.
- **Artemis denies a tool call after successful login:** verify the user's
  Cognito group membership grants access to the requested organization.

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
