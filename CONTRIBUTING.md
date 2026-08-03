# Contributing to the Internet Identity Test App

Thank you for your interest in contributing.

This app is a test fixture for [Internet Identity]: it is the relying party that
Internet Identity's end-to-end tests authenticate against. Changes here usually
accompany a change in Internet Identity itself, so the Identity team plans work
on both repositories together.

## Contributing code changes

If you want to contribute a feature or bug fix, please **reach out to us first**
so that we can discuss feasibility and implementation strategies. You can reach
out to us:

- on the [forum], or
- during our monthly [community calls].

Make sure to read the [LICENSE] first. Build, check and development instructions
are in [README.md](README.md).

Two things to keep in mind when proposing a change:

- Internet Identity's CI downloads the release assets of a pinned tag rather than
  building this app from source. The asset names are part of that contract — see
  the Releases section of the README.
- Behavior the end-to-end tests rely on (the alternative-origins asset, the
  auth-callback allow-list, the post-message flows) is exercised from Internet
  Identity's test suite, so a change here can break that suite.

## Bug reports

We really appreciate bug reports through [GitHub tickets].

[GitHub tickets]: https://github.com/dfinity/internet-identity-test-app/issues/new
[Internet Identity]: https://github.com/dfinity/internet-identity
[forum]: https://forum.dfinity.org/c/internet-identity/32
[community calls]: https://forum.dfinity.org/t/working-group-identity-authentication/11902
[LICENSE]: LICENSE
