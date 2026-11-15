# SPDX-License-Identifier: AGPL-3.0-or-later
"""Recover-mode and expected-negative exit statuses cannot hide diagnostics."""
import sys
import checked_subprocess as subprocess

for status in (0, 1):
    for text in (False, True):
        for marker in ('runtime error:', 'AddressSanitizer', 'UndefinedBehaviorSanitizer', 'ThreadSanitizer'):
            child = ['-c', f'import sys;sys.stderr.write({marker!r});sys.exit({status})']
            try:
                subprocess.run([sys.executable, *child], capture_output=True, text=text)
            except AssertionError as error:
                assert marker in str(error), error
            else:
                raise AssertionError((status, text, marker))
result = subprocess.run([sys.executable, '-c', 'import sys;sys.stderr.write("No cell found");sys.exit(1)'], capture_output=True, text=True)
assert result.returncode == 1 and result.stderr == 'No cell found'
print('Captured sanitizer reports fail with success and expected-negative exits')
