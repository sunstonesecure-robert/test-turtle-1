#!/usr/bin/env python3
"""Obtain Artemis Dev's bearer token before the MCP gateway starts.

Public Cognito client: no client secret. A non-rotating refresh token from a
browser authorization-code/PKCE login can renew access for each run. A supplied
access token is also supported for one-off tests. Tokens never go to the agent.
"""
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

CLIENT_ID = '63failqqtu4ovtp54eo3gg2i34'
ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_N0nw1kBN3'
TOKEN_ENDPOINT = 'https://sunstone-dev.auth.us-east-1.amazoncognito.com/oauth2/token'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Artemis token endpoint redirected; credentials were not forwarded')


def validate_access_token(token, now=None):
    """Check shape/expected claims, not signature; AgentCore verifies authenticity."""
    if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', token):
        raise ValueError('Artemis access token must be a JWT without a Bearer prefix')
    try:
        payload = token.split('.')[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
        if not isinstance(claims, dict):
            raise ValueError()
    except (ValueError, UnicodeError):
        raise ValueError('Artemis access token has an invalid payload') from None
    if claims.get('iss') != ISSUER or claims.get('client_id') != CLIENT_ID or claims.get('token_use') != 'access':
        raise ValueError('Artemis needs an access token from the configured Dev pool and public client')
    expiry = claims.get('exp')
    if not isinstance(expiry, (int, float)) or expiry < (time.time() if now is None else now) + 900:
        raise ValueError('Artemis access token needs at least 15 minutes remaining; sign in again or configure a refresh token')
    return token


def refresh_access_token(refresh_token, opener=None):
    body = urllib.parse.urlencode({'grant_type': 'refresh_token', 'client_id': CLIENT_ID,
                                  'refresh_token': refresh_token}).encode()
    request = urllib.request.Request(TOKEN_ENDPOINT, data=body,
                                     headers={'Content-Type': 'application/x-www-form-urlencoded'}, method='POST')
    opener = opener or urllib.request.build_opener(NoRedirect())
    try:
        with opener.open(request, timeout=30) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        raise ValueError(f'Artemis OAuth refresh failed (HTTP {error.code}); check or renew ARTEMIS_DEV_REFRESH_TOKEN') from None
    except (urllib.error.URLError, TimeoutError, ValueError):
        raise ValueError('Artemis OAuth refresh failed; no token response was logged') from None
    if not isinstance(result, dict):
        raise ValueError('Artemis OAuth returned an invalid token response')
    if result.get('refresh_token') and result['refresh_token'] != refresh_token:
        raise ValueError('Cognito refresh-token rotation is active; this workflow cannot persist rotated tokens. Use a token broker or a dedicated non-rotating login before retrying')
    if str(result.get('token_type', '')).lower() != 'bearer':
        raise ValueError('Artemis OAuth did not return a bearer access token')
    return validate_access_token(result.get('access_token'))


def main():
    refresh = os.environ.get('ARTEMIS_DEV_REFRESH_TOKEN', '')
    token = os.environ.get('ARTEMIS_DEV_ACCESS_TOKEN', '')
    if refresh:
        token = refresh_access_token(refresh)
    elif token:
        token = validate_access_token(token)
    else:
        print('::warning::Artemis Dev is optional and unconfigured. Add ARTEMIS_DEV_REFRESH_TOKEN or a fresh ARTEMIS_DEV_ACCESS_TOKEN; this public client has no OAuth client secret.')
        token = ''
    if token:
        print('::add-mask::' + token)
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        output.write('access_token=' + token + '\n')
    print('Artemis Dev bearer token prepared' if token else 'Artemis Dev authentication unavailable')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError) as error:
        print('::error::' + str(error))
        sys.exit(1)
