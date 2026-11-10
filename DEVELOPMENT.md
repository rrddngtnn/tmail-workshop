# Development

Use Node.js 26. Tests run serially to bound memory usage. Install dependencies and run the full test suite:

```sh
npm ci --include=dev
npm test
```

Do not commit credentials, real mail, or local secret files. See [SECURITY.md](SECURITY.md) for vulnerability reports. Contributions are subject to the [MIT license](LICENSE).
