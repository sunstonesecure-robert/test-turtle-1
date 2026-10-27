import base64
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
import urllib.error
import urllib.parse

MODULE = Path(__file__).resolve().parents[2] / 'scripts/mcp/artemis-auth.py'
spec = importlib.util.spec_from_file_location('artemis_auth', MODULE)
auth = importlib.util.module_from_spec(spec)
spec.loader.exec_module(auth)


def token(**changes):
    claims = {'iss': auth.ISSUER, 'client_id': auth.CLIENT_ID, 'token_use': 'access', 'exp': time.time() + 3600}
    claims.update(changes)
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=')
    return 'header.' + payload + '.signature'


class Opener:
    def __init__(self, result):
        self.result = result
        self.request = None

    def open(self, request, timeout):
        self.request = request
        return io.StringIO(json.dumps(self.result))


class ArtemisAuthTest(unittest.TestCase):
    def test_access_token_checks(self):
        value = token()
        self.assertEqual(auth.validate_access_token(value), value)
        for value in [token(exp=0), token(iss='https://wrong.example'), token(client_id='wrong'),
                      token(token_use='id'), token() + '\nmalicious=output', 'Bearer ' + token(), 'bad']:
            with self.assertRaises(ValueError):
                auth.validate_access_token(value)

    def test_refresh_uses_fixed_endpoint_and_public_client(self):
        value = token()
        opener = Opener({'access_token': value, 'token_type': 'Bearer'})
        self.assertEqual(auth.refresh_access_token('refresh-fixture', opener), value)
        self.assertEqual(opener.request.full_url, auth.TOKEN_ENDPOINT)
        body = urllib.parse.parse_qs(opener.request.data.decode())
        self.assertEqual(body, {'grant_type': ['refresh_token'], 'client_id': [auth.CLIENT_ID],
                                'refresh_token': ['refresh-fixture']})
        self.assertNotIn('Authorization', opener.request.headers)

    def test_rotation_is_not_silently_discarded(self):
        opener = Opener({'access_token': token(), 'token_type': 'Bearer', 'refresh_token': 'new-secret'})
        with self.assertRaisesRegex(ValueError, 'rotation'):
            auth.refresh_access_token('old-secret', opener)

    def test_http_error_does_not_expose_response_or_token(self):
        opener = Opener({})
        with patch.object(opener, 'open', side_effect=urllib.error.HTTPError(auth.TOKEN_ENDPOINT, 400,
                          'sensitive-response', {}, io.BytesIO(b'secret-body'))):
            with self.assertRaises(ValueError) as raised:
                auth.refresh_access_token('refresh-secret', opener)
        self.assertNotIn('secret', str(raised.exception).lower())
        self.assertNotIn('sensitive-response', str(raised.exception))

    def test_no_redirect(self):
        with self.assertRaisesRegex(ValueError, 'not forwarded'):
            auth.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://other.example')

    def test_missing_credentials_is_optional(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'output'
            with patch.dict(os.environ, {'GITHUB_OUTPUT': str(output)}, clear=True), contextlib.redirect_stdout(io.StringIO()):
                auth.main()
            self.assertEqual(output.read_text(), 'access_token=\n')

    def test_access_token_is_masked_before_output(self):
        value = token()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'output'
            logs = io.StringIO()
            with patch.dict(os.environ, {'GITHUB_OUTPUT': str(output), 'ARTEMIS_DEV_ACCESS_TOKEN': value}, clear=True), contextlib.redirect_stdout(logs):
                auth.main()
            self.assertTrue(logs.getvalue().startswith('::add-mask::' + value))
            self.assertEqual(output.read_text(), 'access_token=' + value + '\n')


if __name__ == '__main__':
    unittest.main()
