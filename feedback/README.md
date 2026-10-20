# Feedback track reports

Start with the prioritised [test matrix](./TEST_MATRIX.md). It contains untested hypotheses, not confirmed bugs. Do not create a report file until a finding reproduces and duplicate checks are complete.

Create one Markdown file per issue. Do not report an issue unless we can reproduce it with the named SDK version and a recorded environment.

Use this template:

```md
# Short title

Severity: normal
Area: SDK

## Steps to reproduce
1. ...

## Expected
...

## Actual
...

## Evidence
- Request/response or transaction hash:
- Timestamp UTC:
- Screenshot/log artifact:

## Environment
- SDK version:
- Network: Somnia Tokyo / Hideki testnet (chain ID 50383)
- Wallet address: public address only; never include a private key
- OS/runtime:
```

Do not publish security vulnerabilities here. Send them privately to security@dreamdex.io.
