# Contributing

Issues and pull requests are welcome. Describe the problem and intended change; for larger changes, discuss the approach first. Keep changes focused and add or update tests when behavior changes.

Use Node.js 26. Tests run serially to bound memory usage. Install dependencies and run the full test suite:

```sh
npm ci --include=dev
npm test
```

Do not commit credentials, real mail, or local secret files. See [SECURITY.md](SECURITY.md) for vulnerability reports and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for participation standards. Contributions are subject to the [MIT license](LICENSE).
