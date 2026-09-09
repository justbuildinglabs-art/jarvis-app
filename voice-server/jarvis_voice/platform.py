"""Windows-only DLL path setup, which must run before faster-whisper imports.

ctranslate2 loads cuDNN and cuBLAS from the pip ``nvidia-*`` wheels, and on
Windows those directories are not on the DLL search path by default. The fix
has to happen at import time, before anything pulls in the model library.

``os.add_dll_directory`` exists only on Windows, so its absence is the
platform check: Mac and Linux fall through and do nothing.
"""

import glob
import os
import sys


def setup_dll_path() -> None:
    if not hasattr(os, "add_dll_directory"):
        return  # not Windows — CPU or CoreML handles itself
    for d in glob.glob(os.path.join(sys.prefix, "Lib", "site-packages", "nvidia", "*", "bin")):
        os.add_dll_directory(d)
        os.environ["PATH"] = d + os.pathsep + os.environ["PATH"]
