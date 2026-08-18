# Normalization

This package is the only supported label-normalization entry point. It pins
`@adraffy/ens-normalize@1.11.1`, applies only leading/trailing whitespace trim,
accepts exactly one label and enforces the
bounded profile used by the permit issuer, SDK and indexer fixtures.

`changed: true` must be surfaced to the caller before a permit is requested;
raw input is never silently replaced and signed. The profile and corpus hashes
are release inputs. Changing the implementation, bounds or corpus requires a
new profile ID and a new on-chain release.
