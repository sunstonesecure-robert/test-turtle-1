#!/usr/bin/env python3
"""Interactive local PKCE login; save the chosen token directly to GitHub Secrets."""
import argparse
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import importlib.util
import json
from pathlib import Path
import secrets
import socket
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

spec = importlib.util.spec_from_file_location('artemis_auth', Path(__file__).with_name('artemis-auth.py'))
auth = importlib.util.module_from_spec(spec)
spec.loader.exec_module(auth)
REPOSITORY = 'sunstonesecure-robert/test-turtle-1'
CALLBACK = 'http://localhost:8765/callback'
AUTHORIZE = 'https://sunstone-dev.auth.us-east-1.amazoncognito.com/oauth2/authorize'


def authorization_url(verifier, state):
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
    return AUTHORIZE + '?' + urllib.parse.urlencode({
        'response_type': 'code', 'client_id': auth.CLIENT_ID,
        'redirect_uri': CALLBACK, 'scope': 'openid email profile',
        'state': state, 'code_challenge': challenge, 'code_challenge_method': 'S256',
    })


class OAuthExchangeError(ValueError):
    def __init__(self, status, oauth_error):
        self.status, self.oauth_error = status, oauth_error
        hints = {
            'invalid_grant': 'The code expired, was already used, or did not match the PKCE verifier/callback. Start a fresh sign-in.',
            'invalid_client': 'Check the public Cognito client configuration.',
            'unauthorized_client': 'Check that this client allows authorization-code sign-in.',
            'invalid_request': 'Cognito rejected the request parameters.',
        }
        hint = hints.get(oauth_error, 'Check Cognito availability and client configuration; then retry.')
        super().__init__(f'Token exchange failed (HTTP {status}, OAuth {oauth_error}). {hint}')


def transport_error(error):
    reason = error.reason if isinstance(error, urllib.error.URLError) else error
    if isinstance(reason, ssl.SSLCertVerificationError):
        version = f'{sys.version_info.major}.{sys.version_info.minor}'
        return ValueError('TLS certificate verification failed in Python. '
            f'For a python.org macOS installation, run /Applications/Python {version}/Install Certificates.command. '
            'For a managed proxy, use your organization-approved CA configuration. '
            'Do not disable certificate verification. Retry --check-connection afterward.')
    if isinstance(reason, ssl.SSLError):
        return ValueError('TLS handshake failed. Check your Python TLS installation and any VPN/proxy; retry --check-connection.')
    if isinstance(reason, socket.gaierror):
        return ValueError('DNS lookup failed for the Cognito token endpoint. Check your network/VPN/DNS; retry --check-connection.')
    if isinstance(reason, TimeoutError):
        return ValueError('Connection to the Cognito token endpoint timed out. Check your network/VPN/proxy; retry --check-connection.')
    if isinstance(reason, ConnectionRefusedError):
        return ValueError('Connection to Cognito or the configured proxy was refused. Check network/proxy settings; retry --check-connection.')
    return ValueError('Network connection to the Cognito token endpoint failed. '
        'Check Python network/proxy settings and retry --check-connection. No credentials or response bodies were logged.')


def exchange_code(code, verifier, opener=None):
    body = urllib.parse.urlencode({
        'grant_type': 'authorization_code', 'client_id': auth.CLIENT_ID,
        'redirect_uri': CALLBACK, 'code': code, 'code_verifier': verifier,
    }).encode()
    request = urllib.request.Request(auth.TOKEN_ENDPOINT, data=body,
        headers={'Content-Type': 'application/x-www-form-urlencoded'}, method='POST')
    opener = opener or urllib.request.build_opener(auth.NoRedirect())
    try:
        with opener.open(request, timeout=30) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        # Only expose known OAuth error codes, never descriptions or raw responses.
        oauth_error = 'unrecognized_error'
        try:
            payload = json.loads(error.read(4096))
            candidate = payload.get('error') if isinstance(payload, dict) else None
            if candidate in ('invalid_grant', 'invalid_client', 'invalid_request',
                             'unauthorized_client', 'unsupported_grant_type', 'invalid_scope', 'server_error'):
                oauth_error = candidate
        except (ValueError, OSError):
            pass
        raise OAuthExchangeError(error.code, oauth_error) from None
    except (urllib.error.URLError, TimeoutError, ssl.SSLError) as error:
        raise transport_error(error) from None
    except (json.JSONDecodeError, UnicodeError):
        raise ValueError('Cognito token endpoint returned a non-JSON response. Check your network/proxy; no response body was logged.') from None
    except ValueError:
        raise ValueError('Token endpoint redirect was refused or the request was invalid. Credentials were not forwarded to another endpoint.') from None
    if not isinstance(result, dict) or str(result.get('token_type', '')).lower() != 'bearer':
        raise ValueError('Cognito did not return a bearer token response')
    auth.validate_access_token(result.get('access_token'))
    return result


