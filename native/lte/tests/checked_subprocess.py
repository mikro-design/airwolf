# SPDX-License-Identifier: AGPL-3.0-or-later
"""Keep captured native sanitizer diagnostics from becoming passing tests."""
import subprocess as _subprocess
import sys

def run(*args, **kwargs):
    try:
        result = _subprocess.run(*args, **kwargs)
    except _subprocess.CalledProcessError as error:
        if error.stderr:
            text = error.stderr.decode(errors='replace') if isinstance(error.stderr, bytes) else error.stderr
            print(text, file=sys.stderr)
        raise
    stderr = result.stderr or ''
    if isinstance(stderr, bytes):
        stderr = stderr.decode(errors='replace')
    # Decoder negatives may legitimately exit1; UBSan uses that exit code too.
    # Check the diagnostic even when the caller expects a nonzero result.
    markers = ('runtime error:', 'AddressSanitizer', 'UndefinedBehaviorSanitizer', 'ThreadSanitizer', 'LeakSanitizer')
    if any(marker in stderr for marker in markers):
        raise AssertionError(f'Native sanitizer diagnostic:\n{stderr}')
    return result
