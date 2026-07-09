# Crucible execution-seam fixtures

These narrow fixtures pin the real `bin/crabrunner` submit, terminal status, and
collect shapes consumed by Symphony. They were captured from Crucible commit
`d56f99577bcd27101edf97e096afdd969b4826fe` on 2026-07-09 with a deterministic
`worker-argv.v1` job. PIDs and machine-specific paths were removed; contract
timestamps remain as captured strings.

This is the W1 execution-seam contract fixture set, not the golden corpus.
SYMPH-999 owns the first corpus slice and SYMPH-914 owns its Crucible-side
producer/conformance/report-only re-scope.