def check_connection():
    """Exercise the actual token endpoint with dummy values; no login or secrets."""
    print(f'Checking Cognito HTTPS using Python {sys.version.split()[0]} at {sys.executable}')
    try:
        exchange_code('connectivity-check-not-a-real-code', 'connectivity-check-not-a-real-verifier-1234567890')
    except OAuthExchangeError as error:
        if error.status == 400 and error.oauth_error == 'invalid_grant':
            print('Connection OK: Python verified TLS and Cognito rejected the dummy code as expected. No sign-in or GitHub secret changes were made.')
            return
        raise
    raise ValueError('Unexpected response to the dummy-code check; no GitHub secrets were changed')


def wait_for_code(state, url):
    result = {}

    class CallbackHandler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(5)

        def log_message(self, *args):
            pass  # The callback URL contains an authorization code: never log it.

        def do_GET(self):
            parsed = urllib.parse.urlsplit(self.path)
            query = urllib.parse.parse_qs(parsed.query)
            valid_state = query.get('state', []) == [state]
            if parsed.path != '/callback':
                status, message = 404, 'Not found.'
            elif not valid_state:
                status, message = 400, 'Invalid login state. Return to the original sign-in window.'
            elif 'error' in query:
                result['error'] = True
                status, message = 400, 'Sign-in was not completed. Return to your terminal.'
            elif len(query.get('code', [])) == 1 and query['code'][0]:
                result['code'] = query['code'][0]
                status, message = 200, 'Sign-in received. Return to your terminal to check whether the GitHub secret was saved.'
            else:
                status, message = 400, 'Missing authorization code.'
            self.send_response(status)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.end_headers()
            self.wfile.write(message.encode())

    try:
        server = HTTPServer(('127.0.0.1', 8765), CallbackHandler)
    except OSError:
        raise ValueError('Cannot listen on localhost:8765. Stop another login helper using that port and retry.') from None
    with server:
        server.timeout = 1
        print('Opening Artemis Dev sign-in. Complete it in your browser within five minutes.')
        if not webbrowser.open(url):
            print('Open this sign-in URL in a browser on this computer:\n' + url)
        deadline = time.monotonic() + 300
        while not result and time.monotonic() < deadline:
            server.handle_request()
    if 'code' not in result:
        raise ValueError('Sign-in was cancelled or timed out. Run the helper again.')
    return result['code']


def save_secret(name, value):
    result = subprocess.run(['gh', 'secret', 'set', name, '--repo', REPOSITORY],
                            input=value, text=True, capture_output=True)
    if result.returncode:
        raise ValueError('GitHub secret upload failed. Check gh authentication and repository Secrets write access, then sign in again.')
    print(f'Saved {name} in {REPOSITORY}. No token was printed or saved to a local file.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check-connection', action='store_true', help='Test Python TLS and Cognito connectivity without browser login or credentials')
    parser.add_argument('--refresh', action='store_true', help='Save a refresh token instead of the default access token')
    parser.add_argument('--rotation-disabled', action='store_true',
                        help='Confirm you checked that this Cognito app client has refresh-token rotation disabled')
    args = parser.parse_args()
    if args.check_connection:
        check_connection()
        return
    if args.refresh and not args.rotation_disabled:
        parser.error('--refresh requires --rotation-disabled after checking the Cognito client configuration')
    check = subprocess.run(['gh', 'secret', 'list', '--repo', REPOSITORY, '--json', 'name'],
                           capture_output=True, text=True)
    if check.returncode:
        raise ValueError('Run gh auth login and ensure you can manage Actions secrets in ' + REPOSITORY)
    existing = {item['name'] for item in json.loads(check.stdout)}
    if not args.refresh and 'ARTEMIS_DEV_REFRESH_TOKEN' in existing:
        raise ValueError('ARTEMIS_DEV_REFRESH_TOKEN already exists and takes precedence. Renew it with --refresh --rotation-disabled, or remove it intentionally before an access-token-only test.')
    verifier, state = secrets.token_urlsafe(64), secrets.token_urlsafe(32)
    code = wait_for_code(state, authorization_url(verifier, state))
    result = exchange_code(code, verifier)
    name = 'ARTEMIS_DEV_REFRESH_TOKEN' if args.refresh else 'ARTEMIS_DEV_ACCESS_TOKEN'
    value = result.get('refresh_token' if args.refresh else 'access_token')
    if not isinstance(value, str) or not value:
        raise ValueError('Cognito did not return the requested token; no GitHub secret was changed')
    save_secret(name, value)
    if not args.refresh:
        print('This is a short-lived access token. Run the workflow test now.')


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        sys.exit('Sign-in cancelled.')
    except (ValueError, OSError) as error:
        sys.exit(str(error))
