import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import ssl
import socket
import unittest
from unittest.mock import patch
import urllib.parse
import urllib.error

spec = importlib.util.spec_from_file_location('artemis_login', Path(__file__).resolve().parents[2] / 'scripts/mcp/artemis-login.py')
login = importlib.util.module_from_spec(spec)
spec.loader.exec_module(login)


class LoginTest(unittest.TestCase):
    def test_pkce_rfc7636_vector_and_callback(self):
        url = login.authorization_url('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', 'random-state')
        params = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
        self.assertEqual(params['code_challenge'], ['E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'])
        self.assertEqual(params['code_challenge_method'], ['S256'])
        self.assertEqual(params['state'], ['random-state'])
        self.assertEqual(params['redirect_uri'], ['http://localhost:8765/callback'])
        self.assertNotIn('code_verifier', params)

    def test_exchange_binds_code_verifier_client_and_callback(self):
        class Opener:
            def open(self, request, timeout):
                self.request = request
                return io.StringIO(json.dumps({'access_token': 'fixture', 'token_type': 'Bearer'}))
        opener = Opener()
        with patch.object(login.auth, 'validate_access_token') as validate:
            login.exchange_code('code-fixture', 'verifier-fixture', opener)
        validate.assert_called_once_with('fixture')
        self.assertEqual(opener.request.full_url, login.auth.TOKEN_ENDPOINT)
        params = urllib.parse.parse_qs(opener.request.data.decode())
        self.assertEqual(params['code_verifier'], ['verifier-fixture'])
        self.assertEqual(params['client_id'], [login.auth.CLIENT_ID])
        self.assertEqual(params['redirect_uri'], [login.CALLBACK])
        self.assertNotIn('client_secret', params)

    def test_transport_diagnostics_hide_raw_error_text(self):
        cases = [
            (ssl.SSLCertVerificationError(1, 'secret-fixture'), 'TLS certificate verification'),
            (socket.gaierror(-2, 'secret-fixture'), 'DNS lookup'),
            (TimeoutError('secret-fixture'), 'timed out'),
            (ConnectionRefusedError('secret-fixture'), 'refused'),
        ]
        for reason, expected in cases:
            with self.subTest(expected=expected):
                with patch.object(login.urllib.request.OpenerDirector, 'open', side_effect=urllib.error.URLError(reason)):
                    with self.assertRaises(ValueError) as raised:
                        login.exchange_code('code-fixture', 'verifier-fixture')
                self.assertIn(expected, str(raised.exception))
                self.assertNotIn('secret-fixture', str(raised.exception))

    def test_oauth_error_exposes_only_allowlisted_code(self):
        error = urllib.error.HTTPError(login.auth.TOKEN_ENDPOINT, 400, 'secret-fixture', {},
            io.BytesIO(b'{"error":"invalid_grant","error_description":"secret-fixture"}'))
        with patch.object(login.urllib.request.OpenerDirector, 'open', side_effect=error):
            with self.assertRaises(login.OAuthExchangeError) as raised:
                login.exchange_code('code-fixture', 'verifier-fixture')
        self.assertEqual(raised.exception.oauth_error, 'invalid_grant')
        self.assertNotIn('secret-fixture', str(raised.exception))

    def test_non_json_response_is_diagnosed_without_body(self):
        with patch.object(login.urllib.request.OpenerDirector, 'open', return_value=io.StringIO('secret-fixture')):
            with self.assertRaisesRegex(ValueError, 'non-JSON') as raised:
                login.exchange_code('code-fixture', 'verifier-fixture')
        self.assertNotIn('secret-fixture', str(raised.exception))

    def test_connection_probe_accepts_only_expected_oauth_rejection(self):
        with patch.object(login, 'exchange_code', side_effect=login.OAuthExchangeError(400, 'invalid_grant')), contextlib.redirect_stdout(io.StringIO()):
            login.check_connection()
        with patch.object(login, 'exchange_code', side_effect=login.OAuthExchangeError(401, 'invalid_client')), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(login.OAuthExchangeError):
                login.check_connection()

    def test_secret_uses_stdin_not_arguments_or_logs(self):
        logs = io.StringIO()
        with patch.object(login.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)) as run, contextlib.redirect_stdout(logs):
            login.save_secret('ARTEMIS_DEV_ACCESS_TOKEN', 'secret-fixture')
        self.assertEqual(run.call_args.kwargs['input'], 'secret-fixture')
        self.assertNotIn('secret-fixture', ' '.join(run.call_args.args[0]))
        self.assertNotIn('secret-fixture', logs.getvalue())

    def test_upload_failure_hides_captured_output(self):
        with patch.object(login.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, 'secret-fixture', 'secret-fixture')):
            with self.assertRaises(ValueError) as raised:
                login.save_secret('ARTEMIS_DEV_ACCESS_TOKEN', 'secret-fixture')
        self.assertNotIn('secret-fixture', str(raised.exception))


if __name__ == '__main__':
    unittest.main()
