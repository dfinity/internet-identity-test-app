# Internet Identity Test App

A relying-party canister used by the [Internet Identity](https://github.com/dfinity/internet-identity)
end-to-end tests. It contains additional functionality for manual testing and
debugging that is not required to integrate with Internet Identity — see
[`demos/using-dev-build`](https://github.com/dfinity/internet-identity/tree/main/demos/using-dev-build)
for a minimal example of how to authenticate with II.

Internet Identity does not build this app from source. Its CI downloads the
release assets of a pinned tag; see [Releases](#releases).

## Supported behavior

- Authenticate using a customizable instance of II
  - using `@icp-sdk/auth`
  - using a custom implementation which gives full control over the window post messages being sent
  - using the ICRC-167 URL transport (redirect) flow, via the `/callback` page
  - support for customizing
    - max time to live
    - derivation origin
  - After successful authentication the full delegation is displayed.
- Replay a signed attribute bundle against a canister (`caller_attributes`), so
  the e2e tests can verify an II authorize flow's attributes validate on the IC.
- Support for the asset `/.well-known/ii-alternative-origins` to test implementations of the `derivationOrigin` validation in II
  - The asset can be customized to be:
    - Valid as per [spec](https://github.com/dfinity/internet-identity/blob/main/docs/internet-identity-spec.adoc)
      - including the requested `derivationOrigin`
      - not including the requested `derivationOrigin`
    - Invalid
      - Wrong format
      - Missing certification
      - Respond with redirect
- Serves `/.well-known/ii-auth-callbacks`, the ICRC-167 auth-callback allow-list.
  It always covers this canister's own gateway origins; extra origins can be
  declared through the install argument (`auth_callbacks`), which is how the II
  e2e adds its `https://nice-name.com/callback` host.

## Layout

| Path           | What it is                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------ |
| `lib.rs`       | The canister: serves the certified frontend assets and the test-only update/query methods. |
| `src/`         | The frontend (React + Vite), including the Chrome extension bits in `src/public/`.         |
| `asset_util/`  | Asset certification helper. A copy of Internet Identity's crate of the same name.          |
| `build.sh`     | Builds the frontend into `dist/`, then compiles and post-processes `test_app.wasm`.        |
| `test_app.did` | The canister's Candid interface.                                                           |

`asset_util` is a copy rather than a dependency so this repository builds without
a path dependency on the Internet Identity tree. If II's copy gains a fix that
matters here, port it across.

## Building

Requirements: the Rust toolchain pinned in `rust-toolchain.toml` (rustup picks it
up automatically), the `wasm32-unknown-unknown` target,
[`ic-wasm`](https://github.com/dfinity/ic-wasm) 0.8.5, and the Node version in
`.node-version`.

```bash
npm ci
./build.sh
```

`build.sh` produces:

- `dist/` — the bundled frontend, which doubles as an unpacked Chrome extension.
- `test_app.wasm` — the canister, with `dist/` embedded and the Candid interface
  and supported certificate versions attached as metadata.

The canister embeds `dist/` at compile time, so `dist/` must exist before any
`cargo` command — including `cargo check` and `cargo clippy` — will succeed.

### Checks

```bash
npm run check          # tsc
npm run format-check   # prettier
cargo fmt --all --check
cargo clippy --all-targets -- -D clippy::all -D warnings -A clippy::manual_range_contains
cargo test
```

## Development

1. Install dependencies: `npm ci`
2. Start a local replica: `icp network start --clean`
3. Deploy the canister: `icp deploy`
4. Visit the running site at `http://localhost:4943?<canister_id>`, or run the
   Vite dev server with `npm run dev` (serves on http://localhost:8081 and
   proxies replica calls to the local network).

## Releases

Push a `release-X.Y.Z` tag and `.github/workflows/release.yml` publishes a GitHub
release with these assets:

| Asset                  | Contents                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `test_app.wasm`        | The canister module.                                                                          |
| `test_app.did`         | The Candid interface.                                                                         |
| `test_app_dist.tar.gz` | The built frontend — a `dist/` directory, loaded as an unpacked Chrome extension by II's e2e. |
| `SHA256SUMS`           | `sha256sum` output covering the three assets above.                                           |

```bash
git tag release-1.2.3
git push origin release-1.2.3
```

Internet Identity consumes releases through a pinned tag in
`.github/versions/test-app`, fetched by `scripts/fetch-test-app`. A scheduled
workflow in that repo opens a pull request whenever a newer tag is published
here, so shipping a change is: merge here, tag here, then merge the bump PR in
Internet Identity.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues are handled through the
process in [SECURITY.md](SECURITY.md) — please do not report them as public
issues.

## License

This project is licensed under the Internet Computer Community Source License
v1.0, the same license as [Internet Identity](https://github.com/dfinity/internet-identity).
See [LICENSE](LICENSE).
