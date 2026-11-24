"""Load the installed app's wake policy and its adjacent calendar and price card."""
from pathlib import Path
import sys

__file__ = str(Path(__file__).resolve().parents[2] / "app/vendor/owner_wake_policy.py")
sys.path.insert(0, str(Path(__file__).parent))
exec(compile(Path(__file__).read_bytes(), __file__, "exec"))
